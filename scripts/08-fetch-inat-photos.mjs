// Fills in photos for species that Wikidata didn't have a Commons image for,
// by querying iNaturalist's API one species at a time. iNat asks for ≤100 req/
// min, so we throttle to ~1 req/sec. ~1,200 species → ~20 minutes.
//
// Resumable: writes progress to data/inat-photos.json every 50 species. Re-runs
// skip species already processed (found OR confirmed-not-found).
//
// Output entry shape (keyed by IOC scientific name):
//   { url, attribution, license, wikipedia, iucn, taxonId } or null if no match.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT_PATH = "data/inat-photos.json";
const REQ_DELAY_MS = 1000;
const USER_AGENT =
  "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const coverage = JSON.parse(await readFile("data/coverage-report.json", "utf8"));
const missing = coverage.species.filter((s) => !s.commonsImage);
console.log(`${missing.length} species need photos`);

const existing = existsSync(OUT_PATH) ? JSON.parse(await readFile(OUT_PATH, "utf8")) : {};
console.log(`Already processed: ${Object.keys(existing).length}`);

let found = 0, notFound = 0, skipped = 0, errors = 0;
const start = Date.now();

async function lookup(scientificName) {
  const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(scientificName)}&rank=species&per_page=1`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const t = json.results?.[0];
  // Require exact-name match so we don't pick up similarly-named relatives.
  if (!t || t.name !== scientificName) return null;
  if (!t.default_photo) return { taxonId: t.id, url: null, wikipedia: t.wikipedia_url || null };
  return {
    taxonId: t.id,
    url: t.default_photo.medium_url || t.default_photo.url,
    attribution: t.default_photo.attribution || null,
    license: t.default_photo.license_code || null,
    wikipedia: t.wikipedia_url || null,
    iucn: t.conservation_status?.status_name || null,
  };
}

async function persist() {
  await writeFile(OUT_PATH, JSON.stringify(existing, null, 2));
}

for (const sp of missing) {
  const name = sp.scientificName;
  if (name in existing) { skipped++; continue; }
  try {
    const r = await lookup(name);
    existing[name] = r;
    if (r?.url) found++;
    else notFound++;
  } catch (err) {
    errors++;
    // Don't store — leave for retry on next run.
    console.warn(`  ${name}: ${err.message}`);
  }
  const done = found + notFound + errors;
  if (done % 50 === 0) {
    await persist();
    const rate = done / ((Date.now() - start) / 1000);
    const remaining = missing.length - skipped - done;
    const etaMin = (remaining / rate / 60).toFixed(1);
    process.stdout.write(
      `  ${done} new (${found} found, ${notFound} not in iNat, ${errors} errors) | ${rate.toFixed(1)}/s | ETA ${etaMin}min\n`,
    );
  }
  await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
}

await persist();
const totalWithPhoto = Object.values(existing).filter((e) => e?.url).length;
console.log(`\nDone.`);
console.log(`  New found:           ${found}`);
console.log(`  New confirmed-empty: ${notFound}`);
console.log(`  Skipped (cached):    ${skipped}`);
console.log(`  Errors:              ${errors}`);
console.log(`  Total iNat photos in file: ${totalWithPhoto}`);
