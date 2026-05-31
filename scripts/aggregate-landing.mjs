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
  const tree = JSON.parse(await readFile(a.path, "utf8"));
  const root = tree.nodes[a.id];
  if (!root) { console.warn(`No root node ${a.id} in ${a.path}`); continue; }
  out[a.id] = {
    href: a.href,
    name: root.commonName || root.name,
    sciName: root.name,
    speciesCount: root.speciesCount,
    image: root.reprImg || null,
  };
}

await writeFile("web/landing.json", JSON.stringify(out, null, 2));
console.log(`Wrote web/landing.json — ${Object.keys(out).length} apps`);
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k.padEnd(15)} ${String(v.speciesCount).padStart(6)} sp ${v.image ? "✓" : "✗"}`);
}
