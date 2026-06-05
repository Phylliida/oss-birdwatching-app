// Enumerate the whole animal kingdom straight from the GBIF backbone dump —
// no API crawl needed (we already have the dump for discovery years).
//
// data/gbif-backbone/simple.txt.gz is tab-delimited, header-less. Columns
// (0-indexed, verified against Panthera leo / a virus genus row):
//   [0] taxonKey   [4] status     [5] rank        [10] kingdomKey
//   [11] phylumKey [12] classKey  [13] orderKey   [14] familyKey
//   [15] genusKey  [16] speciesKey                [19] canonicalName
// Lineage columns are KEYS, so we resolve them to names via a first pass over
// the higher taxa, then emit one species.json row per leaf with named lineage —
// the exact shape build-animalia-tree.mjs / build-plantae-tree.mjs expect
// ({ scientificName, phylum, class, order, family, genus, gbifKey, rank }).
//
// Scope: kingdom == Animalia (1), status ACCEPTED. We keep rank SPECIES (the
// faithful Linnaean leaves) and UNRANKED — but in practice every accepted
// UNRANKED animal in the backbone is a BOLD BIN (a DNA-barcode cluster id like
// "BOLD:AAO4727") with a NULL canonicalName, so the nameless-row skip below
// drops all ~604K of them. They have no real name to show, match a wiki page,
// or join an iNat photo by, so the "unranked iff photo/wiki" rule excludes them
// by construction — leaving the ~1.82M properly-named species.
//
// Usage:  node --max-old-space-size=8192 scripts/enumerate-animalia.mjs

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const SRC = "data/gbif-backbone/simple.txt.gz";
const OUT_DIR = "data/animalia";
const ANIMALIA = "1";
const HIGHER = new Set(["KINGDOM", "PHYLUM", "CLASS", "ORDER", "FAMILY", "GENUS"]);
const LEAF = new Set(["SPECIES", "UNRANKED"]);

await mkdir(OUT_DIR, { recursive: true });

function lines() {
  return createInterface({ input: createReadStream(SRC).pipe(createGunzip()), crlfDelay: Infinity });
}

// ---- Pass 1: taxonKey -> canonicalName for every accepted animal higher taxon.
console.log("Pass 1: collecting higher-taxon names …");
const keyName = new Map();
let p1 = 0;
for await (const line of lines()) {
  const c = line.split("\t");
  if (c[10] !== ANIMALIA || c[4] !== "ACCEPTED") continue;
  if (HIGHER.has(c[5]) && c[19] && c[19] !== "\\N") keyName.set(c[0], c[19]);
  if (++p1 % 2_000_000 === 0) process.stdout.write(`  ${(p1 / 1e6).toFixed(0)}M rows scanned\n`);
}
console.log(`  ${keyName.size.toLocaleString()} higher-taxon names cached`);

// ---- Pass 2: emit one row per accepted animal SPECIES / UNRANKED leaf.
console.log("Pass 2: emitting species.json …");
const out = createWriteStream(`${OUT_DIR}/species.json`);
out.write("[");
const nameOf = (key) => (key && key !== "\\N" ? keyName.get(key) || null : null);
let n = 0, species = 0, unranked = 0, noFamily = 0;
for await (const line of lines()) {
  const c = line.split("\t");
  if (c[10] !== ANIMALIA || c[4] !== "ACCEPTED" || !LEAF.has(c[5])) continue;
  const sci = c[19];
  if (!sci || sci === "\\N") continue;
  const family = nameOf(c[14]);
  const genus = nameOf(c[15]);
  // Need at least a family OR genus to place the node in the tree; otherwise it
  // would float directly under a phylum/kingdom with no context. Skip those.
  if (!family && !genus) { noFamily++; continue; }
  const rec = {
    scientificName: sci,
    phylum: nameOf(c[11]),
    class: nameOf(c[12]),
    order: nameOf(c[13]),
    family,
    genus,
    gbifKey: Number(c[0]),
    rank: c[5] === "SPECIES" ? "species" : "unranked",
  };
  out.write((n ? "," : "") + JSON.stringify(rec));
  n++;
  if (c[5] === "SPECIES") species++; else unranked++;
  if (n % 200_000 === 0) process.stdout.write(`  ${(n / 1e6).toFixed(2)}M written\n`);
}
out.write("]");
await new Promise((res) => out.end(res));

console.log(`\nWrote ${OUT_DIR}/species.json`);
console.log(`  total leaves: ${n.toLocaleString()}`);
console.log(`  species:      ${species.toLocaleString()}`);
console.log(`  unranked:     ${unranked.toLocaleString()} (kept only if photo/wiki at build time)`);
console.log(`  skipped (no family/genus to place): ${noFamily.toLocaleString()}`);
