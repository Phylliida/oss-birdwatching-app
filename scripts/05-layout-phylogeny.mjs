// Parses data/phylogeny.nwk, computes a 2D rectangular-dendrogram layout
// for every node, and writes:
//   - data/phylo-layout.json  full tree with x,y per node
//   - data/phylo-preview.svg  scaled-down SVG so we can eyeball the shape
//
// X = distance from root in millions of years (sum of branch lengths).
// Y = tip order (post-order); internal nodes sit at the midpoint of their kids.

import { readFile, writeFile } from "node:fs/promises";

const newick = (await readFile("data/phylogeny.nwk", "utf8")).trim();

// --- Newick parser (recursive descent) ---------------------------------------
function parseNewick(s) {
  let i = 0;
  let nextId = 0;

  function parseNode() {
    const node = { id: nextId++, children: [], name: "", length: 0 };
    if (s[i] === "(") {
      i++;
      node.children.push(parseNode());
      while (s[i] === ",") {
        i++;
        node.children.push(parseNode());
      }
      if (s[i] !== ")") throw new Error(`expected ) at ${i}, got ${s[i]}`);
      i++;
    }
    // optional name (unquoted; BirdTree never quotes)
    let name = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") name += s[i++];
    node.name = name.trim();
    if (s[i] === ":") {
      i++;
      let len = "";
      while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") len += s[i++];
      node.length = parseFloat(len) || 0;
    }
    return node;
  }

  const root = parseNode();
  return root;
}

const root = parseNewick(newick);

// --- Layout ------------------------------------------------------------------
let tipCounter = 0;
let maxX = 0;
const nodes = [];

function layout(node, xParent) {
  node.x = xParent + node.length;
  if (node.x > maxX) maxX = node.x;
  if (node.children.length === 0) {
    node.y = tipCounter++;
  } else {
    for (const c of node.children) layout(c, node.x);
    const ys = node.children.map((c) => c.y);
    node.y = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  nodes.push(node);
}
layout(root, 0);

// Root is at x=0 but the deepest tip is at x=maxX (≈ tree depth in Mya).
// For a dendrogram we want time increasing leftward → tips on the right;
// transform so x=0 is the root and x=maxX is the present.
const tipCount = tipCounter;
const depthMya = maxX;
console.log(`Parsed ${nodes.length} nodes, ${tipCount} tips.`);
console.log(`Tree depth: ${depthMya.toFixed(2)} Mya`);
console.log(`Root id: ${root.id}, root children: ${root.children.length}`);

// --- Serializable form -------------------------------------------------------
// We strip back-references and produce {id, parent, x, y, name, children:[ids]}.
const parentOf = new Map();
function recordParents(node, parent) {
  parentOf.set(node.id, parent ? parent.id : null);
  for (const c of node.children) recordParents(c, node);
}
recordParents(root, null);

const flat = nodes
  .sort((a, b) => a.id - b.id)
  .map((n) => ({
    id: n.id,
    parent: parentOf.get(n.id),
    x: +n.x.toFixed(4),
    y: n.y,
    name: n.name || null,
    isTip: n.children.length === 0,
    children: n.children.map((c) => c.id),
  }));

await writeFile(
  "data/phylo-layout.json",
  JSON.stringify({ depthMya, tipCount, rootId: root.id, nodes: flat }),
);
console.log(`Wrote data/phylo-layout.json (${flat.length} nodes)`);

// --- SVG preview -------------------------------------------------------------
// Target preview: 1200px wide × 8000px tall so we can actually scroll it.
// At ~0.8 px/tip you can see clade structure but not individual tips — fine
// for sanity-checking the shape.
const W = 1200;
const H = 8000;
const PAD = 20;
const sx = (W - 2 * PAD) / depthMya;
const sy = (H - 2 * PAD) / tipCount;
const px = (x) => PAD + x * sx;
const py = (y) => PAD + y * sy;

const lines = [];
for (const n of nodes) {
  if (n.children.length === 0) continue;
  // vertical bar spanning children
  const ys = n.children.map((c) => c.y);
  lines.push(
    `<line x1="${px(n.x).toFixed(1)}" y1="${py(Math.min(...ys)).toFixed(1)}" ` +
      `x2="${px(n.x).toFixed(1)}" y2="${py(Math.max(...ys)).toFixed(1)}" />`,
  );
  // horizontal from this node to each child
  for (const c of n.children) {
    lines.push(
      `<line x1="${px(n.x).toFixed(1)}" y1="${py(c.y).toFixed(1)}" ` +
        `x2="${px(c.x).toFixed(1)}" y2="${py(c.y).toFixed(1)}" />`,
    );
  }
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <g stroke="#7ee787" stroke-width="0.4" fill="none">
    ${lines.join("\n    ")}
  </g>
  <text x="${PAD}" y="${H - 4}" fill="#888" font-family="monospace" font-size="12">
    BirdTree Hackett Stage2 tree #1 — ${tipCount} tips, ~${depthMya.toFixed(0)} Mya deep
  </text>
</svg>`;

await writeFile("data/phylo-preview.svg", svg);
console.log(`Wrote data/phylo-preview.svg (${(svg.length / 1024).toFixed(0)} KB)`);
console.log(`Open it in a browser: file://${process.cwd()}/data/phylo-preview.svg`);
