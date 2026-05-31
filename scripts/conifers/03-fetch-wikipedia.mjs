// Wikipedia summaries for conifers via the REST API. Same pattern as the
// bird script.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/conifers/species.json";
const OUT_PATH = "data/conifers/wiki.json";
const CONCURRENCY = 4;
const PER_REQUEST_DELAY_MS = 100;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn(`Couldn't parse ${OUT_PATH}; starting fresh.`); }
}
console.log(`${species.length} species, ${Object.keys(existing).length} cached`);

async function fetchSummary(name) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.type === "disambiguation") return null;
      return {
        title: j.title || null,
        description: j.description || null,
        extract: j.extract || null,
        thumbnail: j.thumbnail?.source || null,
        page: j.content_urls?.desktop?.page || null,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      else throw err;
    }
  }
}

let nextIdx = 0, done = 0, found = 0, missing = 0, errors = 0, dirty = false;
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
      if (r) found++; else missing++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const eta = ((species.length - done) / rate / 60).toFixed(1);
      process.stdout.write(`  ${done}/${species.length} | ${found} found, ${missing} no article | ${rate.toFixed(1)}/s | ETA ${eta}min\n`);
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));
const withSummary = Object.values(existing).filter((v) => v).length;
console.log(`Done. ${withSummary}/${species.length} with summary`);
