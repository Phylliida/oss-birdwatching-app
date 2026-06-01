// Parse the Plants For A Future "Database_Temperate.csv" (obtained by donation
// from pfaf.org) into a binomial -> { edibility, hazards, ... } map.
//
// PFAF data is CC BY-NC-SA: non-commercial, attribution, share-alike, and a
// prominent link back to Plants For A Future must be kept wherever it's shown
// (the UI does this). https://pfaf.org
//
// Output: data/edibility/pfaf.json
//   { "<Genus species>": { er, mr, edible, hazards, common } }
//     er/mr  = edibility / medicinal rating, integer 0–5
//     edible = "Edible uses" text (how to eat), null if none
//     hazards= "Known hazards" text, null if "None known"/empty

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const SRC = "data/plantsforafuture/Database_Temperate.csv";
const OUT = "data/edibility/pfaf.json";
if (!existsSync(SRC)) { console.error(`Missing ${SRC}`); process.exit(1); }

// Read as latin1 — the file is Windows-1252-ish (degree signs etc.).
const text = await readFile(SRC, "latin1");

// RFC4180-ish parser: handles quoted fields with embedded commas, newlines and
// escaped "" quotes.
function parseCsv(s) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r" || c === "\n") {
      // Records are CR-terminated (classic Mac); also handle CRLF. Newlines
      // inside quoted fields are kept above (we're in the non-quoted branch).
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(text);
const header = rows[0];
const col = (name) => header.indexOf(name);
const iLatin = col("Latin name"), iCommon = col("Common name"),
      iHaz = col("Known hazards"), iEdible = col("Edible uses"),
      iER = col("EdibilityRating"), iMR = col("MedicinalRating");

// Strip PFAF's inline citation markers like [146, 158] / [K] for clean display.
function clean(s) {
  if (!s) return null;
  let t = s.replace(/\s*\[[0-9KPR][0-9KPR,\s-]*\]/g, "").replace(/\s+/g, " ").trim();
  if (!t || /^none known$/i.test(t) || /^not known$/i.test(t)) return null;
  return t;
}
const ratingOf = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

const out = {};
let withEdible = 0, withHaz = 0;
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const name = (row[iLatin] || "").trim();
  if (!name) continue;
  // Join key = binomial (first two words; drop author/subspecies).
  const m = name.match(/^([A-Z][A-Za-z-]+)\s+([a-z][a-z-]+)/);
  if (!m) continue;
  const key = `${m[1]} ${m[2]}`;
  const er = ratingOf(row[iER]), mr = ratingOf(row[iMR]);
  const edible = clean(row[iEdible]);
  const hazards = clean(row[iHaz]);
  const rec = {};
  if (er) rec.er = er;
  if (mr) rec.mr = mr;
  if (edible) { rec.edible = edible; withEdible++; }
  if (hazards) { rec.hazards = hazards; withHaz++; }
  const common = (row[iCommon] || "").trim();
  if (common) rec.common = common;
  if (Object.keys(rec).length && !out[key]) out[key] = rec;
}

await mkdir("data/edibility", { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} — ${Object.keys(out).length.toLocaleString()} plants`);
console.log(`  with edible-uses text: ${withEdible.toLocaleString()} | with hazards text: ${withHaz.toLocaleString()}`);
for (const t of ["Abelmoschus esculentus", "Urtica dioica", "Aconitum napellus", "Sambucus nigra", "Prunus dulcis"]) {
  console.log(`  ${t}: ${JSON.stringify(out[t]) || "—"}`);
}
