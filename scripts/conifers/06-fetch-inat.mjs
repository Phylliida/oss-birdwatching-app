// iNat photos for conifers. We don't bother with sex × life-stage labeled
// photos (those annotations don't apply to plants), just grab the top few
// CC-licensed photos per species. Captures taxonId for the iNat link.
//
// Output: data/conifers/inat.json keyed by scientific name with
//   { taxonId, photos: [{ url, attribution, license }, ...] }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/conifers/species.json";
const OUT_PATH = "data/conifers/inat.json";
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 900;
const MAX_RETRIES = 4;
const TOP_N = 3;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const OK_LICENSES = new Set(["cc0", "pd", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"]);
const ok = (lic) => !!(lic && OK_LICENSES.has(String(lic).toLowerCase()));

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn("Couldn't parse existing cache; starting fresh."); }
}
console.log(`${species.length} species, ${Object.keys(existing).length} cached`);

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
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
  // Step 1: search by exact name → taxonId
  const m = await fetchJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&rank=species&per_page=1`);
  const t = m.results?.[0];
  if (!t || t.name !== name) return { taxonId: null, photos: [] };
  await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  // Step 2: fetch full taxon (has taxon_photos)
  const j = await fetchJson(`https://api.inaturalist.org/v1/taxa/${t.id}`);
  const tt = j.results?.[0];
  if (!tt) return { taxonId: t.id, photos: [] };
  const photos = (tt.taxon_photos || [])
    .map((p) => p.photo)
    .filter((p) => p && (p.medium_url || p.url) && ok(p.license_code))
    .slice(0, TOP_N)
    .map((p) => ({
      url: (p.medium_url || p.url).replace(/^http:\/\//, "https://"),
      attribution: p.attribution || null,
      license: p.license_code || null,
    }));
  return { taxonId: t.id, photos };
}

let done = 0, found = 0, errors = 0, dirty = false;
const start = Date.now();
for (const sp of species) {
  if (sp.scientificName in existing) { done++; continue; }
  try {
    const r = await lookup(sp.scientificName);
    existing[sp.scientificName] = r;
    dirty = true;
    if (r.photos.length) found++;
  } catch (err) {
    errors++;
    if (errors <= 5) console.warn(`  Error for ${sp.scientificName}: ${err.message}`);
  }
  done++;
  if (done % 50 === 0) {
    if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
    const rate = done / ((Date.now() - start) / 1000);
    process.stdout.write(`  ${done}/${species.length} | ${found} with photos | ${rate.toFixed(2)}/s | ETA ${((species.length - done) / rate / 60).toFixed(1)}min\n`);
  }
  await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
}
await writeFile(OUT_PATH, JSON.stringify(existing));
console.log(`Done. ${found}/${species.length} with photos, ${errors} errors`);
