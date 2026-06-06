// Aggregate the bulk Plantae occurrence download (gbif-range-download.mjs) into
// the same per-species range facets the faceted API crawl produced — offline, in
// one streaming pass over ~610M records instead of weeks of rate-limited calls.
//
// SIMPLE_CSV is tab-delimited with a header row. We tally, per species
// (speciesKey ∈ our backbone), counts of countryCode / stateProvince / month /
// year / establishmentMeans, and write data/plantae/gbif.json keyed by
// scientificName as { total, facets:{ country,stateProvince,month,year,
// establishmentMeans } } — exactly what build-plantae-tree.mjs's distillGbif reads.
//
// Usage:  node --max-old-space-size=32768 scripts/parse-gbif-range.mjs  (needs `unzip`)

import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";

const ZIP = "data/plantae/gbif-occurrences.zip";
const OUT = "data/plantae/gbif.json";
const STATE_CAP = 30, YEAR_CAP = 30; // match distillGbif's trims; keep files lean

if (!existsSync(ZIP)) { console.error(`${ZIP} not found — run scripts/gbif-range-download.mjs first.`); process.exit(1); }

// our backbone: speciesKey -> scientificName
const species = JSON.parse(await readFile("data/plantae/species.json", "utf8"));
const keyToName = new Map();
for (const s of species) keyToName.set(String(s.gbifKey), s.scientificName);
console.log(`${keyToName.size.toLocaleString()} plant species indexed by gbifKey`);

// find the .csv member inside the zip
const member = execSync(`unzip -Z1 ${ZIP}`, { encoding: "utf8" }).split("\n").find((f) => f.endsWith(".csv"));
if (!member) { console.error("No .csv member in the zip."); process.exit(1); }
console.log(`Streaming ${member} ...`);

// per speciesKey: { total, country:{}, state:{}, month:{}, year:{}, em:{} }
const agg = new Map();
const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };

const proc = spawn("unzip", ["-p", ZIP, member]);
const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
let ix = null, rows = 0, kept = 0;
await new Promise((resolve, reject) => {
  proc.on("error", reject);
  rl.on("line", (line) => {
    const c = line.split("\t");
    if (!ix) { ix = {}; c.forEach((h, i) => (ix[h] = i)); return; }
    if (++rows % 50_000_000 === 0) console.log(`  ${(rows / 1e6).toFixed(0)}M rows | ${kept.toLocaleString()} kept | ${agg.size.toLocaleString()} species`);
    if (ix.occurrenceStatus != null && c[ix.occurrenceStatus] === "ABSENT") return;
    const sk = c[ix.speciesKey];
    if (!sk || !keyToName.has(sk)) return;
    let a = agg.get(sk);
    if (!a) { a = { total: 0, country: {}, state: {}, month: {}, year: {}, em: {} }; agg.set(sk, a); }
    a.total++;
    bump(a.country, c[ix.countryCode]);
    bump(a.state, c[ix.stateProvince]);
    bump(a.month, c[ix.month]);
    bump(a.year, c[ix.year]);
    bump(a.em, c[ix.establishmentMeans]);
    kept++;
  });
  rl.on("close", resolve);
  proc.stderr.on("data", () => {});
});
console.log(`Read ${rows.toLocaleString()} rows, kept ${kept.toLocaleString()}, ${agg.size.toLocaleString()} species with occurrences`);

// emit in distillGbif's shape: facet = [{name,count}] sorted by count desc
const facet = (o, cap) => {
  const arr = Object.entries(o).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return cap ? arr.slice(0, cap) : arr;
};
const out = {};
for (const [sk, a] of agg) {
  out[keyToName.get(sk)] = {
    total: a.total,
    facets: {
      country: facet(a.country),
      stateProvince: facet(a.state, STATE_CAP),
      month: facet(a.month),
      year: facet(a.year, YEAR_CAP),
      establishmentMeans: facet(a.em),
    },
  };
}
await writeFile(`${OUT}.new`, JSON.stringify(out));
await rename(`${OUT}.new`, OUT); // atomic swap so a reader never sees a partial file
console.log(`Wrote ${OUT} — ${Object.keys(out).length.toLocaleString()} species with range data (was ~150K from the crawl).`);
