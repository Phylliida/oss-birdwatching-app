// Wikidata SPARQL pass: image (P18), IUCN (P141), multilingual labels.
// Usage:  TAXON=oaks node scripts/taxon/02-fetch-wikidata.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTaxon } from "../taxa.mjs";

const taxon = getTaxon(process.env.TAXON);
const SPECIES_PATH = `${taxon.dataDir}/species.json`;
const OUT_PATH = `${taxon.dataDir}/wikidata.json`;
const SPARQL = "https://query.wikidata.org/sparql";
const BATCH = 60;
const PER_BATCH_DELAY_MS = 500;
const MAX_RETRIES = 5;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const LANGS = ["en", "es", "fr", "de", "ja", "zh", "pt", "it", "ru", "nl", "pl", "ko", "sv", "no", "da", "fi", "tr", "vi", "id", "hu", "cs", "ro", "uk"];

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
console.log(`Querying Wikidata for ${species.length} ${taxon.commonName}...`);

async function queryBatch(batch) {
  const values = batch.map((s) => `"${s.scientificName.replace(/"/g, '\\"')}"`).join(" ");
  const langFilter = LANGS.map((l) => `"${l}"`).join(",");
  const query = `
    SELECT ?name ?label ?iucnLabel ?image WHERE {
      VALUES ?name { ${values} }
      ?taxon wdt:P225 ?name .
      OPTIONAL { ?taxon rdfs:label ?label . FILTER(LANG(?label) IN (${langFilter})) }
      OPTIONAL { ?taxon wdt:P141 ?iucn . ?iucn rdfs:label ?iucnLabel . FILTER(LANG(?iucnLabel) = "en") }
      OPTIONAL { ?taxon wdt:P18 ?image . }
    }
  `;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(SPARQL + "?query=" + encodeURIComponent(query), {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 502 || res.status === 503 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt))); // 2s, 4s, 8s, 16s, 32s
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
      return (await res.json()).results.bindings;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Resume from previously cached file so a mid-run crash doesn't waste work.
let data = {};
if (existsSync(OUT_PATH)) {
  try { data = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { /* start fresh */ }
}
const start = Date.now();
let dirty = false;
let failedBatches = 0;
for (let i = 0; i < species.length; i += BATCH) {
  const batch = species.slice(i, i + BATCH);
  // Skip whole batches whose species are all already cached (queried).
  if (batch.every((s) => s.scientificName in data)) continue;
  let bindings;
  try { bindings = await queryBatch(batch); }
  catch (err) {
    // A single flaky/truncated SPARQL response must not kill a 400K-species run.
    // Skip this batch (its species stay un-cached, so a later re-run retries them)
    // and keep going.
    failedBatches++;
    console.warn(`Batch ${i} failed (${err.message}); skipping, will retry on a later run. [${failedBatches} skipped]`);
    if (dirty) { await writeFile(OUT_PATH, JSON.stringify(data)); dirty = false; }
    await new Promise((r) => setTimeout(r, PER_BATCH_DELAY_MS));
    continue;
  }
  for (const b of bindings) {
    const name = b.name.value;
    if (!data[name]) data[name] = { names: {}, iucn: null, image: null };
    if (b.label) {
      const lang = b.label["xml:lang"];
      if (lang && !data[name].names[lang]) data[name].names[lang] = b.label.value;
    }
    if (b.iucnLabel && !data[name].iucn) data[name].iucn = b.iucnLabel.value;
    if (b.image && !data[name].image) data[name].image = b.image.value;
  }
  // Mark every queried species with no Wikidata item as null so resume can skip
  // this batch next time instead of re-issuing the (costly) SPARQL query.
  for (const s of batch) if (!(s.scientificName in data)) data[s.scientificName] = null;
  dirty = true;
  const done = Math.min(i + BATCH, species.length);
  if (done % 600 === 0) {
    await writeFile(OUT_PATH, JSON.stringify(data));
    dirty = false;
  }
  const rate = done / ((Date.now() - start) / 1000);
  process.stdout.write(`  ${done}/${species.length} (${rate.toFixed(0)}/s)\n`);
  await new Promise((r) => setTimeout(r, PER_BATCH_DELAY_MS));
}
process.stdout.write("\n");

await writeFile(OUT_PATH, JSON.stringify(data));
const vals = Object.values(data).filter(Boolean);
const withImg = vals.filter((v) => v.image).length;
const withIucn = vals.filter((v) => v.iucn).length;
const withNames = vals.filter((v) => Object.keys(v.names).length > 0).length;
console.log(`Wrote ${OUT_PATH}${failedBatches ? ` (${failedBatches} batches skipped — re-run to retry them)` : ""}`);
console.log(`  With image: ${withImg}/${species.length} (${(withImg / species.length * 100).toFixed(1)}%)`);
console.log(`  With IUCN:  ${withIucn}/${species.length} (${(withIucn / species.length * 100).toFixed(1)}%)`);
console.log(`  With names: ${withNames}/${species.length} (${(withNames / species.length * 100).toFixed(1)}%)`);
