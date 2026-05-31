// Downloads the IOC World Bird List master XLSX, parses it,
// and writes a clean JSON species list to data/ioc-species.json.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { read, utils } from "xlsx";

const IOC_VERSION = "15.2";
const IOC_URL = `https://worldbirdnames.org/master_ioc_list_v${IOC_VERSION}.xlsx`;
const DATA_DIR = "data";
const XLSX_PATH = `${DATA_DIR}/ioc-master-v${IOC_VERSION}.xlsx`;
const JSON_PATH = `${DATA_DIR}/ioc-species.json`;

await mkdir(DATA_DIR, { recursive: true });

if (!existsSync(XLSX_PATH)) {
  console.log(`Downloading IOC v${IOC_VERSION} from ${IOC_URL} ...`);
  const res = await fetch(IOC_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching IOC list`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(XLSX_PATH, buf);
  console.log(`Saved ${buf.length} bytes to ${XLSX_PATH}`);
} else {
  console.log(`Using cached ${XLSX_PATH}`);
}

const buf = await readFile(XLSX_PATH);
const wb = read(buf, { type: "buffer" });
console.log(`Sheets: ${wb.SheetNames.join(", ")}`);

// IOC master typically has one sheet with rows describing order/family/genus/species.
// Schema isn't strict — print first sheet's header so we know what we're working with.
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = utils.sheet_to_json(sheet, { header: 1, defval: "" });

// Find the header row: it's the first row containing a cell that looks like a column name.
// IOC formats vary; look for a row containing "Order" or "Scientific Name".
let headerIdx = rows.findIndex((r) =>
  r.some((c) => /scientific name|species/i.test(String(c))),
);
if (headerIdx < 0) headerIdx = 0;
const headers = rows[headerIdx].map((h) => String(h).trim());
console.log(`Header row (index ${headerIdx}):`, headers);

const species = [];
let currentOrder = "";
let currentFamily = "";
let currentFamilyEnglish = "";
let currentGenus = "";

for (let i = headerIdx + 1; i < rows.length; i++) {
  const row = rows[i];
  const rec = Object.fromEntries(headers.map((h, j) => [h, String(row[j] ?? "").trim()]));

  // IOC uses a stacked layout: order/family/genus rows precede their species.
  // Heuristic — pick up the most recent non-empty value for each rank column.
  for (const [k, v] of Object.entries(rec)) {
    if (!v) continue;
    if (/^order$/i.test(k)) currentOrder = v;
    else if (/^family\s*\(scientific\)/i.test(k)) currentFamily = v;
    else if (/^family\s*\(english\)/i.test(k)) currentFamilyEnglish = v;
    else if (/^genus$/i.test(k)) currentGenus = v;
  }

  const speciesEpithet = rec["Species (Scientific)"] || "";
  const commonName = rec["Species (English)"] || "";

  if (!speciesEpithet || !currentGenus) continue;
  // Skip subspecies-only rows: those usually have a "subspecies" column populated
  // and no fresh species epithet. We treat each unique genus+species as one entry.
  const scientific = `${currentGenus} ${speciesEpithet}`.replace(/\s+/g, " ").trim();
  if (!/^[A-Z][a-z]+ [a-z-]+$/.test(scientific)) continue;

  species.push({
    scientificName: scientific,
    commonName,
    genus: currentGenus,
    family: currentFamily,
    familyEnglish: currentFamilyEnglish,
    order: currentOrder,
  });
}

// De-dupe by scientific name (rows may repeat across regions).
const seen = new Set();
const unique = species.filter((s) => {
  if (seen.has(s.scientificName)) return false;
  seen.add(s.scientificName);
  return true;
});

await writeFile(JSON_PATH, JSON.stringify(unique, null, 2));
console.log(`Wrote ${unique.length} species to ${JSON_PATH}`);
console.log("Sample:", unique.slice(0, 3));
