// Build a lookup from taxonomic-author citation forms to full names, so species
// pages can show "Carl Linnaeus" instead of "L." (plants) / "Linnaeus" (birds).
//
// Wikidata tags each taxonomist with their botanical author abbreviation (P428,
// e.g. "L.") and zoological author citation (P835, e.g. "Linnaeus"); both point
// at the same item, whose English label is the full name. CC0.
//
// Output: data/author-names.json  { "L.": "Carl Linnaeus", "Linnaeus": "...", … }

import { writeFile } from "node:fs/promises";

const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const SPARQL = "https://query.wikidata.org/sparql";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(q) {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(SPARQL + "?query=" + encodeURIComponent(q), {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * 2 ** a); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).results.bindings;
    } catch (e) { if (a === 4) throw e; await sleep(2000 * 2 ** a); }
  }
}

const out = {};
for (const prop of ["P428", "P835"]) {
  // Keyset pagination on the value (cursor) — no deep OFFSET, so WDQS stays fast.
  let last = "", total = 0;
  while (true) {
    const lit = '"' + last.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const rows = await query(`SELECT ?v ?name WHERE { ?q wdt:${prop} ?v . FILTER(?v > ${lit}) . ?q rdfs:label ?name . FILTER(LANG(?name) = "en") } ORDER BY ?v LIMIT 8000`);
    if (!rows || !rows.length) break;
    for (const b of rows) { const v = b.v.value.trim(); if (v && !(v in out)) out[v] = b.name.value; }
    total += rows.length;
    last = rows[rows.length - 1].v.value;
    if (rows.length < 8000) break;
    await sleep(300);
  }
  console.log(`  ${prop}: ${total} rows`);
}

await writeFile("data/author-names.json", JSON.stringify(out));
console.log(`Wrote data/author-names.json — ${Object.keys(out).length.toLocaleString()} author forms`);
for (const k of ["L.", "Linnaeus", "DC.", "Gmelin", "Standl.", "S.Watson"]) console.log(`  ${k} -> ${out[k] || "(none)"}`);
