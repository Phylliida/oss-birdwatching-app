// Fetches additional photos per species from iNaturalist's /v1/taxa/{id}
// endpoint (taxon_photos is only populated on the by-id endpoint, not on
// the search results).
//
// For species we already have a taxonId cached (from inat-photos.json):
//   1 request: /v1/taxa/{id}
// For new species:
//   2 requests: /v1/taxa?q=name → id, then /v1/taxa/{id}
//
// Output: data/inat-extras.json keyed by scientific name:
//   { photos: [{ url, attribution, license }, ...up to TOP_N] } or null

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const INAT_PHOTOS = "data/inat-photos.json";
const OUT_PATH = "data/inat-extras.json";
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 1200;
const MAX_RETRIES = 4;
const TOP_N = 3;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const inatGapFill = existsSync(INAT_PHOTOS) ? JSON.parse(await readFile(INAT_PHOTOS, "utf8")) : {};

let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn(`Couldn't parse ${OUT_PATH}; starting fresh.`); }
}
console.log(`${species.length} species; ${Object.keys(existing).length} already cached`);

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
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

async function lookup(name) {
  // Get taxonId — prefer the cached one from inat-photos.json, otherwise search.
  let taxonId = inatGapFill[name]?.taxonId;
  if (!taxonId) {
    const q = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&rank=species&per_page=1`;
    const j = await fetchJson(q);
    const t = j?.results?.[0];
    if (!t || t.name !== name) return null;
    taxonId = t.id;
    // Polite gap before the second request.
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
  // Now fetch full taxon with photos.
  const j = await fetchJson(`https://api.inaturalist.org/v1/taxa/${taxonId}`);
  const t = j?.results?.[0];
  if (!t) return null;
  const photos = (t.taxon_photos || [])
    .map((p) => p.photo)
    .filter((p) => p && (p.medium_url || p.url))
    .slice(0, TOP_N)
    .map((p) => ({
      url: p.medium_url || p.url,
      attribution: p.attribution || null,
      license: p.license_code || null,
    }));
  return { taxonId, photos };
}

let nextIdx = 0;
let done = 0, found = 0, missing = 0, errors = 0;
let dirty = false;
const start = Date.now();

async function worker() {
  while (nextIdx < species.length) {
    const i = nextIdx++;
    const name = species[i].scientificName;
    if (name in existing) { done++; continue; }
    try {
      const r = await lookup(name);
      existing[name] = r;
      dirty = true;
      if (r?.photos?.length) found++;
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
        `  ${done}/${species.length} | ${found} with photos, ${missing} none, ${errors} errors | ${rate.toFixed(2)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));
const withPhotos = Object.values(existing).filter((v) => v?.photos?.length).length;
console.log(`\nDone. ${withPhotos}/${species.length} species have ≥1 extra photo`);
