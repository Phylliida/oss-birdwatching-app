// Parse EOL TraitBank (data/eol/traits_all.zip) into per-species traits for our
// backbone, keyed by scientific name. We keep EVERY non-empty directly-asserted
// trait (no curation), de-duplicated by (trait, value) since TraitBank repeats
// the same assertion from many sources.
//
// Archive members (CSV, quote-aware):
//   terms.csv  : uri,name,type           — glossary for predicate + value URIs
//   pages.csv  : page_id,parent_id,rank,canonical  — page -> clean binomial
//   traits.csv : eol_pk,page_id,resource_pk,resource_id,source,scientific_name,
//                predicate,object_page_id,value_uri,normal_measurement,
//                normal_units_uri,normal_units,measurement,units_uri,units,
//                literal,method,remarks,sample_size,name_en,citation
//
// Output: data/eol/traits-by-name.json  ->  { "<name>": [ {t,v}, ... ] }
// build-*-tree.mjs / 07-build-tree.mjs attach these as a Traits section.
//
// Usage:  node --max-old-space-size=12288 scripts/parse-eol-traits.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ZIP = "data/eol/traits_all.zip";
if (!existsSync(ZIP)) { console.error(`${ZIP} not found.`); process.exit(1); }

function splitCSV(l) {
  const o = []; let c = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === ",") { o.push(c); c = ""; } else if (ch === '"') q = true; else c += ch; }
  }
  o.push(c); return o;
}
function member(name, onRow) {
  return new Promise((resolve, reject) => {
    const p = spawn("unzip", ["-p", ZIP, `trait_bank/${name}`]);
    p.on("error", reject);
    const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
    let header = null;
    rl.on("line", (l) => { if (!header) { header = splitCSV(l); return; } onRow(splitCSV(l)); });
    rl.on("close", resolve);
    p.stderr.on("data", () => {});
  });
}

// ---- our species (union of all three trees) -------------------------------
const ourNames = new Set();
for (const p of ["data/plantae/species.json", "data/animalia/species.json"]) {
  if (existsSync(p)) for (const s of JSON.parse(await readFile(p, "utf8"))) ourNames.add(s.scientificName);
}
for (const p of ["data/ioc-species.json"]) { // birds
  if (existsSync(p)) for (const s of JSON.parse(await readFile(p, "utf8"))) if (s.scientificName) ourNames.add(s.scientificName);
}
console.log(`${ourNames.size.toLocaleString()} species names across our trees`);

// ---- terms glossary: uri -> name ------------------------------------------
const term = new Map();
await member("terms.csv", (c) => term.set(c[0], c[1]));
console.log(`${term.size.toLocaleString()} glossary terms`);
const tail = (u) => (u || "").replace(/^.*[\/#]/, "");
const named = (uri) => term.get(uri) || tail(uri);
// Round measurement floats to 4 significant figures (TraitBank stores raw
// doubles like 0.008213721020965523).
const num = (s) => { const f = parseFloat(s); return isFinite(f) ? String(+f.toPrecision(4)) : s; };

// ---- pages: page_id -> our name (only matches we care about) --------------
const pageName = new Map();
await member("pages.csv", (c) => { const id = c[0], canon = c[3]; if (canon && ourNames.has(canon)) pageName.set(id, canon); });
console.log(`${pageName.size.toLocaleString()} EOL pages matched to our species`);

// ---- traits: accumulate per species, de-duped -----------------------------
const out = {};            // name -> [{t,v}]
const seen = new Map();    // name -> Set("t␟v")
let rows = 0, kept = 0;
await member("traits.csv", (c) => {
  if (++rows % 50_000_000 === 0) console.log(`  ${(rows / 1e6).toFixed(0)}M trait rows | ${kept.toLocaleString()} kept`);
  const name = pageName.get(c[1]);
  if (!name) return;
  const t = named(c[6]);
  if (!t) return;
  // value: English label > normalised measurement > raw measurement > value URI > literal
  let v = c[19] && c[19].trim();
  if (!v && c[9]) v = `${num(c[9])} ${c[11] || named(c[10]) || ""}`.trim();
  if (!v && c[12]) v = `${num(c[12])} ${c[14] || named(c[13]) || ""}`.trim();
  if (!v && c[8]) v = named(c[8]);
  if (!v && c[15]) v = c[15].trim();
  if (!v) return;
  let s = seen.get(name); if (!s) { s = new Set(); seen.set(name, s); }
  const key = t + "␟" + v;
  if (s.has(key)) return;
  s.add(key);
  (out[name] || (out[name] = [])).push({ t, v });
  kept++;
});
for (const arr of Object.values(out)) arr.sort((a, b) => a.t.localeCompare(b.t) || a.v.localeCompare(b.v));

await mkdir("data/eol", { recursive: true });
await writeFile("data/eol/traits-by-name.json", JSON.stringify(out));
const species = Object.keys(out).length;
const totalTraits = Object.values(out).reduce((n, a) => n + a.length, 0);
console.log(`Wrote data/eol/traits-by-name.json — ${species.toLocaleString()} species, ${totalTraits.toLocaleString()} unique traits (avg ${(totalTraits / species).toFixed(1)}/sp)`);
