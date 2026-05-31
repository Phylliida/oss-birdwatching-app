// Fetches Wikipedia article summaries for every IOC species via the REST API
// /page/summary/{title} endpoint. Wikipedia auto-redirects scientific name
// titles to the canonical common-name article, so we can use IOC names
// directly without a separate name-resolution step.
//
// Output: data/wiki-summaries.json keyed by IOC scientific name with
//   { title, description, extract, thumbnail, page } or null if 404.
//
// Wikipedia REST API allows up to 200 req/sec; we use a much gentler rate.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const OUT_PATH = "data/wiki-summaries.json";
const CONCURRENCY = 4;
const PER_REQUEST_DELAY_MS = 100;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
// Handle corrupted/truncated caches gracefully (e.g., from a previous
// disk-full crash). Better to refetch a few thousand entries than to crash
// on startup.
let existing = {};
if (existsSync(OUT_PATH)) {
  try {
    existing = JSON.parse(await readFile(OUT_PATH, "utf8"));
  } catch (err) {
    console.warn(`Couldn't parse ${OUT_PATH} (${err.message}); starting from empty cache.`);
  }
}
console.log(`${species.length} species, ${Object.keys(existing).length} already cached`);

async function fetchSummary(name) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // Some pages are disambiguations — those have type "disambiguation"
      // and no useful extract. Treat them as a miss so we don't show noise.
      if (j.type === "disambiguation") return null;
      return {
        title: j.title || null,
        description: j.description || null,
        extract: j.extract || null,
        thumbnail: j.thumbnail?.source || null,
        page: j.content_urls?.desktop?.page || null,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      } else {
        throw err;
      }
    }
  }
}

let nextIdx = 0;
let done = 0;
let found = 0;
let missing = 0;
let errors = 0;
let dirty = false;
const start = Date.now();

async function worker() {
  while (nextIdx < species.length) {
    const i = nextIdx++;
    const name = species[i].scientificName;
    if (name in existing) { done++; continue; }
    try {
      const r = await fetchSummary(name);
      existing[name] = r;
      dirty = true;
      if (r) found++;
      else missing++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    done++;
    if (done % 200 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = species.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(
        `  ${done}/${species.length} | ${found} with summary, ${missing} no article, ${errors} errors | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));

const withSummary = Object.values(existing).filter((v) => v).length;
console.log(`\nDone.`);
console.log(`  Total species:   ${species.length}`);
console.log(`  With summary:    ${withSummary} (${((withSummary / species.length) * 100).toFixed(1)}%)`);
console.log(`  No article:      ${species.length - withSummary - errors}`);
console.log(`  Errors:          ${errors}`);
