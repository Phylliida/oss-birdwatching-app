// Pulls elevation observation distribution per species from GBIF. The facet
// returns top distinct elevation values weighted by observation count; we
// compute weighted percentiles (5th / 50th / 95th) so we can summarize as
// "typical elevation: X m" plus an approximate range.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const GBIF_PATH = "data/gbif-full.json";
const OUT_PATH = "data/gbif-elevation.json";
const CONCURRENCY = 2;
const PER_REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const FACET_LIMIT = 200;

const gbif = JSON.parse(await readFile(GBIF_PATH, "utf8"));
const matchedSpecies = Object.entries(gbif)
  .filter(([_, v]) => v?.matched && v.speciesKey)
  .map(([name, v]) => ({ name, key: v.speciesKey }));

let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn(`Couldn't parse ${OUT_PATH}; starting fresh.`); }
}
console.log(`Matched species: ${matchedSpecies.length}, cached: ${Object.keys(existing).length}`);

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Given facet counts like [{name: "0.0", count: 559}, ...], compute weighted
// percentile by treating each (value, count) pair as `count` copies of `value`.
function weightedPercentile(counts, p) {
  // Sort by elevation value (ascending).
  const sorted = [...counts]
    .map((c) => ({ v: parseFloat(c.name), w: c.count }))
    .filter((x) => isFinite(x.v))
    .sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  if (total === 0) return null;
  const target = total * p;
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= target) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

let nextIdx = 0, done = 0, found = 0, missing = 0, errors = 0;
const start = Date.now();
let dirty = false;

async function worker() {
  while (nextIdx < matchedSpecies.length) {
    const i = nextIdx++;
    const sp = matchedSpecies[i];
    if (sp.name in existing) { done++; continue; }
    const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${sp.key}&facet=elevation&elevation.facetLimit=${FACET_LIMIT}&limit=0`;
    try {
      const json = await fetchJson(url);
      const counts = json.facets?.[0]?.counts || [];
      if (counts.length === 0) {
        existing[sp.name] = null;
        missing++;
      } else {
        existing[sp.name] = {
          p5: weightedPercentile(counts, 0.05),
          median: weightedPercentile(counts, 0.5),
          p95: weightedPercentile(counts, 0.95),
          sampleSize: counts.reduce((s, c) => s + c.count, 0),
          distinctValues: counts.length,
        };
        found++;
      }
      dirty = true;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${sp.name}: ${err.message}`);
    }
    done++;
    if (done % 200 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = matchedSpecies.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(`  ${done}/${matchedSpecies.length} | ${found} elev, ${missing} none, ${errors} errors | ${rate.toFixed(1)}/s | ETA ${eta}min\n`);
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));
console.log(`\nDone.`);
console.log(`  With elevation data: ${found}`);
console.log(`  No elevation data:   ${missing}`);
console.log(`  Errors:              ${errors}`);
