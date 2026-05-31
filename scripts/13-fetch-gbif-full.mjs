// Refetches GBIF data, this time storing the full facet counts so we don't
// have to come back later for state/province, year, month, etc.
//
// Reuses speciesKey from data/gbif-ranges.json (the prior run) so most species
// can skip the /species/match step — ~half the requests of round 1.
// Species not in GBIF (matched=false in round 1) are skipped entirely.
//
// Output: data/gbif-full.json keyed by IOC scientific name:
//   { matched, speciesKey, total, facets: { country: [{name,count}], ... } }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const PRIOR_PATH = "data/gbif-ranges.json";
const OUT_PATH = "data/gbif-full.json";
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 5;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

// Facets we ask GBIF for in a single occurrence/search call. facetLimit caps
// each — stateProvince is the most diverse and needs the highest limit.
// Names beyond facetLimit aren't returned, so generous defaults are cheap.
const FACETS = [
  { name: "country", limit: 250 },
  { name: "stateProvince", limit: 500 },
  { name: "continent", limit: 10 },
  { name: "year", limit: 200 },
  { name: "month", limit: 12 },
  { name: "basisOfRecord", limit: 20 },
  { name: "establishmentMeans", limit: 20 },
];

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const prior = existsSync(PRIOR_PATH) ? JSON.parse(await readFile(PRIOR_PATH, "utf8")) : {};
const existing = existsSync(OUT_PATH) ? JSON.parse(await readFile(OUT_PATH, "utf8")) : {};
console.log(`${species.length} species, ${Object.keys(prior).length} known from prior run, ${Object.keys(existing).length} already in new output`);

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

async function rangeFor(name) {
  // Use saved speciesKey when we have it; otherwise fall back to a match step.
  let speciesKey = prior[name]?.speciesKey;
  if (!speciesKey) {
    // If prior says matched=false, that's a confirmed not-in-GBIF — skip.
    if (prior[name] && prior[name].matched === false) {
      return { matched: false, facets: {} };
    }
    const m = await fetchJson(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}&rank=SPECIES`);
    if (!m.usageKey || m.rank !== "SPECIES") return { matched: false, facets: {} };
    speciesKey = m.usageKey;
  }

  const facetParams = FACETS.map((f) => `facet=${f.name}&${f.name}.facetLimit=${f.limit}`).join("&");
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${speciesKey}&${facetParams}&limit=0`;
  const o = await fetchJson(url);

  // GBIF returns facet field names like "STATE_PROVINCE"; normalize to the
  // camelCase form we asked for so downstream code can use one consistent set.
  const camel = (s) => s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const facets = {};
  for (const f of o.facets || []) facets[camel(f.field)] = f.counts;

  return { matched: true, speciesKey, total: o.count || 0, facets };
}

let nextIdx = 0;
let done = 0;
let found = 0;
let missing = 0;
let errors = 0;
const start = Date.now();
let dirty = false;

async function worker() {
  while (nextIdx < species.length) {
    const i = nextIdx++;
    const sp = species[i];
    const name = sp.scientificName;
    if (name in existing) { done++; continue; }
    try {
      const r = await rangeFor(name);
      existing[name] = r;
      dirty = true;
      if (r.matched && Object.keys(r.facets).length > 0) found++;
      else missing++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = species.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(
        `  ${done}/${species.length} | ${found} with data, ${missing} no data, ${errors} errors | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));

const withFacets = Object.values(existing).filter((e) => e?.facets && Object.keys(e.facets).length > 0).length;
console.log(`\nDone.`);
console.log(`  Total species:        ${species.length}`);
console.log(`  With facet data:      ${withFacets}`);
console.log(`  Not in GBIF:          ${Object.values(existing).filter((e) => e && !e.matched).length}`);
console.log(`  Errors (will retry):  ${errors}`);
const sz = (await import("node:fs/promises")).stat(OUT_PATH);
sz.then((s) => console.log(`  Output size:          ${(s.size / 1e6).toFixed(1)} MB`));
