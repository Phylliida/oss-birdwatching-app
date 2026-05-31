// Surveys Wikidata for the structured attributes we'd need to build an ID
// filter UI: length, mass, range-map image, endemic-to. Writes raw values to
// data/wikidata-attributes.json and prints coverage stats so we can decide
// which attributes are usable and which need a different data source.
//
// Property reference:
//   P2043 = length        P2067 = mass        P181  = taxon range map image
//   P183  = endemic to    P189  = location of discovery

import { readFile, writeFile } from "node:fs/promises";

const SPECIES_PATH = "data/ioc-species.json";
const OUT_PATH = "data/wikidata-attributes.json";
const SPARQL = "https://query.wikidata.org/sparql";
const BATCH = 150;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
console.log(`Checking attribute coverage for ${species.length} species...`);

async function queryBatch(batch) {
  const values = batch.map((s) => `"${s.scientificName.replace(/"/g, '\\"')}"`).join(" ");
  const query = `
    SELECT ?name ?length ?mass ?rangeMap ?endemic WHERE {
      VALUES ?name { ${values} }
      ?taxon wdt:P225 ?name .
      OPTIONAL { ?taxon wdt:P2043 ?length . }
      OPTIONAL { ?taxon wdt:P2067 ?mass . }
      OPTIONAL { ?taxon wdt:P181  ?rangeMap . }
      OPTIONAL { ?taxon wdt:P183  ?endemic . }
    }
  `;
  const res = await fetch(SPARQL + "?query=" + encodeURIComponent(query), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).results.bindings;
}

const data = {};
const start = Date.now();
for (let i = 0; i < species.length; i += BATCH) {
  const batch = species.slice(i, i + BATCH);
  let bindings;
  try {
    bindings = await queryBatch(batch);
  } catch (err) {
    console.warn(`Batch ${i} failed: ${err.message}. Retrying...`);
    await new Promise((r) => setTimeout(r, 3000));
    bindings = await queryBatch(batch);
  }
  for (const b of bindings) {
    const name = b.name.value;
    const rec = (data[name] ||= {});
    // Wikidata can return multiple values per species (e.g. different ranges
    // for subspecies). We keep the first non-null we see per attribute, then
    // collect all distinct values into arrays for range-likes.
    if (b.length && rec.length == null) rec.length = parseFloat(b.length.value);
    if (b.mass && rec.mass == null) rec.mass = parseFloat(b.mass.value);
    if (b.rangeMap && !rec.rangeMap) rec.rangeMap = b.rangeMap.value;
    if (b.endemic) {
      rec.endemic ||= [];
      if (!rec.endemic.includes(b.endemic.value)) rec.endemic.push(b.endemic.value);
    }
  }
  const done = Math.min(i + BATCH, species.length);
  const rate = done / ((Date.now() - start) / 1000);
  process.stdout.write(`  ${done}/${species.length} (${rate.toFixed(1)}/s)\r`);
}
process.stdout.write("\n");

const counts = { length: 0, mass: 0, rangeMap: 0, endemic: 0, any: 0 };
for (const rec of Object.values(data)) {
  let any = false;
  for (const k of ["length", "mass", "rangeMap", "endemic"]) {
    if (rec[k] != null) { counts[k]++; any = true; }
  }
  if (any) counts.any++;
}

await writeFile(OUT_PATH, JSON.stringify(data, null, 2));

const pct = (n) => ((n / species.length) * 100).toFixed(1) + "%";
console.log(`\nCoverage:`);
console.log(`  Length (P2043):           ${counts.length}  (${pct(counts.length)})`);
console.log(`  Mass (P2067):             ${counts.mass}  (${pct(counts.mass)})`);
console.log(`  Range-map image (P181):   ${counts.rangeMap}  (${pct(counts.rangeMap)})`);
console.log(`  Endemic-to (P183):        ${counts.endemic}  (${pct(counts.endemic)})`);
console.log(`  Any attribute:            ${counts.any}  (${pct(counts.any)})`);
console.log(`\nWrote ${OUT_PATH}`);
