// Pulls eBird species codes (e.g. "norcar" for Northern Cardinal) by parsing
// Cornell's published eBird taxonomy CSV. Maps by scientific name to IOC.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const URL = "https://www.birds.cornell.edu/clementschecklist/wp-content/uploads/2026/04/eBird_taxonomy_v2025-4.csv";
const CSV_PATH = "data/ebird-taxonomy.csv";
const OUT_PATH = "data/ebird-codes.json";

await mkdir("data", { recursive: true });
if (!existsSync(CSV_PATH)) {
  console.log(`Downloading eBird taxonomy CSV ...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(CSV_PATH));
  console.log(`Saved ${((await stat(CSV_PATH)).size / 1e6).toFixed(1)} MB`);
}

// Minimal CSV parser handling quoted fields (some FAMILY/SPECIES_GROUP cells
// embed commas).
function parseCsvLine(line) {
  const cells = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { cells.push(cur); cur = ""; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

const raw = await readFile(CSV_PATH, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ""));
const idx = {
  category: header.indexOf("CATEGORY"),
  code: header.indexOf("SPECIES_CODE"),
  sci: header.indexOf("SCI_NAME"),
  common: header.indexOf("PRIMARY_COM_NAME"),
};

const ioc = JSON.parse(await readFile("data/ioc-species.json", "utf8"));
const iocSet = new Set(ioc.map((s) => s.scientificName));

const out = {};
let total = 0, matched = 0;
for (let i = 1; i < lines.length; i++) {
  const cells = parseCsvLine(lines[i]);
  if (cells[idx.category] !== "species") continue;
  total++;
  const sci = cells[idx.sci];
  const code = cells[idx.code];
  if (!sci || !code) continue;
  if (iocSet.has(sci)) {
    out[sci] = code;
    matched++;
  }
}

await writeFile(OUT_PATH, JSON.stringify(out));
console.log(`eBird species rows: ${total}`);
console.log(`Matched to IOC:    ${matched}/${ioc.length} (${(matched / ioc.length * 100).toFixed(1)}%)`);
console.log(`Wrote ${OUT_PATH}`);

// A few samples.
const samples = ["Cardinalis cardinalis", "Struthio camelus", "Apteryx maxima", "Bubo bubo"];
for (const s of samples) if (out[s]) console.log(`  ${s} → ${out[s]}`);
