// Extract each species' year of description from the GBIF backbone bulk dump.
//
// Grab the dump first (≈488 MB, openly downloadable, CC-BY):
//   curl -L https://hosted-datasets.gbif.org/datasets/backbone/current/simple.txt.gz \
//     -o data/gbif-backbone/simple.txt.gz
//
// The dump is tab-delimited, one row per backbone name usage. Relevant columns
// (0-indexed): [0]=taxonKey [4]=status [10]=kingdomKey [19]=canonicalName
// [23]=authorship [24]=year [27]=namePublishedIn.
//   - Animals (birds): the year sits in [24] (e.g. "Linnaeus, 1758" -> 1758).
//   - Plants: botanical authors carry no year, so we read it from the
//     publication citation [27] (e.g. "Sp. Pl.: 996 (1753)" -> 1753).
//
// Join: plants by gbifKey (we store it); birds by canonicalName, filtered to
// kingdom Animalia (col 10 == 1) so homonyms like Oenanthe resolve correctly.
//
// Output: data/described-years.json  { "<Genus species>": { year, author } }

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";

const DUMP = "data/gbif-backbone/simple.txt.gz";

const plants = JSON.parse(await readFile("data/plantae/species.json", "utf8"));
const plantKeyToName = new Map();
for (const s of plants) plantKeyToName.set(s.gbifKey, s.scientificName);

// Birds: join by gbifKey too — the range fetch matched each IOC name to a GBIF
// speciesKey (data/gbif-full.json), which avoids IOC<->GBIF name mismatches.
const gbifFull = JSON.parse(await readFile("data/gbif-full.json", "utf8"));
const birdKeyToName = new Map();
for (const [name, v] of Object.entries(gbifFull)) if (v && v.speciesKey) birdKeyToName.set(v.speciesKey, name);

console.log(`Joining ${plantKeyToName.size.toLocaleString()} plants + ${birdKeyToName.size.toLocaleString()} birds (both by key)`);

// Prefer the basionym year (original description, e.g. recombinations carry it
// in cols 26/27), then the current-combination year, then the publication string.
function yearFrom(basYear, year, pubCol) {
  for (const y of [basYear, year]) if (y && /^\d{4}$/.test(y)) return +y;
  if (pubCol && pubCol !== "\\N") {
    const paren = pubCol.match(/\((1[5-9]\d\d|20[0-2]\d)\)/);      // prefer a parenthesised year
    if (paren) return +paren[1];
    const all = pubCol.match(/\b(1[5-9]\d\d|20[0-2]\d)\b/g);        // else the last plausible year
    if (all) return +all[all.length - 1];
  }
  return null;
}

const out = {};
let lines = 0, plantHits = 0, birdHits = 0;
const rl = createInterface({ input: createReadStream(DUMP).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  if (lines % 1000000 === 0) process.stdout.write(`  ${(lines / 1e6).toFixed(0)}M rows | ${plantHits + birdHits} hits\n`);
  const c = line.split("\t");
  const key = Number(c[0]);
  // cols: [24]=author [25]=year [26]=basionymAuthor [27]=basionymYear [28]=namePublishedIn
  const clean = (v) => (v && v !== "\\N" ? v : null);
  const author = clean(c[26]) || clean(c[24]); // original (basionym) describer if present
  if (plantKeyToName.has(key)) {
    const name = plantKeyToName.get(key);
    if (!out[name]) { const y = yearFrom(c[27], c[25], c[28]); if (y) { out[name] = { year: y, author }; plantHits++; } }
  } else if (birdKeyToName.has(key)) {
    const name = birdKeyToName.get(key);
    if (!out[name]) { const y = yearFrom(c[27], c[25], c[28]); if (y) { out[name] = { year: y, author }; birdHits++; } }
  }
}

for (const k in out) if (out[k]) delete out[k]._accepted;
await writeFile("data/described-years.json", JSON.stringify(out));
console.log(`\nWrote data/described-years.json — ${Object.keys(out).length.toLocaleString()} species with a year`);
console.log(`  plants: ${plantHits.toLocaleString()} / ${plantKeyToName.size.toLocaleString()} (${(plantHits / plantKeyToName.size * 100).toFixed(1)}%)`);
console.log(`  birds:  ${birdHits.toLocaleString()} / ${birdKeyToName.size.toLocaleString()} (${(birdHits / birdKeyToName.size * 100).toFixed(1)}%)`);
for (const t of ["Corvus corax", "Quercus robur", "Bellis perennis", "Sequoiadendron giganteum", "Setophaga ruticilla"]) {
  console.log(`  ${t}: ${JSON.stringify(out[t] || "—")}`);
}
