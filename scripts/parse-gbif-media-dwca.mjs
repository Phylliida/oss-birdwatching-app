// Parse the GBIF Darwin Core Archive fetched by gbif-media-download.mjs and fill
// photo gaps for the microscopic animal phyla from museum / specialist
// collections. Offline join — no per-species API calls.
//
// The archive has two tab-delimited members with header rows:
//   occurrence.txt : gbifID -> speciesKey (+ scientificName, license, …)
//   multimedia.txt : gbifID -> identifier (image URL), license, creator, …
// We map gbifID -> our species (by speciesKey == our stored gbifKey), then
// attach each CC still image to that species. Output:
//   data/animalia/gbif-media.json -> { "<name>": { photos:[{url,license,attribution}] } }
// build-animalia-tree.mjs uses it as a photo source below Commons + iNat.
//
// Usage: node scripts/parse-gbif-media-dwca.mjs   (needs `unzip` on PATH)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ZIP = "data/animalia/gbif-media-dwca.zip";
const OUT = "data/animalia/gbif-media.json";
const MAX_PHOTOS = 4;

if (!existsSync(ZIP)) { console.error(`${ZIP} not found — run scripts/gbif-media-download.mjs first.`); process.exit(1); }

function normLicense(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.includes("publicdomain/zero") || s === "cc0_1_0") return "cc0";
  if (s.includes("/by-nc-sa/") || s === "cc_by_nc_sa_4_0") return "cc-by-nc-sa";
  if (s.includes("/by-sa/") || s === "cc_by_sa_4_0") return "cc-by-sa";
  if (s.includes("/by-nc/") || s === "cc_by_nc_4_0") return "cc-by-nc";
  if (s.includes("/by/") || s === "cc_by_4_0") return "cc-by";
  return null;
}
const LIC_LABEL = { "cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA", "cc-by-nc": "CC BY-NC", "cc-by-nc-sa": "CC BY-NC-SA" };

// Stream a member of the zip line-by-line; calls onRow(cols, colIndex) per row.
function streamMember(member, onRow) {
  return new Promise((resolve, reject) => {
    const p = spawn("unzip", ["-p", ZIP, member]);
    p.on("error", reject);
    const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
    let header = null, idx = null;
    rl.on("line", (line) => {
      const cols = line.split("\t");
      if (!header) { header = cols; idx = {}; header.forEach((h, i) => (idx[h] = i)); return; }
      onRow(cols, idx);
    });
    rl.on("close", () => resolve());
    p.stderr.on("data", () => {});
  });
}

// our species: gbifKey -> scientificName
const species = JSON.parse(await readFile("data/animalia/species.json", "utf8"));
const keyToName = new Map();
for (const s of species) keyToName.set(String(s.gbifKey), s.scientificName);
console.log(`${keyToName.size.toLocaleString()} species indexed by gbifKey`);

// Pass 1: occurrence.txt -> gbifID -> { our species name, occurrence licence }.
// We keep the occurrence licence because multimedia.txt often leaves the per-row
// licence blank — but the download predicate guarantees the occurrence is CC, so
// the image inherits it (GBIF's model: media without an explicit licence take
// the record's).
const gbifIdInfo = new Map();
let occRows = 0;
await streamMember("occurrence.txt", (c, ix) => {
  occRows++;
  const id = c[ix.gbifID];
  const sk = c[ix.speciesKey];
  const name = sk && keyToName.get(sk);
  if (id && name) gbifIdInfo.set(id, { name, lic: normLicense(c[ix.license]) });
});
console.log(`occurrence.txt: ${occRows.toLocaleString()} rows, ${gbifIdInfo.size.toLocaleString()} matched to our species`);

// Pass 2: multimedia.txt -> attach images
const out = {};
let mmRows = 0, attached = 0;
await streamMember("multimedia.txt", (c, ix) => {
  mmRows++;
  if (ix.type != null && c[ix.type] && c[ix.type] !== "StillImage") return;
  const id = c[ix.gbifID];
  const info = gbifIdInfo.get(id);
  if (!info) return;
  const url = c[ix.identifier];
  if (!url) return;
  const code = normLicense(c[ix.license]) || info.lic;
  if (!code) return;
  const name = info.name;
  const rec = out[name] || (out[name] = { photos: [] });
  if (rec.photos.length >= MAX_PHOTOS || rec.photos.some((p) => p.url === url)) return;
  const who = (ix.creator != null && c[ix.creator]) || (ix.rightsHolder != null && c[ix.rightsHolder]) || (ix.publisher != null && c[ix.publisher]) || "an unnamed contributor";
  rec.photos.push({ url, license: code, attribution: `(c) ${who}, ${LIC_LABEL[code]}` });
  attached++;
});

await writeFile(OUT, JSON.stringify(out));
const withPhotos = Object.keys(out).length;
console.log(`multimedia.txt: ${mmRows.toLocaleString()} rows, ${attached.toLocaleString()} images attached`);
console.log(`Wrote ${OUT} — ${withPhotos.toLocaleString()} micro-phyla species gained a museum/specialist photo`);
