// OToL sister species. For taxa with a single OToL subtree, fetch it
// directly. For ones OToL has pruned (some classes), fall back to per-family.
//
// Usage:  TAXON=oaks node scripts/taxon/06-otol-sisters.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTaxon } from "../taxa.mjs";

const taxon = getTaxon(process.env.TAXON);
const OUT_PATH = `${taxon.dataDir}/sister-species-otol.json`;
const N_NEAREST = 6;

const species = JSON.parse(await readFile(`${taxon.dataDir}/species.json`, "utf8"));
const set = new Set(species.map((s) => s.scientificName));
await mkdir(taxon.dataDir, { recursive: true });

async function fetchSubtree(ottId, label) {
  const cache = `${taxon.dataDir}/otol-${label}.nwk`;
  if (existsSync(cache)) return (await readFile(cache, "utf8")).trim();
  console.log(`  Fetching ${label} subtree (ott ${ottId})...`);
  const res = await fetch("https://api.opentreeoflife.org/v3/tree_of_life/subtree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ott_id: ottId, format: "newick" }),
  });
  if (!res.ok) { console.warn(`    failed HTTP ${res.status}`); return null; }
  const json = await res.json();
  await writeFile(cache, json.newick);
  return json.newick.trim();
}

function parseNewick(s) {
  let i = 0, nextId = 0;
  function node() {
    const n = { id: nextId++, children: [], parent: null, name: "", length: 0 };
    if (s[i] === "(") { i++; n.children.push(node()); while (s[i] === ",") { i++; n.children.push(node()); } i++; }
    let name = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") name += s[i++];
    n.name = name.trim().replace(/_ott\d+$/, "").replace(/_/g, " ");
    if (s[i] === ":") { i++; let l = ""; while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") l += s[i++]; n.length = parseFloat(l) || 0; }
    for (const c of n.children) c.parent = n;
    return n;
  }
  return node();
}

let root;
if (taxon.otolFamilyMode) {
  // Stitch a virtual root over per-family subtrees (declared in taxa.mjs).
  const families = await Promise.all(
    Object.entries(taxon.otolFamilyOttIds || {}).map(async ([f, id]) => [f, await fetchSubtree(id, f)]),
  );
  const familyRoots = families.filter(([_, n]) => n).map(([f, n]) => parseNewick(n));
  root = { id: -1, name: taxon.rootName, children: familyRoots, parent: null, length: 0 };
  for (const c of root.children) c.parent = root;
} else {
  const nwk = await fetchSubtree(taxon.otolOttId, taxon.rootName);
  if (!nwk) { console.error("Couldn't fetch OToL subtree."); process.exit(1); }
  root = parseNewick(nwk);
}

const isSpecies = (n) => {
  const parts = (n.name || "").split(" ");
  return parts.length === 2 && /^[A-Z][a-z]+$/.test(parts[0]);
};
const all = [];
(function collect(n) { if (isSpecies(n)) all.push(n); for (const c of n.children) collect(c); })(root);

function speciesBelow(node, dist) {
  const out = [];
  if (isSpecies(node)) out.push({ node, dist });
  for (const c of node.children) for (const e of speciesBelow(c, dist + 1)) out.push(e);
  return out;
}
function nearestSisters(focal, n) {
  const out = [];
  let cur = focal, distUp = 0;
  while (cur.parent && out.length < n * 3) {
    distUp += 1;
    for (const sib of cur.parent.children) {
      if (sib === cur) continue;
      for (const e of speciesBelow(sib, distUp + 1)) {
        if (e.node === focal) continue;
        if (set.has(e.node.name)) out.push({ name: e.node.name, dist: e.dist });
      }
    }
    cur = cur.parent;
  }
  out.sort((a, b) => a.dist - b.dist);
  const seen = new Set(), unique = [];
  for (const r of out) { if (seen.has(r.name)) continue; seen.add(r.name); unique.push(r); if (unique.length >= n) break; }
  return unique;
}

const sisters = {};
for (const sp of all) {
  if (!set.has(sp.name)) continue;
  const list = nearestSisters(sp, N_NEAREST);
  if (list.length) sisters[sp.name] = list;
}
await writeFile(OUT_PATH, JSON.stringify(sisters));
console.log(`OToL species: ${all.length}, in dataset: ${all.filter((n) => set.has(n.name)).length}`);
console.log(`Wrote ${OUT_PATH} — ${Object.keys(sisters).length} species with sisters`);
