// Computes nearest sister species for every IOC species that has an exact
// name match in the BirdTree phylogeny. Reads data/phylogeny.nwk (one tree
// from Jetz et al.) and walks each tip's parent chain, collecting the closest
// distinct tips up to a target count.
//
// Output: data/sister-species.json — { "Genus species": [{ name, mya }, ...] }
// where `mya` is the branch distance from the focal tip to the sister tip
// through their most recent common ancestor (in millions of years).

import { readFile, writeFile } from "node:fs/promises";

const N_NEAREST = 6;
const newick = (await readFile("data/phylogeny.nwk", "utf8")).trim();
const ioc = JSON.parse(await readFile("data/ioc-species.json", "utf8"));
const iocSet = new Set(ioc.map((s) => s.scientificName));

// --- Newick parser (mirrors scripts/05) ---
function parseNewick(s) {
  let i = 0;
  let nextId = 0;
  function parseNode() {
    const node = { id: nextId++, children: [], parent: null, name: "", length: 0 };
    if (s[i] === "(") {
      i++;
      node.children.push(parseNode());
      while (s[i] === ",") { i++; node.children.push(parseNode()); }
      i++; // consume )
    }
    let name = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") name += s[i++];
    node.name = name.trim();
    if (s[i] === ":") {
      i++;
      let len = "";
      while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") len += s[i++];
      node.length = parseFloat(len) || 0;
    }
    for (const c of node.children) c.parent = node;
    return node;
  }
  return parseNode();
}

const root = parseNewick(newick);

// Collect all tips + a tip→tip map by display name.
const allTips = [];
function collect(n) {
  if (n.children.length === 0) allTips.push(n);
  else for (const c of n.children) collect(c);
}
collect(root);

const tipByName = new Map();
for (const t of allTips) tipByName.set(t.name.replace(/_/g, " "), t);
console.log(`Tips: ${allTips.length}; tips with IOC name match: ${[...tipByName.keys()].filter((n) => iocSet.has(n)).length}`);

// For each subtree, total branch length from the subtree root to any tip
// follows a simple recursion. We need per-pair distances though, so for each
// focal tip we walk up parents and accumulate path length, descending into
// each new sibling subtree to enumerate its tips at known distances.
function tipsBelowWithDistance(node, distSoFar) {
  if (node.children.length === 0) return [{ tip: node, dist: distSoFar }];
  const out = [];
  for (const c of node.children) {
    for (const e of tipsBelowWithDistance(c, distSoFar + c.length)) out.push(e);
  }
  return out;
}

function nearestSisters(focal, n) {
  // Walk up from focal, at each ancestor descend through siblings to enumerate
  // their tips with cumulative distance through the MRCA. Stop once we have
  // enough sister tips that also exist in IOC.
  const out = [];
  let cur = focal;
  let distUp = 0;
  while (cur.parent && out.length < n) {
    distUp += cur.length;
    const parent = cur.parent;
    for (const sib of parent.children) {
      if (sib === cur) continue;
      for (const e of tipsBelowWithDistance(sib, distUp + sib.length)) {
        const iocName = e.tip.name.replace(/_/g, " ");
        if (iocSet.has(iocName)) out.push({ name: iocName, mya: e.dist });
      }
    }
    cur = parent;
  }
  out.sort((a, b) => a.mya - b.mya);
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
let computed = 0;
for (const iocName of iocSet) {
  const tip = tipByName.get(iocName);
  if (!tip) continue;
  const list = nearestSisters(tip, N_NEAREST);
  if (list.length > 0) {
    sisters[iocName] = list.map((s) => ({ name: s.name, mya: +s.mya.toFixed(2) }));
    computed++;
  }
}

await writeFile("data/sister-species.json", JSON.stringify(sisters));
console.log(`Wrote data/sister-species.json — ${computed} species with sister data`);

// Quick sample for sanity.
const sample = Object.entries(sisters).slice(0, 3);
for (const [k, v] of sample) {
  console.log(`  ${k}: ${v.map((s) => `${s.name} (${s.mya} Mya)`).join(", ")}`);
}
