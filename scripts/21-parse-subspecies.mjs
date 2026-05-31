// Re-parses the IOC master XLSX to extract subspecies info. Subspecies rows
// follow their parent species in the sheet, with the "Subspecies" column
// populated and a blank "Species (Scientific)" column.
//
// Output: data/subspecies.json keyed by "Genus species" →
//   [{ name: "Genus species ssp", authority, breedingRange, nonbreedingRange }, ...]

import { readFile, writeFile } from "node:fs/promises";
import { read, utils } from "xlsx";

const XLSX_PATH = "data/ioc-master-v15.2.xlsx";
const OUT_PATH = "data/subspecies.json";

const buf = await readFile(XLSX_PATH);
const wb = read(buf, { type: "buffer" });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = utils.sheet_to_json(sheet, { header: 1, defval: "" });

// Find header row (same heuristic as fetch-taxonomy).
let headerIdx = rows.findIndex((r) =>
  r.some((c) => /scientific name|species/i.test(String(c))),
);
if (headerIdx < 0) headerIdx = 0;
const headers = rows[headerIdx].map((h) => String(h).trim());

const out = {};
let currentGenus = "";
let currentSpecies = "";
let currentScientific = "";

for (let i = headerIdx + 1; i < rows.length; i++) {
  const row = rows[i];
  const rec = Object.fromEntries(headers.map((h, j) => [h, String(row[j] ?? "").trim()]));

  if (rec["Genus"]) currentGenus = rec["Genus"];
  const speciesEpithet = rec["Species (Scientific)"];
  const subspeciesEpithet = rec["Subspecies"];

  if (speciesEpithet && currentGenus) {
    currentSpecies = speciesEpithet;
    currentScientific = `${currentGenus} ${speciesEpithet}`;
    // Init the subspecies array so even subspecies-less species appear cleanly.
    if (!out[currentScientific]) out[currentScientific] = [];
    continue;
  }

  if (subspeciesEpithet && currentScientific) {
    out[currentScientific].push({
      name: `${currentScientific} ${subspeciesEpithet}`,
      authority: rec["Authority"] || null,
      breedingRange: rec["Breeding Range"] || null,
      breedingSubregions: rec["Breeding Range-Subregion(s)"] || null,
      nonbreedingRange: rec["Nonbreeding Range"] || null,
    });
  }
}

// Strip species with zero subspecies so the file isn't bloated.
const filtered = Object.fromEntries(
  Object.entries(out).filter(([_, v]) => v.length > 0),
);

await writeFile(OUT_PATH, JSON.stringify(filtered));
const totalSpecies = Object.keys(filtered).length;
const totalSubspecies = Object.values(filtered).reduce((s, l) => s + l.length, 0);
const histo = {};
for (const v of Object.values(filtered)) histo[v.length] = (histo[v.length] || 0) + 1;
console.log(`Wrote ${OUT_PATH}`);
console.log(`  Species with at least one subspecies: ${totalSpecies}`);
console.log(`  Total subspecies: ${totalSubspecies}`);
console.log(`  Distribution: ${Object.entries(histo).sort((a, b) => +a[0] - +b[0]).slice(0, 10).map(([k, v]) => `${k}ss:${v}`).join(", ")} ...`);

// Sample a couple high-diversity species.
const top = Object.entries(filtered).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
for (const [sp, list] of top) {
  console.log(`  ${sp}: ${list.length} subspecies (e.g., ${list[0].name})`);
}
