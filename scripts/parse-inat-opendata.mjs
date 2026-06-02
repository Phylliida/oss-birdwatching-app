// Build plant photo sets from the iNaturalist Open Data bulk dump (CC-licensed),
// instead of the slow per-species API crawl.
//
// Grab the dump first (~30 GB, openly downloadable):
//   for f in taxa observers observations photos; do
//     curl -L https://inaturalist-open-data.s3.amazonaws.com/$f.csv.gz \
//       -o data/inat-opendata/$f.csv.gz ; done
//
// The dump has no curated "taxon photos", only observation photos, so we pick
// good ones: research-grade observations (verified ID) + the observer's primary
// photo (position 0) + a CC licence we accept. Tab-delimited, header row each.
//   taxa:         taxon_id ancestry rank_level rank name active
//   observations: observation_uuid observer_id lat lng acc taxon_id quality_grade observed_on anomaly
//   photos:       photo_uuid photo_id observation_uuid observer_id extension license width height position
//   observers:    observer_id login name
//
// Output merges into data/plantae/inat.json, keeping any existing (curated,
// API-sourced) photos where we already have them.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DIR = "data/inat-opendata";
const OUT = "data/plantae/inat.json";
const OK = new Set(["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"]); // reject ND + ARR
const LIC = { "cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA", "cc-by-nc": "CC BY-NC", "cc-by-nc-sa": "CC BY-NC-SA" };
const MAX_OBS = 15, MAX_PHOTOS = 5;

async function* rows(file) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${file}`).pipe(createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) { if (header) { header = false; continue; } yield line.split("\t"); }
}

const species = JSON.parse(await readFile("data/plantae/species.json", "utf8"));
const ourNames = new Set(species.map((s) => s.scientificName));
console.log(`${ourNames.size.toLocaleString()} plant names`);

// taxa: name -> taxon_id (prefer active), taxon_id -> name
const nameToId = new Map(), idToName = new Map();
for await (const c of rows("taxa.csv.gz")) {
  if (c[3] !== "species" || !ourNames.has(c[4])) continue;
  if (!nameToId.has(c[4]) || c[5] === "true") { nameToId.set(c[4], c[0]); idToName.set(c[0], c[4]); }
}
const ourIds = new Set(idToName.keys());
console.log(`matched ${ourIds.size.toLocaleString()} iNat taxa`);

// observations: research-grade, our taxa -> obs_uuid -> taxon_id (capped per taxon)
const obsToTaxon = new Map(), obsCount = new Map();
let n = 0;
for await (const c of rows("observations.csv.gz")) {
  if (++n % 40000000 === 0) console.log(`  observations ${(n / 1e6).toFixed(0)}M`);
  if (c[6] !== "research") continue;
  const tid = c[5];
  if (!ourIds.has(tid) || (obsCount.get(tid) || 0) >= MAX_OBS) continue;
  obsToTaxon.set(c[0], tid);
  obsCount.set(tid, (obsCount.get(tid) || 0) + 1);
}
console.log(`collected ${obsToTaxon.size.toLocaleString()} observations`);

// observers: id -> display name
const observer = new Map();
for await (const c of rows("observers.csv.gz")) observer.set(c[0], c[2] || c[1]);

// photos: primary (position 0), our obs, acceptable licence
const photos = new Map();
n = 0;
for await (const c of rows("photos.csv.gz")) {
  if (++n % 60000000 === 0) console.log(`  photos ${(n / 1e6).toFixed(0)}M`);
  if (c[8] !== "0") continue;
  const tid = obsToTaxon.get(c[2]);
  if (!tid) continue;
  const lic = (c[5] || "").toLowerCase();
  if (!OK.has(lic)) continue;
  const list = photos.get(tid) || [];
  if (list.length >= MAX_PHOTOS) continue;
  list.push({
    url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${c[1]}/medium.${c[4]}`,
    attribution: `(c) ${observer.get(c[3]) || "an iNaturalist user"}, ${LIC[lic] || lic}`,
    license: lic,
  });
  photos.set(tid, list);
}
console.log(`${photos.size.toLocaleString()} taxa with photos`);

// merge into existing inat.json (keep curated/API photos where present)
let merged = {};
if (existsSync(OUT)) { try { merged = JSON.parse(await readFile(OUT, "utf8")); } catch { /* fresh */ } }
let added = 0, filled = 0;
for (const [tid, list] of photos) {
  const name = idToName.get(tid);
  const ex = merged[name];
  if (ex && ex.photos && ex.photos.length) continue; // already have (better) photos
  merged[name] = { taxonId: Number(tid), photos: list };
  ex ? filled++ : added++;
}
await writeFile(OUT, JSON.stringify(merged));
const withPhotos = Object.values(merged).filter((v) => v && v.photos && v.photos.length).length;
console.log(`Wrote ${OUT} — ${Object.keys(merged).length.toLocaleString()} taxa, ${withPhotos.toLocaleString()} with photos (+${added} new, ${filled} filled)`);
