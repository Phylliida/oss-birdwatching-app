// Enumerate ALL accepted species under Plantae (GBIF kingdom key 6), capturing
// full lineage (phylum -> class -> order -> family -> genus) so a single unified
// tree-of-life browser can nest them faithfully.
//
// Enumerated per-order (each order is well under GBIF's deep-paging limit), then
// concatenated + de-duplicated by canonical name. Resumable: re-running skips
// orders already fully captured (tracked in a sidecar progress file).
//
// Output: data/plantae/species.json — array of
//   { scientificName, genus, family, order, class, phylum, gbifKey }

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const PLANTAE = 6;
const PER_PAGE = 300;
const OUT = "data/plantae/species.json";
const PROGRESS = "data/plantae/enumerate-progress.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, tries = 5) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** a); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (a === tries - 1) throw e;
      await sleep(500 * 2 ** a);
    }
  }
}

await mkdir("data/plantae", { recursive: true });

// All orders under Plantae.
const ordResp = await j(`https://api.gbif.org/v1/species/search?highertaxonKey=${PLANTAE}&rank=ORDER&status=ACCEPTED&limit=500`);
const orders = ordResp.results
  .map((o) => ({ key: o.key, name: o.canonicalName || o.scientificName }))
  .filter((o) => o.key && o.name);
console.log(`${orders.length} orders under Plantae`);

// Resume state.
const byName = new Map();
let doneOrders = new Set();
if (existsSync(OUT)) {
  try {
    for (const s of JSON.parse(await readFile(OUT, "utf8"))) byName.set(s.scientificName, s);
  } catch { /* start fresh */ }
}
if (existsSync(PROGRESS)) {
  try { doneOrders = new Set(JSON.parse(await readFile(PROGRESS, "utf8"))); } catch { /* ignore */ }
}
console.log(`Resuming: ${byName.size} species, ${doneOrders.size} orders already done`);

const CONCURRENCY = 4;
const PAGE_DELAY = 40;
const todo = orders.filter((o) => !doneOrders.has(o.key));
console.log(`${todo.length} orders to do (concurrency ${CONCURRENCY})`);

async function enumerateOrder(ord) {
  let offset = 0, got = 0;
  while (true) {
    const u = `https://api.gbif.org/v1/species/search?highertaxonKey=${ord.key}&rank=SPECIES&status=ACCEPTED&limit=${PER_PAGE}&offset=${offset}`;
    const r = await j(u);
    for (const x of r.results) {
      if (!x.canonicalName || x.canonicalName.includes("×")) continue; // skip hybrids / unnamed
      if (!x.genus || !x.family) continue;
      if (byName.has(x.canonicalName)) continue;
      byName.set(x.canonicalName, {
        scientificName: x.canonicalName,
        genus: x.genus,
        family: x.family,
        order: x.order || ord.name,
        class: x.class || null,
        phylum: x.phylum || null,
        gbifKey: x.key,
      });
      got++;
    }
    if (r.endOfRecords) break;
    offset += PER_PAGE;
    if (offset >= 100000) { console.log(`  (offset cap hit for ${ord.name})`); break; }
    await sleep(PAGE_DELAY);
  }
  return got;
}

let nextIdx = 0, processed = 0;
async function worker() {
  while (nextIdx < todo.length) {
    const ord = todo[nextIdx++];
    const got = await enumerateOrder(ord);
    doneOrders.add(ord.key);
    processed++;
    console.log(`  [${processed}/${todo.length}] ${ord.name.padEnd(20)} +${String(got).padStart(6)}  total ${byName.size.toLocaleString()}`);
    if (processed % 5 === 0) {
      await writeFile(OUT, JSON.stringify([...byName.values()]));
      await writeFile(PROGRESS, JSON.stringify([...doneOrders]));
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT, JSON.stringify([...byName.values()]));
await writeFile(PROGRESS, JSON.stringify([...doneOrders]));
console.log(`\nWrote ${OUT} — ${byName.size.toLocaleString()} species across ${doneOrders.size} orders`);
