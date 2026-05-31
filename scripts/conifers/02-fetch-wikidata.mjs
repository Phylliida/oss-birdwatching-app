// Single Wikidata SPARQL pass for conifers: image (P18), IUCN (P141),
// multilingual common names (rdfs:label across ~30 languages).
// Output: data/conifers/wikidata.json

import { readFile, writeFile } from "node:fs/promises";

const SPECIES_PATH = "data/conifers/species.json";
const OUT_PATH = "data/conifers/wikidata.json";
const SPARQL = "https://query.wikidata.org/sparql";
const BATCH = 60;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const LANGS = ["en", "es", "fr", "de", "ja", "zh", "pt", "it", "ru", "nl", "pl", "ko", "sv", "no", "da", "fi", "tr", "vi", "id", "hu", "cs", "ro", "uk"];

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
console.log(`Querying Wikidata for ${species.length} conifer species...`);

async function queryBatch(batch) {
  const values = batch.map((s) => `"${s.scientificName.replace(/"/g, '\\"')}"`).join(" ");
  const langFilter = LANGS.map((l) => `"${l}"`).join(",");
  // Plant-relevant adds:
  //   P574  = year of taxon name publication
  //   P5208 = life form (linked Q-item → fetch English label)
  //   P2052 = maximum age (quantity, often Wikidata's longevity record)
  const query = `
    SELECT ?name ?label ?iucnLabel ?image ?yearPub ?growthLabel ?maxAge WHERE {
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
      OPTIONAL { ?taxon wdt:P18 ?image . }
      OPTIONAL { ?taxon wdt:P574 ?yearPub . }
      OPTIONAL {
        ?taxon wdt:P5208 ?growth .
        ?growth rdfs:label ?growthLabel .
        FILTER(LANG(?growthLabel) = "en")
      }
      OPTIONAL { ?taxon wdt:P2052 ?maxAge . }
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
  try { bindings = await queryBatch(batch); }
  catch (err) {
    console.warn(`Batch ${i} retry: ${err.message}`);
    await new Promise((r) => setTimeout(r, 3000));
    bindings = await queryBatch(batch);
  }
  for (const b of bindings) {
    const name = b.name.value;
    if (!data[name]) data[name] = { names: {}, iucn: null, image: null, yearPub: null, growthForm: null, maxAgeYears: null };
    if (b.label) {
      const lang = b.label["xml:lang"];
      if (lang && !data[name].names[lang]) data[name].names[lang] = b.label.value;
    }
    if (b.iucnLabel && !data[name].iucn) data[name].iucn = b.iucnLabel.value;
    if (b.image && !data[name].image) data[name].image = b.image.value;
    if (b.yearPub && data[name].yearPub == null) {
      // P574 comes back as an ISO date like "1753-01-01T00:00:00Z"; pull the year.
      const m = b.yearPub.value.match(/^(-?\d+)/);
      if (m) data[name].yearPub = parseInt(m[1], 10);
    }
    if (b.growthLabel && !data[name].growthForm) data[name].growthForm = b.growthLabel.value;
    if (b.maxAge && data[name].maxAgeYears == null) {
      const n = parseFloat(b.maxAge.value);
      if (isFinite(n)) data[name].maxAgeYears = n;
    }
  }
  const done = Math.min(i + BATCH, species.length);
  const rate = done / ((Date.now() - start) / 1000);
  process.stdout.write(`  ${done}/${species.length} (${rate.toFixed(0)}/s)\r`);
}
process.stdout.write("\n");

await writeFile(OUT_PATH, JSON.stringify(data));
const withImg = Object.values(data).filter((v) => v.image).length;
const withIucn = Object.values(data).filter((v) => v.iucn).length;
const withNames = Object.values(data).filter((v) => Object.keys(v.names).length > 0).length;
const withYear = Object.values(data).filter((v) => v.yearPub).length;
const withGrowth = Object.values(data).filter((v) => v.growthForm).length;
const withAge = Object.values(data).filter((v) => v.maxAgeYears).length;
console.log(`Wrote ${OUT_PATH}`);
console.log(`  With image:           ${withImg}/${species.length} (${(withImg / species.length * 100).toFixed(1)}%)`);
console.log(`  With IUCN status:     ${withIucn}/${species.length} (${(withIucn / species.length * 100).toFixed(1)}%)`);
console.log(`  With multilingual:    ${withNames}/${species.length} (${(withNames / species.length * 100).toFixed(1)}%)`);
console.log(`  With year described:  ${withYear}/${species.length} (${(withYear / species.length * 100).toFixed(1)}%)`);
console.log(`  With growth form:     ${withGrowth}/${species.length} (${(withGrowth / species.length * 100).toFixed(1)}%)`);
console.log(`  With max age:         ${withAge}/${species.length} (${(withAge / species.length * 100).toFixed(1)}%)`);
