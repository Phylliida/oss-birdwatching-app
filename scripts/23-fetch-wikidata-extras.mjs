// Single Wikidata SPARQL pass to grab three useful pieces of metadata per
// species:
//   * Multilingual common names (rdfs:label, ~30 widely-spoken languages)
//   * IUCN Red List status (P141 → label of the conservation status item)
//   * Wingspan (P2050, in metres)
// Output: data/wikidata-extras.json keyed by IOC scientific name.

import { readFile, writeFile } from "node:fs/promises";

const SPECIES_PATH = "data/ioc-species.json";
const OUT_PATH = "data/wikidata-extras.json";
const SPARQL = "https://query.wikidata.org/sparql";
const BATCH = 60;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const LANGS = [
  "en", "es", "fr", "de", "ja", "zh", "pt", "it", "ru", "nl",
  "pl", "ko", "ar", "hi", "sv", "no", "da", "fi", "tr", "vi",
  "id", "ms", "th", "he", "el", "hu", "cs", "ro", "uk", "hr",
];
const langFilter = LANGS.map((l) => `"${l}"`).join(",");

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
console.log(`Querying Wikidata extras for ${species.length} species...`);

async function queryBatch(batch) {
  const values = batch.map((s) => `"${s.scientificName.replace(/"/g, '\\"')}"`).join(" ");
  // Each OPTIONAL block is independent so we get the cross-product of labels
  // with any single IUCN value and any single wingspan value. We dedupe and
  // pick the first non-null per attribute in JS below.
  const query = `
    SELECT ?name ?label ?iucnLabel ?wingspan WHERE {
      VALUES ?name { ${values} }
      ?taxon wdt:P225 ?name .
      OPTIONAL {
        ?taxon rdfs:label ?label .
        FILTER(LANG(?label) IN (${langFilter}))
      }
      OPTIONAL {
        ?taxon wdt:P141 ?iucn .
        ?iucn rdfs:label ?iucnLabel .
        FILTER(LANG(?iucnLabel) = "en")
      }
      OPTIONAL { ?taxon wdt:P2050 ?wingspan . }
    }
  `;
  const res = await fetch(SPARQL + "?query=" + encodeURIComponent(query), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
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
    console.warn(`Batch ${i} failed (${err.message}); retrying after 3s...`);
    await new Promise((r) => setTimeout(r, 3000));
    bindings = await queryBatch(batch);
  }
  for (const b of bindings) {
    const name = b.name.value;
    if (!data[name]) data[name] = { names: {}, iucn: null, wingspan: null };
    if (b.label) {
      const lang = b.label["xml:lang"];
      if (lang && !data[name].names[lang]) data[name].names[lang] = b.label.value;
    }
    if (b.iucnLabel && !data[name].iucn) data[name].iucn = b.iucnLabel.value;
    if (b.wingspan && data[name].wingspan == null) data[name].wingspan = parseFloat(b.wingspan.value);
  }
  const done = Math.min(i + BATCH, species.length);
  const rate = done / ((Date.now() - start) / 1000);
  process.stdout.write(`  ${done}/${species.length} (${rate.toFixed(0)}/s)\r`);
}
process.stdout.write("\n");

await writeFile(OUT_PATH, JSON.stringify(data));

const total = species.length;
const withNames = Object.values(data).filter((v) => Object.keys(v.names).length > 0).length;
const langHisto = {};
for (const v of Object.values(data)) {
  for (const l of Object.keys(v.names)) langHisto[l] = (langHisto[l] || 0) + 1;
}
const withIucn = Object.values(data).filter((v) => v.iucn).length;
const withWingspan = Object.values(data).filter((v) => v.wingspan).length;

console.log(`Wrote ${OUT_PATH}`);
console.log(`  With multilingual names: ${withNames}/${total} (${(withNames / total * 100).toFixed(1)}%)`);
console.log(`  With IUCN status:        ${withIucn}/${total} (${(withIucn / total * 100).toFixed(1)}%)`);
console.log(`  With wingspan:           ${withWingspan}/${total} (${(withWingspan / total * 100).toFixed(1)}%)`);
console.log(`  Top 10 languages:        ${Object.entries(langHisto).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l, n]) => `${l}:${n}`).join(", ")}`);
