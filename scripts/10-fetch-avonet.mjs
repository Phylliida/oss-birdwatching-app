// Downloads AVONET (Tobias et al. 2022) — morphological + ecological traits
// for all 11,009 extant bird species. Available on Figshare as XLSX.
//
// Sheet layout: the file has multiple sheets, one per taxonomy backbone
// (BirdLife, eBird, BirdTree). We pick the BirdLife one first and inspect
// columns to learn what's actually there before deciding how to use it.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { read, utils } from "xlsx";

const URL = "https://ndownloader.figshare.com/files/34480856";
const XLSX_PATH = "data/AVONET-supp-1.xlsx";
const OUT_PATH = "data/avonet.json";

await mkdir("data", { recursive: true });

if (!existsSync(XLSX_PATH)) {
  console.log(`Downloading AVONET (~22 MB)...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(XLSX_PATH));
  console.log(`Saved ${((await stat(XLSX_PATH)).size / 1e6).toFixed(1)} MB`);
} else {
  console.log(`Cached ${XLSX_PATH}`);
}

const buf = await readFile(XLSX_PATH);
const wb = read(buf, { type: "buffer" });
console.log(`Sheets: ${wb.SheetNames.join(" | ")}`);

// Pick whichever sheet looks most likely to be species-keyed measurements.
// Prefer "BirdLife" since AVONET's primary taxonomy is BirdLife; also report
// columns of each candidate so we can verify.
function summarize(name) {
  const rows = utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  if (rows.length === 0) return { name, rowCount: 0, columns: [] };
  return { name, rowCount: rows.length, columns: Object.keys(rows[0]) };
}
for (const name of wb.SheetNames) {
  const s = summarize(name);
  console.log(`  [${s.name}] ${s.rowCount} rows, ${s.columns.length} cols: ${s.columns.slice(0, 8).join(", ")}${s.columns.length > 8 ? ", ..." : ""}`);
}

// Heuristic: the species-level sheet has a few-thousand rows, contains a
// scientific-name column, and includes numeric measurements like "Mass".
const candidate = wb.SheetNames.find((n) => {
  const rows = utils.sheet_to_json(wb.Sheets[n], { defval: "" });
  if (rows.length < 5000 || rows.length > 15000) return false;
  const cols = Object.keys(rows[0] ?? {});
  return cols.some((c) => /species/i.test(c)) && cols.some((c) => /mass/i.test(c));
});
if (!candidate) {
  console.error("Couldn't identify a species-level sheet. Inspect manually.");
  process.exit(1);
}
console.log(`\nUsing sheet: ${candidate}`);

const rows = utils.sheet_to_json(wb.Sheets[candidate], { defval: "" });
console.log(`Rows: ${rows.length}`);
console.log(`Columns: ${Object.keys(rows[0]).join(" | ")}`);
console.log(`Sample row:`, rows[0]);

await writeFile(OUT_PATH, JSON.stringify({ source: candidate, rows }));
console.log(`Wrote ${OUT_PATH}`);
