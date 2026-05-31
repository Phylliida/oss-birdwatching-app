// Fetches labeled photos per species from iNaturalist using observation
// annotations: Sex (male/female) × Life Stage (adult/juvenile). We grab the
// best-voted research-grade observation matching each combo we want.
//
// Output: data/inat-labeled.json keyed by IOC scientific name:
//   { taxonId, photos: { "adult-male": {...}, "adult-female": {...},
//                        "juvenile": {...}, "adult": {...} } }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const PRIOR_EXTRAS = "data/inat-extras.json";
const PRIOR_PHOTOS = "data/inat-photos.json";
const OUT_PATH = "data/inat-labeled.json";
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 900;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

// iNat annotation term/value IDs (Aves):
//   Term 1 = Life Stage: 2 Adult, 8 Juvenile, 7 Egg
//   Term 9 = Sex:        10 Female, 11 Male, 20 Cannot Be Determined
const LIFE_ADULT = { term: 1, val: 2 };
const LIFE_JUV = { term: 1, val: 8 };
const SEX_MALE = { term: 9, val: 11 };
const SEX_FEMALE = { term: 9, val: 10 };

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const priorExtras = existsSync(PRIOR_EXTRAS) ? JSON.parse(await readFile(PRIOR_EXTRAS, "utf8")) : {};
const priorPhotos = existsSync(PRIOR_PHOTOS) ? JSON.parse(await readFile(PRIOR_PHOTOS, "utf8")) : {};

let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn(`Couldn't parse ${OUT_PATH}; starting fresh.`); }
}
console.log(`${species.length} species, ${Object.keys(existing).length} cached, ${Object.values(priorExtras).filter(v=>v?.taxonId).length + Object.values(priorPhotos).filter(v=>v?.taxonId).length} taxon IDs in prior caches`);

function knownTaxonId(name) {
  return priorExtras[name]?.taxonId || priorPhotos[name]?.taxonId || existing[name]?.taxonId || null;
}

function acceptableLicense(code) {
  // We're non-commercial so any CC license is fine. null/"" means all-rights-
  // reserved which we have to skip.
  return !!(code && code.toLowerCase().startsWith("cc"));
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
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

function has(obs, ann) {
  return (obs.annotations || []).some((a) =>
    a.controlled_attribute_id === ann.term && a.controlled_value_id === ann.val,
  );
}

function photoFor(obs) {
  const p = obs.photos?.[0];
  if (!p) return null;
  if (!acceptableLicense(p.license_code)) return null;
  return {
    url: (p.medium_url || p.url || "").replace(/^http:\/\//, "https://"),
    attribution: p.attribution || null,
    license: p.license_code || null,
  };
}

async function lookup(name) {
  let taxonId = knownTaxonId(name);
  if (!taxonId) {
    const m = await fetchJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&rank=species&per_page=1`);
    const t = m.results?.[0];
    if (!t || t.name !== name) return { taxonId: null, photos: {} };
    taxonId = t.id;
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
  // One observation request returns 30 best-voted research-grade obs with
  // annotations + photos — enough to find labeled examples for common combos.
  const url = `https://api.inaturalist.org/v1/observations?taxon_id=${taxonId}&photos=true&per_page=30&quality_grade=research&order_by=votes&order=desc`;
  const data = await fetchJson(url);
  const photos = {};
  for (const o of data.results || []) {
    const ph = photoFor(o);
    if (!ph) continue;
    const isAdult = has(o, LIFE_ADULT);
    const isJuv = has(o, LIFE_JUV);
    const isMale = has(o, SEX_MALE);
    const isFemale = has(o, SEX_FEMALE);
    // Pick the first photo we see for each labeled slot. Order matters: a
    // single observation may match multiple buckets, prefer specific over
    // general so adult-male takes precedence over adult.
    if (isAdult && isMale && !photos["adult-male"]) photos["adult-male"] = ph;
    else if (isAdult && isFemale && !photos["adult-female"]) photos["adult-female"] = ph;
    else if (isJuv && !photos.juvenile) photos.juvenile = ph;
    else if (isAdult && !isMale && !isFemale && !photos.adult) photos.adult = ph;
  }
  return { taxonId, photos };
}

let done = 0, found = 0, errors = 0;
let dirty = false;
const start = Date.now();
for (const sp of species) {
  const name = sp.scientificName;
  if (name in existing) { done++; continue; }
  try {
    const r = await lookup(name);
    existing[name] = r;
    dirty = true;
    if (Object.keys(r.photos || {}).length > 0) found++;
  } catch (err) {
    errors++;
    if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
  }
  done++;
  if (done % 100 === 0) {
    if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
    const rate = done / ((Date.now() - start) / 1000);
    const eta = ((species.length - done) / rate / 60).toFixed(1);
    process.stdout.write(`  ${done}/${species.length} | ${found} labeled | ${errors} errors | ${rate.toFixed(2)}/s | ETA ${eta}min\n`);
  }
  await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
}

await writeFile(OUT_PATH, JSON.stringify(existing));
const histo = {};
for (const v of Object.values(existing)) {
  for (const k of Object.keys(v?.photos || {})) histo[k] = (histo[k] || 0) + 1;
}
console.log(`\nDone.`);
console.log(`  Species with ≥1 labeled photo: ${found}`);
console.log(`  Histogram: ${Object.entries(histo).map(([k,v])=>`${k}:${v}`).join(", ")}`);
