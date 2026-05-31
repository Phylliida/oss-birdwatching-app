// Renders the bird phylogeny as an organic radial tree:
//   - root at center, tips on outer ring
//   - branches drawn as Bezier curves for an organic feel
//   - tips colored by IOC order (40-ish bird orders, evenly-hued palette)
//   - internal branches in muted gray; branches inherit color near the tips
//
// Output: data/phylo-radial.svg (single big SVG, ~4000x4000).

import { readFile, writeFile } from "node:fs/promises";

const newick = (await readFile("data/phylogeny.nwk", "utf8")).trim();
const taxCsv = await readFile("data/birdtree-taxonomy.csv", "utf8");

// --- tip -> order map from BirdTree taxonomy CSV -----------------------------
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { cells.push(cur); cur = ""; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

const orderOf = new Map();
const lines = taxCsv.split(/\r?\n/);
const header = parseCsvLine(lines[0]);
const tipIdx = header.indexOf("TipLabel");
const ordIdx = header.indexOf("IOCOrder");
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const cells = parseCsvLine(lines[i]);
  if (cells[tipIdx]) orderOf.set(cells[tipIdx], cells[ordIdx] || "UNKNOWN");
}
const orders = [...new Set(orderOf.values())].sort();
console.log(`Loaded ${orderOf.size} tip→order mappings across ${orders.length} orders`);

// Evenly-spaced HSL palette for orders. Skew saturation/lightness for a
// painterly look against a dark background.
const orderColor = new Map();
orders.forEach((o, i) => {
  const h = Math.round((i * 360) / orders.length);
  orderColor.set(o, `hsl(${h} 70% 62%)`);
});

// --- Newick parser -----------------------------------------------------------
function parseNewick(s) {
  let i = 0;
  let nextId = 0;
  function node() {
    const n = { id: nextId++, children: [], name: "", length: 0 };
    if (s[i] === "(") {
      i++;
      n.children.push(node());
      while (s[i] === ",") { i++; n.children.push(node()); }
      i++;
    }
    let nm = "";
    while (i < s.length && !":,()".includes(s[i]) && s[i] !== ";") nm += s[i++];
    n.name = nm.trim();
    if (s[i] === ":") {
      i++;
      let l = "";
      while (i < s.length && !",()".includes(s[i]) && s[i] !== ";") l += s[i++];
      n.length = parseFloat(l) || 0;
    }
    return n;
  }
  return node();
}

const root = parseNewick(newick);

// --- Layout (radial) ---------------------------------------------------------
// Y becomes angle (radians); X becomes radius from center.
let tipIdx2 = 0;
let tipTotal = 0;
function countTips(n) {
  if (n.children.length === 0) { tipTotal++; return; }
  for (const c of n.children) countTips(c);
}
countTips(root);

let maxDepth = 0;
function assignDepth(n, d) {
  n.depth = d + n.length;
  if (n.depth > maxDepth) maxDepth = n.depth;
  for (const c of n.children) assignDepth(c, n.depth);
}
assignDepth(root, 0);

function assignAngle(n) {
  if (n.children.length === 0) {
    n.angle = (tipIdx2 / tipTotal) * Math.PI * 2;
    tipIdx2++;
    return n.angle;
  }
  const childAngles = n.children.map(assignAngle);
  n.angle = (Math.min(...childAngles) + Math.max(...childAngles)) / 2;
  return n.angle;
}
assignAngle(root);

console.log(`Tips: ${tipTotal}, depth: ${maxDepth.toFixed(2)} Mya`);

// --- Subtree size for tapered widths ----------------------------------------
function countDescendants(n) {
  if (n.children.length === 0) { n.descendants = 1; return 1; }
  let sum = 0;
  for (const c of n.children) sum += countDescendants(c);
  n.descendants = sum;
  return sum;
}
countDescendants(root);

// --- Color propagation -------------------------------------------------------
// Each node gets `dominantOrder` = if all descendant tips share an order, use
// that; otherwise null (=> neutral gray). Lets clade colors flood "down" the
// tree and only fade to gray at deep internal nodes.
function annotateColor(n) {
  if (n.children.length === 0) {
    n.dominantOrder = orderOf.get(n.name) || null;
    return n.dominantOrder;
  }
  const childOrders = n.children.map(annotateColor);
  const first = childOrders[0];
  n.dominantOrder = childOrders.every((o) => o === first) ? first : null;
  return n.dominantOrder;
}
annotateColor(root);

