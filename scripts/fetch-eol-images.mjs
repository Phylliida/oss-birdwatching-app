// Targeted EOL image gap-fill: for photoless species in a chosen phylum, pull
// CC-licensed images from EOL's API. EOL aggregates specialist/museum providers
// (e.g. malacology collections for molluscs) that iNat/Commons/GBIF don't have —
// a ~13% yield probe on photoless Mollusca came back 100% genuinely new.
//
// Scoped on purpose: EOL's API is per-species, so this only makes sense aimed at
// one under-covered group at a time, not a 2M crawl. We reuse the TraitBank
// pages.csv (name → EOL page_id) so it's ONE pages call per species (no search).
//
// Output: <TAXON_DIR>/eol-media.json -> { "<name>": { photos:[{url,license,attribution}] } | null }
// build-*-tree uses it as a photo source below Commons + iNat + GBIF.
//
// Usage:  PHYLUM=Mollusca TAXON_DIR=data/animalia node scripts/fetch-eol-images.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadWikidata } from "./wikidata-store.mjs";

const TAXON_DIR = process.env.TAXON_DIR || "data/animalia";
const PHYLUM = process.env.PHYLUM || "Mollusca";
const ZIP = "data/eol/traits_all.zip";
const OUT = `${TAXON_DIR}/eol-media.json`;
const UA = "oss-birdwatching-app/0.0 (offline non-commercial; github.com/Phylliida)";
const CONCURRENCY = 4, DELAY_MS = 120, MAX_PHOTOS = 4;

function normLicense(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.includes("publicdomain") || s.includes("cc0")) return "cc0";
  if (s.includes("/by-nc-sa/")) return "cc-by-nc-sa";
  if (s.includes("/by-sa/")) return "cc-by-sa";
  if (s.includes("/by-nc/")) return "cc-by-nc";
  if (s.includes("/by/")) return "cc-by";
  return null; // reject ND / ARR
}
const LIC_LABEL = { "cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA", "cc-by-nc": "CC BY-NC", "cc-by-nc-sa": "CC BY-NC-SA" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// photoless target species in the phylum
const sp = JSON.parse(await readFile(`${TAXON_DIR}/species.json`, "utf8"));
const inat = existsSync(`${TAXON_DIR}/inat.json`) ? JSON.parse(await readFile(`${TAXON_DIR}/inat.json`, "utf8")) : {};
const wd = await loadWikidata(TAXON_DIR);
const photoless = (n) => !(inat[n] && inat[n].photos && inat[n].photos.length) && !(wd[n] && wd[n].image);
const targetNames = new Set(sp.filter((s) => s.phylum === PHYLUM && photoless(s.scientificName)).map((s) => s.scientificName));
console.log(`${targetNames.size.toLocaleString()} photoless ${PHYLUM} species`);

// name -> EOL page_id from the TraitBank pages.csv (canonical column)
const pageId = new Map();
await new Promise((resolve, reject) => {
  const p = spawn("unzip", ["-p", ZIP, "trait_bank/pages.csv"]);
  p.on("error", reject);
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  let h = true;
  rl.on("line", (l) => {
    if (h) { h = false; return; }
    const i = l.lastIndexOf(","); const canon = l.slice(i + 1); // canonical is last column
    if (canon && targetNames.has(canon)) pageId.set(canon, l.slice(0, l.indexOf(",")));
  });
  rl.on("close", resolve);
  p.stderr.on("data", () => {});
});
console.log(`${pageId.size.toLocaleString()} matched to an EOL page`);

let out = {};
if (existsSync(OUT)) { try { out = JSON.parse(await readFile(OUT, "utf8")); } catch { /* fresh */ } }
const todo = [...pageId].filter(([name]) => !(name in out));
console.log(`${todo.length.toLocaleString()} to query (${Object.keys(out).length.toLocaleString()} cached)`);

let idx = 0, done = 0, withImg = 0;
async function worker() {
  while (idx < todo.length) {
    const [name, id] = todo[idx++];
    let result = null;
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(`https://eol.org/api/pages/1.0/${id}.json?images_per_page=${MAX_PHOTOS}&texts_per_page=0&videos_per_page=0&details=true`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
        if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** a); continue; }
        if (!res.ok) break;
        const objs = ((await res.json()).taxonConcept || {}).dataObjects || [];
        const photos = [];
        for (const o of objs) {
          if (!/^image\//.test(o.mimeType || "")) continue;
          const code = normLicense(o.license);
          if (!code) continue;
          const url = o.eolMediaURL || o.mediaURL;
          if (!url) continue;
          const who = (o.agents || []).map((x) => x.full_name).filter(Boolean)[0] || o.rightsHolder || "an unnamed contributor";
          photos.push({ url, license: code, attribution: `(c) ${who}, ${LIC_LABEL[code]}` });
          if (photos.length >= MAX_PHOTOS) break;
        }
        result = photos.length ? { photos } : null;
        break;
      } catch { if (a === 2) result = null; else await sleep(1000 * 2 ** a); }
    }
    out[name] = result;
    if (result) withImg++;
    if (++done % 500 === 0) { await writeFile(OUT, JSON.stringify(out)); console.log(`  ${done}/${todo.length} | ${withImg} with image (${(withImg / done * 100).toFixed(0)}%)`); }
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT, JSON.stringify(out));
const total = Object.values(out).filter((v) => v && v.photos && v.photos.length).length;
console.log(`Done. ${total.toLocaleString()} ${PHYLUM} species now have an EOL image.`);
