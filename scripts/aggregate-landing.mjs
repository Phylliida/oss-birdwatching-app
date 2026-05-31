// Walks each app's tree.json and extracts root-level info (name, count, image)
// into web/landing.json. The landing page consumes it to render real cards
// matching the sub-app card style.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const APPS = [
  { id: "aves",         path: "web/birds/tree.json",      href: "/birds/" },
  { id: "pinopsida",    path: "web/trees/tree.json",      href: "/trees/" },
  { id: "cycadopsida",  path: "web/cycads/tree.json",     href: "/cycads/" },
  { id: "ginkgoopsida", path: "web/ginkgo/tree.json",     href: "/ginkgo/" },
  { id: "gnetopsida",   path: "web/gnetales/tree.json",   href: "/gnetales/" },
  { id: "magnoliaceae", path: "web/magnolias/tree.json",  href: "/magnolias/" },
  { id: "lauraceae",    path: "web/laurels/tree.json",    href: "/laurels/" },
  { id: "arecaceae",    path: "web/palms/tree.json",      href: "/palms/" },
  { id: "quercus",      path: "web/oaks/tree.json",       href: "/oaks/" },
  { id: "betulaceae",   path: "web/birches/tree.json",    href: "/birches/" },
  { id: "acer",         path: "web/maples/tree.json",     href: "/maples/" },
  { id: "salicaceae",   path: "web/willows/tree.json",    href: "/willows/" },
  { id: "ficus",        path: "web/figs/tree.json",       href: "/figs/" },
  { id: "acacia",       path: "web/acacias/tree.json",    href: "/acacias/" },
  { id: "rosaceae",     path: "web/rosaceae/tree.json",   href: "/rosaceae/" },
  { id: "myrtaceae",    path: "web/myrtaceae/tree.json",  href: "/myrtaceae/" },
  { id: "eucalyptus",   path: "web/eucalypts/tree.json",  href: "/eucalypts/" },
];

const out = {};
for (const a of APPS) {
  if (!existsSync(a.path)) { console.warn(`Missing: ${a.path}`); continue; }
  let tree;
  // The pipeline may be mid-rewrite of another app's tree.json; tolerate a
  // transient unreadable/partial file rather than aborting the whole aggregate.
  try { tree = JSON.parse(await readFile(a.path, "utf8")); }
  catch (e) { console.warn(`Skipping ${a.path}: ${e.message}`); continue; }
  const root = tree.nodes[a.id];
  if (!root) { console.warn(`No root node ${a.id} in ${a.path}`); continue; }
  out[a.id] = {
    href: a.href,
    name: root.commonName || root.name,
    sciName: root.name,
    speciesCount: root.speciesCount,
    image: root.reprImg || null,
    wikiUrl: root.wikiUrl || null,
  };
}

// Abstract landing nodes (Animalia / Plantae / Gymnosperms / Angiosperms) get
// their own Wikipedia lead photo + article link from the higher-taxa cache.
let higher = {};
if (existsSync("data/higher-taxa-wiki.json")) {
  try { higher = JSON.parse(await readFile("data/higher-taxa-wiki.json", "utf8")); }
  catch { higher = {}; }
}
out._higher = {};
for (const [viewKey, cacheKey] of [
  ["animalia", "Animalia"],
  ["plantae", "Plantae"],
  ["gymnosperms", "Gymnosperms"],
  ["angiosperms", "Angiosperms"],
]) {
  const h = higher[cacheKey];
  out._higher[viewKey] = { image: h?.image || null, wikiUrl: h?.page || null };
}

await writeFile("web/landing.json", JSON.stringify(out, null, 2));
const appKeys = Object.keys(out).filter((k) => k !== "_higher");
console.log(`Wrote web/landing.json — ${appKeys.length} apps`);
for (const k of appKeys) {
  const v = out[k];
  console.log(`  ${k.padEnd(15)} ${String(v.speciesCount).padStart(6)} sp ${v.image ? "✓" : "✗"}${v.wikiUrl ? " wiki" : ""}`);
}
for (const [k, v] of Object.entries(out._higher)) {
  console.log(`  ${("_" + k).padEnd(15)} ${v.image ? "img" : "   "} ${v.wikiUrl ? "wiki" : ""}`);
}
