// For every IOC species, asks Wikidata which ones have a Commons image (P18).
// Writes data/coverage-report.json and prints a summary.
//
// Uses VALUES batches of ~150 to stay under the Wikidata SPARQL 60s timeout.

import { readFile, writeFile } from "node:fs/promises";

const SPECIES_PATH = "data/ioc-species.json";
const REPORT_PATH = "data/coverage-report.json";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const BATCH_SIZE = 150;
const USER_AGENT =
  "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
console.log(`Checking image coverage for ${species.length} species...`);

const results = new Map();

async function queryBatch(batch) {
  // P225 = taxon name; P18 = image. We OPTIONAL the image so species without
  // one still appear in the result set — that's how we distinguish "missing
  // from Wikidata" from "in Wikidata but no image".
  const values = batch.map((s) => `"${s.scientificName.replace(/"/g, '\\"')}"`).join(" ");
  const query = `
    SELECT ?name ?image WHERE {
      VALUES ?name { ${values} }
      ?taxon wdt:P225 ?name .
      OPTIONAL { ?taxon wdt:P18 ?image . }
    }
  `;
  const res = await fetch(`${SPARQL_URL}?query=${encodeURIComponent(query)}`, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results.bindings;
}

const startedAt = Date.now();
for (let i = 0; i < species.length; i += BATCH_SIZE) {
  const batch = species.slice(i, i + BATCH_SIZE);
  let bindings;
  try {
    bindings = await queryBatch(batch);
  } catch (err) {
    console.warn(`Batch ${i}-${i + batch.length} failed: ${err.message}. Retrying once...`);
    await new Promise((r) => setTimeout(r, 3000));
    bindings = await queryBatch(batch);
  }
  for (const b of bindings) {
    const name = b.name.value;
    const image = b.image?.value ?? null;
    // A species can map to multiple Wikidata items; keep the first image we see.
    if (!results.has(name) || (image && !results.get(name))) {
      results.set(name, image);
    }
  }
  const done = Math.min(i + BATCH_SIZE, species.length);
  const rate = done / ((Date.now() - startedAt) / 1000);
  process.stdout.write(`  ${done}/${species.length} (${rate.toFixed(1)}/s)\r`);
}
process.stdout.write("\n");

let inWikidata = 0;
let withImage = 0;
const enriched = species.map((s) => {
  const hit = results.has(s.scientificName);
  const image = results.get(s.scientificName) ?? null;
  if (hit) inWikidata++;
  if (image) withImage++;
  return { ...s, wikidata: hit, commonsImage: image };
});

const report = {
  totalSpecies: species.length,
  inWikidata,
  withImage,
  withoutImage: species.length - withImage,
  pctInWikidata: +((inWikidata / species.length) * 100).toFixed(1),
  pctWithImage: +((withImage / species.length) * 100).toFixed(1),
  generatedAt: new Date().toISOString(),
  species: enriched,
};

await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`\nResults:`);
console.log(`  Total species:      ${report.totalSpecies}`);
console.log(`  In Wikidata:        ${report.inWikidata} (${report.pctInWikidata}%)`);
console.log(`  With Commons image: ${report.withImage} (${report.pctWithImage}%)`);
console.log(`  No image found:     ${report.withoutImage}`);
console.log(`\nWrote ${REPORT_PATH}`);
