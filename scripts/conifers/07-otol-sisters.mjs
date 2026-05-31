// Sister species for conifers from Open Tree of Life. Same approach as the
// bird script: download Pinopsida subtree from OToL, parse Newick, compute
// sisters by edge distance to MRCA.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT_PATH = "data/conifers/sister-species-otol.json";
const N_NEAREST = 6;

// OToL prunes Pinopsida class (contested placement), so we fetch family-level
// subtrees one at a time. Cross-family sisters aren't representable this way,
// but that's fine — most sister relationships are within-family anyway.
const FAMILY_OTT_IDS = {
  Pinaceae: 994067,
  Cupressaceae: 620757,
  Podocarpaceae: 620760,
  Araucariaceae: 786678,
  Taxaceae: 807158,
  Cephalotaxaceae: null,  // resolve on first call
  Phyllocladaceae: null,
  Sciadopityaceae: null,
};

async function ensureOttIds() {
  const missing = Object.entries(FAMILY_OTT_IDS).filter(([_, v]) => v == null).map(([k]) => k);
  if (missing.length === 0) return;
  const res = await fetch("https://api.opentreeoflife.org/v3/tnrs/match_names", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names: missing }),
  });
  const j = await res.json();
  for (const r of j.results) {
    for (const m of r.matches) {
      if (FAMILY_OTT_IDS[m.taxon.name] === null) FAMILY_OTT_IDS[m.taxon.name] = m.taxon.ott_id;
    }
  }
}

const species = JSON.parse(await readFile("data/conifers/species.json", "utf8"));
const set = new Set(species.map((s) => s.scientificName));
await mkdir("data/conifers", { recursive: true });
await ensureOttIds();

async function fetchFamilyTree(family, ottId) {
  if (!ottId) return null;
  const cachePath = `data/conifers/otol-${family}.nwk`;
  if (existsSync(cachePath)) return (await readFile(cachePath, "utf8")).trim();
  console.log(`  Fetching ${family} subtree (ott ${ottId})...`);
  const res = await fetch("https://api.opentreeoflife.org/v3/tree_of_life/subtree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ott_id: ottId, format: "newick" }),
  });
  if (!res.ok) {
    console.warn(`    ${family} subtree fetch failed: HTTP ${res.status}`);
    return null;
  }
  const json = await res.json();
  await writeFile(cachePath, json.newick);
  return json.newick.trim();
}

// Build one combined virtual root from all family trees, then walk each
// species' subtree as before. Cross-family species won't share an ancestor
// in this combined view (the root just has each family as a child), so
// sisters are effectively within-family only.
function parseNewick(s) {
  let i = 0, nextId = 0;
  function node() {
    const n = { id: nextId++, children: [], parent: null, name: "", length: 0 };
    if (s[i] === "(") {
      i++;
      n.children.push(node());
      while (s[i] === ",") { i++; n.children.push(node()); }
      i++;
    }
    let name = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") name += s[i++];
    n.name = name.trim().replace(/_ott\d+$/, "").replace(/_/g, " ");
    if (s[i] === ":") {
      i++;
      let l = "";
      while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") l += s[i++];
      n.length = parseFloat(l) || 0;
    }
    for (const c of n.children) c.parent = n;
    return n;
  }
  return node();
}
// Stitch all family trees into one virtual root.
const families = await Promise.all(
  Object.entries(FAMILY_OTT_IDS).map(async ([f, id]) => [f, await fetchFamilyTree(f, id)]),
);
const familyRoots = families.filter(([_, nwk]) => nwk).map(([f, nwk]) => parseNewick(nwk));
const root = { id: -1, name: "Pinopsida", children: familyRoots, parent: null, length: 0 };
for (const c of root.children) c.parent = root;

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
console.log(`OToL Pinopsida species nodes: ${all.length}`);
console.log(`In conifer dataset:           ${all.filter((n) => set.has(n.name)).length}`);
console.log(`Wrote ${OUT_PATH} — ${Object.keys(sisters).length} species with sisters`);
