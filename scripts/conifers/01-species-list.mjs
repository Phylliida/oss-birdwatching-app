// Enumerate all accepted conifer (Pinopsida) species from GBIF's taxonomy
// backbone. Output: data/conifers/species.json
//
// Same per-species shape we used for birds (scientificName, genus, family)
// plus the GBIF key so downstream scripts can skip the name-match step.

import { mkdir, writeFile } from "node:fs/promises";

const PINOPSIDA_KEY = 194;
const OUT_PATH = "data/conifers/species.json";
const PER_PAGE = 300;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

await mkdir("data/conifers", { recursive: true });

let offset = 0;
const collected = [];
console.log("Enumerating conifers from GBIF...");
while (true) {
  const url = `https://api.gbif.org/v1/species/search?higherTaxonKey=${PINOPSIDA_KEY}&rank=SPECIES&status=ACCEPTED&limit=${PER_PAGE}&offset=${offset}`;
  const j = await fetchJson(url);
  collected.push(...j.results);
  if (j.endOfRecords) break;
  offset += PER_PAGE;
  process.stdout.write(`  ${collected.length} so far\r`);
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`Got ${collected.length} accepted species rows from GBIF.`);

// Clean + dedupe. We require canonicalName (binomial without authority),
// genus, and family. Hybrids (×) get filtered — they confuse downstream
// fetchers and aren't "real" species.
const seen = new Set();
const cleaned = [];
let dropped = { noName: 0, noGenus: 0, hybrid: 0, dup: 0 };
for (const r of collected) {
  if (!r.canonicalName || r.canonicalName.includes("×") || r.canonicalName.includes("×")) {
    if (!r.canonicalName) dropped.noName++;
    else dropped.hybrid++;
    continue;
  }
  if (!r.genus || !r.family) { dropped.noGenus++; continue; }
  if (seen.has(r.canonicalName)) { dropped.dup++; continue; }
  seen.add(r.canonicalName);
  cleaned.push({
    scientificName: r.canonicalName,
    genus: r.genus,
    family: r.family,
    gbifKey: r.key,
  });
}

cleaned.sort((a, b) => {
  if (a.family !== b.family) return a.family.localeCompare(b.family);
  if (a.genus !== b.genus) return a.genus.localeCompare(b.genus);
  return a.scientificName.localeCompare(b.scientificName);
});

await writeFile(OUT_PATH, JSON.stringify(cleaned, null, 2));
console.log(`Wrote ${OUT_PATH} — ${cleaned.length} species`);
console.log(`Dropped: ${dropped.noName} unnamed, ${dropped.hybrid} hybrids, ${dropped.noGenus} missing genus/family, ${dropped.dup} duplicates`);

const byFamily = {};
for (const s of cleaned) byFamily[s.family] = (byFamily[s.family] || 0) + 1;
console.log("Families:");
for (const [f, n] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f.padEnd(20)} ${n}`);
}
