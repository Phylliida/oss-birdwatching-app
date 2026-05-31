// Extracts cross-taxonomy name mappings from AVONET's crosswalk sheets.
// AVONET aligns BirdLife (Species1) ↔ eBird (Species2) ↔ BirdTree (Species3).
// We use IOC names as the anchor: where BirdLife matches IOC exactly, we
// surface any eBird or BirdTree name that differs as a synonym.
//
// Output: data/synonyms.json keyed by IOC scientific name → { ebird, birdtree }

import { readFile, writeFile } from "node:fs/promises";
import { read, utils } from "xlsx";

const XLSX_PATH = "data/AVONET-supp-1.xlsx";
const OUT_PATH = "data/synonyms.json";

const buf = await readFile(XLSX_PATH);
const wb = read(buf, { type: "buffer" });

// Names of the crosswalk sheets vary slightly between AVONET versions.
const ebSheet = wb.SheetNames.find((n) => /birdlife.*ebird.*crosswalk|ebird.*crosswalk/i.test(n));
const btSheet = wb.SheetNames.find((n) => /birdlife.*birdtree.*crosswalk|birdtree.*crosswalk/i.test(n));
if (!ebSheet) console.warn("Couldn't find BirdLife-eBird crosswalk sheet.");
if (!btSheet) console.warn("Couldn't find BirdLife-BirdTree crosswalk sheet.");

function loadCrosswalk(sheet, fromCol, toCol) {
  if (!sheet) return new Map();
  const rows = utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
  const out = new Map();
  for (const r of rows) {
    const from = String(r[fromCol] || "").trim();
    const to = String(r[toCol] || "").trim();
    if (!from || !to) continue;
    if (from === to) continue; // only record differences
    out.set(from, to);
  }
  return out;
}

const blToEbird = loadCrosswalk(ebSheet, "Species1", "Species2");
const blToBirdtree = loadCrosswalk(btSheet, "Species1", "Species3");
console.log(`BirdLife→eBird differences:    ${blToEbird.size}`);
console.log(`BirdLife→BirdTree differences: ${blToBirdtree.size}`);

const ioc = JSON.parse(await readFile("data/ioc-species.json", "utf8"));
const out = {};
let speciesWithSynonym = 0;
for (const sp of ioc) {
  const name = sp.scientificName;
  // IOC ↔ BirdLife is a direct name match for ~88% of species. Where it
  // matches, look up the corresponding eBird/BirdTree name; record only if
  // it differs from IOC's.
  const eb = blToEbird.get(name);
  const bt = blToBirdtree.get(name);
  if (!eb && !bt) continue;
  out[name] = {};
  if (eb && eb !== name) out[name].ebird = eb;
  if (bt && bt !== name) out[name].birdtree = bt;
  if (Object.keys(out[name]).length === 0) delete out[name];
  else speciesWithSynonym++;
}

await writeFile(OUT_PATH, JSON.stringify(out));
console.log(`Wrote ${OUT_PATH}`);
console.log(`Species with ≥1 cross-taxonomy synonym: ${speciesWithSynonym}/${ioc.length}`);

// Sample
const samples = Object.entries(out).slice(0, 5);
for (const [k, v] of samples) {
  console.log(`  ${k}: ${JSON.stringify(v)}`);
}