// --- SVG render --------------------------------------------------------------
const SIZE = 4000;
const CX = SIZE / 2;
const CY = SIZE / 2;
const MARGIN = 60;
const R_MAX = SIZE / 2 - MARGIN;
const radiusOf = (depth) => (depth / maxDepth) * R_MAX;
const xy = (depth, angle) => {
  const r = radiusOf(depth);
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
};

// Branch geometry: cubic Bezier from parent to child, with control points
// pulled radially outward at each end. This makes branches "flow" out of the
// parent like growing tendrils instead of right-angling around polar arcs.
// Width tapers with descendant count: trunk-thick at junctions of huge clades,
// thin at terminal twigs — same trick rivers/dendrograms use to encode size.
const branches = [];
function widthFor(node) {
  // 1 tip => ~0.4 px; 9993 tips (root) => ~6 px. Smooth log/sqrt curve.
  return 0.4 + Math.sqrt(node.descendants) * 0.06;
}
function walk(n) {
  for (const c of n.children) {
    const [px, py] = xy(n.depth, n.angle);
    const [tx, ty] = xy(c.depth, c.angle);
    // Tangent direction: radially outward at each endpoint.
    const lenRadial = Math.max(2, radiusOf(c.depth) - radiusOf(n.depth));
    const handle = lenRadial * 0.55;
    const cp1x = px + handle * Math.cos(n.angle);
    const cp1y = py + handle * Math.sin(n.angle);
    const cp2x = tx - handle * Math.cos(c.angle);
    const cp2y = ty - handle * Math.sin(c.angle);

    const color = c.dominantOrder ? orderColor.get(c.dominantOrder) : "#3a4655";
    // Width transitions from parent's width to child's width — approximate by
    // drawing the path with the child's width (looks fine because each segment
    // is short relative to the change).
    const w = widthFor(c);
    branches.push(
      `<path d="M${px.toFixed(1)},${py.toFixed(1)} ` +
        `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ` +
        `${cp2x.toFixed(1)},${cp2y.toFixed(1)} ` +
        `${tx.toFixed(1)},${ty.toFixed(1)}" ` +
        `stroke="${color}" stroke-width="${w.toFixed(2)}" fill="none" ` +
        `stroke-linecap="round" stroke-linejoin="round" />`,
    );
    walk(c);
  }
}
walk(root);

// Tip dots (colored by order). Subtle so the branches lead the eye, not the dots.
const dots = [];
function collectTips(n) {
  if (n.children.length === 0) {
    const [x, y] = xy(n.depth, n.angle);
    const col = n.dominantOrder ? orderColor.get(n.dominantOrder) : "#888";
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.4" fill="${col}" />`);
    return;
  }
  for (const c of n.children) collectTips(c);
}
collectTips(root);

// Legend: just the major orders by tip count so we know which color is which.
const orderCounts = new Map();
for (const o of orderOf.values()) orderCounts.set(o, (orderCounts.get(o) || 0) + 1);
const topOrders = [...orderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
const legend = topOrders
  .map(([o, n], i) => {
    const y = 80 + i * 22;
    return (
      `<rect x="40" y="${y - 12}" width="14" height="14" fill="${orderColor.get(o)}" />` +
      `<text x="62" y="${y}" fill="#ddd" font-family="sans-serif" font-size="14">${o} (${n})</text>`
    );
  })
  .join("\n  ");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#0e1822"/>
      <stop offset="100%" stop-color="#050a10"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <g opacity="0.95">
    ${branches.join("\n    ")}
  </g>
  <g>
    ${dots.join("\n    ")}
  </g>
  ${legend}
  <text x="40" y="50" fill="#fff" font-family="sans-serif" font-size="22" font-weight="700">
    Birds of the World — ${tipTotal} species across ${orders.length} orders
  </text>
</svg>`;

await writeFile("data/phylo-radial.svg", svg);
console.log(`Wrote data/phylo-radial.svg (${(svg.length / 1024).toFixed(0)} KB)`);
console.log(`View: file://${process.cwd()}/data/phylo-radial.svg`);
