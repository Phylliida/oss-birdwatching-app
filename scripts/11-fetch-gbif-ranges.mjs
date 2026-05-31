// Fetches per-species country occurrence data from GBIF for every IOC species.
// Two requests per species:
//   1. /v1/species/match    → resolve scientific name to a stable speciesKey
//   2. /v1/occurrence/search?taxonKey=K&facet=country → country counts
//
// We store only countries with >= MIN_OBSERVATIONS to filter out vagrants /
// escaped pets. ~22k requests total, parallelised to ~8 concurrent.
//
// Resumable: writes data/gbif-ranges.json every 100 species. Re-runs skip
// species already in the file.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const OUT_PATH = "data/gbif-ranges.json";
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;
const MIN_OBSERVATIONS = 10;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const existing = existsSync(OUT_PATH) ? JSON.parse(await readFile(OUT_PATH, "utf8")) : {};
console.log(`${species.length} species, ${Object.keys(existing).length} already cached`);

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        // Rate limited or server error — back off and retry.
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
  // Step 1: match → speciesKey. If GBIF can't resolve the name at species rank
  // (matchType !== EXACT/FUZZY at SPECIES), there's no point in querying.
  const m = await fetchJson(
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}&rank=SPECIES`,
  );
  if (!m.usageKey || m.rank !== "SPECIES") return { matched: false, countries: [] };

  // Step 2: facet on country. facetLimit=50 captures the long-ish tail; in
  // practice most species have <20 distinct countries above threshold.
  const o = await fetchJson(
    `https://api.gbif.org/v1/occurrence/search?taxonKey=${m.usageKey}&facet=country&facetLimit=50&limit=0`,
  );
  const counts = o.facets?.[0]?.counts || [];
  const countries = counts
    .filter((c) => c.count >= MIN_OBSERVATIONS && c.name !== "ZZ") // ZZ = "unknown/international waters"
    .map((c) => c.name);
  return { matched: true, speciesKey: m.usageKey, total: o.count || 0, countries };
}

// Tiny concurrency-limited runner — pulls from a shared index until done.
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
      if (r.matched && r.countries.length > 0) found++;
      else missing++;
    } catch (err) {
      errors++;
      // First few errors are useful to log; after that they're noise.
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    // Polite per-worker pacing so we don't hammer the API even with CONCURRENCY workers.
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
    done++;
    if (done % 100 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = species.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(
        `  ${done}/${species.length} | ${found} with range, ${missing} no data, ${errors} errors | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));

const withCountries = Object.values(existing).filter((e) => e?.countries?.length > 0).length;
console.log(`\nDone.`);
console.log(`  Total species:                ${species.length}`);
console.log(`  With country data:            ${withCountries}`);
console.log(`  Matched but no country data:  ${Object.values(existing).filter((e) => e?.matched && !e.countries.length).length}`);
console.log(`  Not in GBIF backbone:         ${Object.values(existing).filter((e) => e && !e.matched).length}`);
console.log(`  Errors (will retry next run): ${errors}`);
