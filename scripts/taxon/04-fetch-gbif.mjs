// GBIF country/state observation facets.
// Usage:  TAXON=oaks node scripts/taxon/04-fetch-gbif.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTaxon } from "../taxa.mjs";

const taxon = getTaxon(process.env.TAXON);
const SPECIES_PATH = `${taxon.dataDir}/species.json`;
const OUT_PATH = `${taxon.dataDir}/gbif.json`;
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 400;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const FACETS = [
  { name: "country", limit: 250 },
  { name: "stateProvince", limit: 200 },
  { name: "continent", limit: 10 },
  { name: "month", limit: 12 },
  { name: "year", limit: 50 },
  { name: "establishmentMeans", limit: 20 },
];

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn("Couldn't parse cache."); }
}
console.log(`${species.length} species, ${Object.keys(existing).length} cached`);

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt))); lastErr = new Error(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) { lastErr = err; if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt))); }
  }
  throw lastErr;
}

async function fetchOne(speciesKey) {
  const facetParams = FACETS.map((f) => `facet=${f.name}&${f.name}.facetLimit=${f.limit}`).join("&");
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${speciesKey}&${facetParams}&limit=0`;
  const j = await fetchJson(url);
  const facets = {};
  const camel = (s) => s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  for (const f of j.facets || []) facets[camel(f.field)] = f.counts;
  return { total: j.count || 0, facets };
}

let nextIdx = 0, done = 0, found = 0, errors = 0, dirty = false;
const start = Date.now();
async function worker() {
  while (nextIdx < species.length) {
    const i = nextIdx++;
    const sp = species[i];
    if (sp.scientificName in existing) { done++; continue; }
    try { const r = await fetchOne(sp.gbifKey); existing[sp.scientificName] = r; dirty = true; if (r.total > 0) found++; }
    catch (err) { errors++; if (errors <= 5) console.warn(`  Error: ${err.message}`); }
    done++;
    if (done % 100 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      process.stdout.write(`  ${done}/${species.length} | ${found} with data | ${rate.toFixed(1)}/s | ETA ${((species.length - done) / rate / 60).toFixed(1)}min\n`);
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));
console.log(`Done. ${found} with data, ${errors} errors`);
