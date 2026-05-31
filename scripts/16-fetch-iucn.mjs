// Fetches IUCN conservation status for every IOC species via the iNaturalist
// taxa lookup endpoint. Species already covered by data/inat-photos.json
// (gap-fill run) carry their IUCN status forward and are skipped to save
// requests. ~10K species to fetch fresh; ~3 hours at 1 req/sec.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/ioc-species.json";
const INAT_PATH = "data/inat-photos.json";
const OUT_PATH = "data/iucn-status.json";
const PER_REQUEST_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const inat = existsSync(INAT_PATH) ? JSON.parse(await readFile(INAT_PATH, "utf8")) : {};

let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch (err) { console.warn(`Couldn't parse ${OUT_PATH} (${err.message}); starting fresh.`); }
}

// Seed with IUCN data we already have from the gap-fill iNat run.
for (const [name, rec] of Object.entries(inat)) {
  if (rec?.iucn && !(name in existing)) existing[name] = rec.iucn;
}
console.log(`${species.length} species; ${Object.keys(existing).length} already have IUCN status`);

async function lookup(name) {
  const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&rank=species&per_page=1`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const t = json.results?.[0];
      if (!t || t.name !== name) return null;
      return t.conservation_status?.status_name || null;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

let done = 0;
let found = 0;
let missing = 0;
let errors = 0;
const start = Date.now();

for (const sp of species) {
  const name = sp.scientificName;
  if (name in existing) { done++; continue; }
  try {
    const status = await lookup(name);
    existing[name] = status; // null is meaningful: "we checked, no IUCN status"
    if (status) found++;
    else missing++;
  } catch (err) {
    errors++;
    if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
  }
  done++;
  if (done % 100 === 0) {
    await writeFile(OUT_PATH, JSON.stringify(existing));
    const rate = done / ((Date.now() - start) / 1000);
    const remaining = species.length - done;
    const eta = (remaining / rate / 60).toFixed(1);
    process.stdout.write(
      `  ${done}/${species.length} | new found: ${found}, no status: ${missing}, errors: ${errors} | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
    );
  }
  await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
}

await writeFile(OUT_PATH, JSON.stringify(existing));
const withStatus = Object.values(existing).filter((v) => v).length;
console.log(`\nDone. ${withStatus}/${species.length} species have an IUCN status (${((withStatus / species.length) * 100).toFixed(1)}%)`);
