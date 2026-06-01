// Parse the Plants For A Future "Database_Temperate.csv" (obtained by donation
// from pfaf.org) into a binomial -> full record map.
//
// PFAF data is CC BY-NC-SA: non-commercial, attribution, share-alike, and a
// prominent link back to Plants For A Future must be kept wherever it's shown
// (the UI does this). https://pfaf.org
//
// Output: data/edibility/pfaf.json  { "<Genus species>": { …all useful fields… } }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const SRC = "data/plantsforafuture/Database_Temperate.csv";
const OUT = "data/edibility/pfaf.json";
if (!existsSync(SRC)) { console.error(`Missing ${SRC}`); process.exit(1); }

const text = await readFile(SRC, "latin1"); // file is Windows-1252-ish

// RFC4180-ish parser; records are CR-terminated (classic Mac), CRLF also handled.
function parseCsv(s) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(text);
const H = rows[0];
const ix = {};
for (const name of H) ix[name] = H.indexOf(name);
const get = (row, name) => (row[ix[name]] || "").trim();

// Strip PFAF inline citation markers ([146, 158] / [K]) and tidy whitespace,
// keeping single newlines between paragraphs (the source uses CR for those).
function clean(s) {
  if (!s) return null;
  let t = s.replace(/\s*\[[0-9KPR][0-9KPR,\s-]*\]/g, "");
  t = t.replace(/[ \t]+/g, " ").replace(/ *[\r\n]+ */g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (!t || /^(none known|not known|unknown)$/i.test(t)) return null;
  return t;
}
const intOr = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };
const numOr = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const isTrue = (s) => String(s).trim().toUpperCase() === "TRUE";

const FLAG_COLS = [
  ["Nitrogen fixer", "nitrogen"], ["Self-fertile", "selffertile"], ["Scented", "scented"],
  ["FrostTender", "frosttender"], ["Drought", "drought"], ["Poor soil", "poorsoil"],
  ["Pollution", "pollution"], ["Wildlife", "wildlife"], ["Well-drained", "welldrained"],
  ["Saline", "saline"],
];

const out = {};
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const name = get(row, "Latin name");
  const m = name.match(/^([A-Z][A-Za-z-]+)\s+([a-z][a-z-]+)/);
  if (!m) continue;
  const key = `${m[1]} ${m[2]}`;
  if (out[key]) continue;

  const rec = {};
  const er = intOr(get(row, "EdibilityRating")) || 0;
  const mr = intOr(get(row, "MedicinalRating")) || 0;
  if (er) rec.er = er;
  if (mr) rec.mr = mr;

  const fields = {
    edible: "Edible uses", medicinal: "Medicinal", other: "Uses notes",
    hazards: "Known hazards", cultivation: "Cultivation details",
    propagation: "Propagation", range: "Range", habitat: "Habitat",
    pollinators: "Pollinators", synonyms: "Synonyms",
  };
  for (const [k, col] of Object.entries(fields)) { const v = clean(get(row, col)); if (v) rec[k] = v; }

  const habit = get(row, "Habit"); if (habit) rec.habit = habit;
  const decid = get(row, "Deciduous/Evergreen"); if (decid) rec.decid = decid; // D / E
  const h = numOr(get(row, "Height")); if (h) rec.height = h;
  const w = numOr(get(row, "Width")); if (w) rec.width = w;
  const hard = intOr(get(row, "UK Hardiness")); if (hard != null) rec.hardy = hard;
  for (const [k, col] of [["soil", "Soil"], ["shade", "Shade"], ["moisture", "Moisture"], ["ph", "pH"], ["growth", "Growth rate"]]) {
    const v = get(row, col); if (v) rec[k] = v;
  }

  const flags = FLAG_COLS.filter(([col]) => isTrue(get(row, col))).map(([, f]) => f);
  if (get(row, "Wind") === "W") flags.push("wind");
  if (flags.length) rec.flags = flags;

  if (Object.keys(rec).length) out[key] = rec;
}

await mkdir("data/edibility", { recursive: true });
await writeFile(OUT, JSON.stringify(out));
const n = Object.keys(out).length;
const c = (k) => Object.values(out).filter((v) => v[k]).length;
console.log(`Wrote ${OUT} — ${n.toLocaleString()} plants`);
console.log(`  edible:${c("edible")} medicinal:${c("medicinal")} other:${c("other")} hazards:${c("hazards")} cultivation:${c("cultivation")} propagation:${c("propagation")} habitat:${c("habitat")}`);
