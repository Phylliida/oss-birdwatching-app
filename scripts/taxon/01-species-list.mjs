// Enumerate all accepted species under a taxon (genus or family) from GBIF.
// Usage:  TAXON=oaks node scripts/taxon/01-species-list.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { getTaxon } from "../taxa.mjs";

const taxon = getTaxon(process.env.TAXON);
const OUT_PATH = `${taxon.dataDir}/species.json`;
const PER_PAGE = 300;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

await mkdir(taxon.dataDir, { recursive: true });

console.log(`Enumerating ${taxon.commonName} (${taxon.rootName}, key=${taxon.rootKey})...`);
let offset = 0;
const collected = [];
while (true) {
  const url = `https://api.gbif.org/v1/species/search?higherTaxonKey=${taxon.rootKey}&rank=SPECIES&status=ACCEPTED&limit=${PER_PAGE}&offset=${offset}`;
  const j = await fetchJson(url);
  collected.push(...j.results);
  if (j.endOfRecords) break;
  offset += PER_PAGE;
  process.stdout.write(`  ${collected.length} so far\r`);
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`Got ${collected.length} ACCEPTED species rows.`);

const seen = new Set();
const cleaned = [];
let dropped = { noName: 0, noGenus: 0, hybrid: 0, dup: 0 };
for (const r of collected) {
  if (!r.canonicalName || r.canonicalName.includes("×")) {
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
cleaned.sort((a, b) => a.family.localeCompare(b.family) || a.genus.localeCompare(b.genus) || a.scientificName.localeCompare(b.scientificName));

await writeFile(OUT_PATH, JSON.stringify(cleaned, null, 2));
console.log(`Wrote ${OUT_PATH} — ${cleaned.length} species`);
console.log(`Dropped: ${dropped.noName} unnamed, ${dropped.hybrid} hybrids, ${dropped.noGenus} missing genus/family, ${dropped.dup} duplicates`);

const byFamily = {};
for (const s of cleaned) byFamily[s.family] = (byFamily[s.family] || 0) + 1;
console.log("Families:");
for (const [f, n] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f.padEnd(20)} ${n}`);
}
