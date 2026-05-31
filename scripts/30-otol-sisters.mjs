// Computes nearest sister species per IOC species using Open Tree of Life's
// Aves synthesis subtree. OToL's tree has no branch lengths (it's topology-
// only), so we use number-of-edges to the most recent common ancestor as a
// rough proximity measure instead of Mya.
//
// Used as a fallback when BirdTree's 2012 taxonomy missed the species — it
// covers many splits that postdate BirdTree.
//
// Output: data/sister-species-otol.json

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const AVES_OTT_ID = 81461;
const TREE_PATH = "data/otol-aves.nwk";
const OUT_PATH = "data/sister-species-otol.json";
const N_NEAREST = 6;

if (!existsSync(TREE_PATH)) {
  console.log(`Downloading OToL Aves subtree...`);
  const res = await fetch("https://api.opentreeoflife.org/v3/tree_of_life/subtree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ott_id: AVES_OTT_ID, format: "newick" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  await mkdir("data", { recursive: true });
  await writeFile(TREE_PATH, json.newick);
  console.log(`Saved ${((await stat(TREE_PATH)).size / 1e6).toFixed(1)} MB`);
}

const newick = (await readFile(TREE_PATH, "utf8")).trim();
const ioc = JSON.parse(await readFile("data/ioc-species.json", "utf8"));
const iocSet = new Set(ioc.map((s) => s.scientificName));

// Newick parser handling OToL's label suffix (_ottNNNN at the end of every
// labeled node). We strip the _ottNNNN to get the canonical taxon name.
function parseNewick(s) {
  let i = 0;
  let nextId = 0;
  function node() {
    const n = { id: nextId++, children: [], parent: null, name: "", length: 0 };
    if (s[i] === "(") {
      i++;
      n.children.push(node());
      while (s[i] === ",") { i++; n.children.push(node()); }
      i++; // consume )
    }
    let name = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") name += s[i++];
    n.name = name.trim().replace(/_ott\d+$/, "").replace(/_/g, " ");
    if (s[i] === ":") {
      i++;
      let len = "";
      while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") len += s[i++];
      n.length = parseFloat(len) || 0;
    }
    for (const c of n.children) c.parent = n;
    return n;
  }
  return node();
}

const root = parseNewick(newick);

// "Species" = a node whose stripped name is exactly two words (binomial).
// Subspecies and higher-rank clades have ≠ 2 words. This may be a SPECIES
// even if it has subspecies as children (internal node case).
function isSpecies(node) {
  const parts = (node.name || "").split(" ");
  return parts.length === 2 && /^[A-Z][a-z]+$/.test(parts[0]);
}

// Collect every species node + indexed by name.
const allSpeciesNodes = [];
function collect(n) {
  if (isSpecies(n)) allSpeciesNodes.push(n);
  for (const c of n.children) collect(c);
}
collect(root);
const speciesByName = new Map(allSpeciesNodes.map((n) => [n.name, n]));
const inIoc = allSpeciesNodes.filter((n) => iocSet.has(n.name)).length;
console.log(`OToL Aves species nodes: ${allSpeciesNodes.length}`);
console.log(`Of those in IOC:         ${inIoc}`);

// Collect species nodes below (or at) a subtree, paired with edge-distance.
function speciesBelow(node, dist) {
  const out = [];
  if (isSpecies(node)) out.push({ node, dist });
  for (const c of node.children) {
    for (const e of speciesBelow(c, dist + 1)) out.push(e);
  }
  return out;
}

// Same logic as our BirdTree script: walk up from focal, at each ancestor
// descend through siblings to enumerate their species at known edge distance.
function nearestSisters(focal, n) {
  const out = [];
  let cur = focal;
  let distUp = 0;
  while (cur.parent && out.length < n * 3) {
    distUp += 1;
    const parent = cur.parent;
    for (const sib of parent.children) {
      if (sib === cur) continue;
      for (const e of speciesBelow(sib, distUp + 1)) {
        if (e.node === focal) continue;
        if (iocSet.has(e.node.name)) out.push({ name: e.node.name, dist: e.dist });
      }
    }
    cur = parent;
  }
  out.sort((a, b) => a.dist - b.dist);
  const seen = new Set();
  const unique = [];
  for (const r of out) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    unique.push(r);
    if (unique.length >= n) break;
  }
  return unique;
}

const sisters = {};
let count = 0;
for (const sp of allSpeciesNodes) {
  if (!iocSet.has(sp.name)) continue;
  const list = nearestSisters(sp, N_NEAREST);
  if (list.length > 0) {
    sisters[sp.name] = list;
    count++;
  }
}
await writeFile(OUT_PATH, JSON.stringify(sisters));
console.log(`Wrote ${OUT_PATH} — ${count} species with sister data`);

const sample = Object.entries(sisters).slice(0, 3);
for (const [k, v] of sample) {
  console.log(`  ${k}: ${v.map((s) => `${s.name} (${s.dist})`).join(", ")}`);
}
