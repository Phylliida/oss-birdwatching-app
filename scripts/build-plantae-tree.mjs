// Build the unified, lazily-loaded plant tree under web/plantae/.
//
// The plant kingdom is far too big to ship as one skeleton (436K species), so
// we split it: a "trunk" (tree.json) holds every node down to GENUS and loads
// up front; each genus's species live in their own chunk (chunks/<genusId>.json)
// fetched only when the user opens that genus. The shared shell understands the
// `lazy: true` flag and loads a genus's chunk on navigation.
//
// Faithful to GBIF's accepted backbone: we keep every accepted species (no
// data-signal filter) so the tree represents the kingdom as-is; photos / names /
// IUCN / summaries fill in wherever the data sources have them.
//
// Usage:  node scripts/build-plantae-tree.mjs

import { readFile, writeFile, mkdir, readdir, unlink, copyFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";

const DATA = "data/plantae";
const WEB = "web/plantae";
const ROOT_ID = "plantae";

const loadJson = async (p) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null);

const species = JSON.parse(await readFile(`${DATA}/species.json`, "utf8"));
const wikidata = (await loadJson(`${DATA}/wikidata.json`)) || {};
const wiki = (await loadJson(`${DATA}/wiki.json`)) || {};
const gbif = (await loadJson(`${DATA}/gbif.json`)) || {};
const inat = (await loadJson(`${DATA}/inat.json`)) || {};
const higher = (await loadJson("data/higher-taxa-wiki.json")) || {};
// Kew WCUPS use categories (HF=human food, PO=poison, ME=medicine, …), keyed
// by binomial — see scripts/parse-wcups.py. CC BY, RBG Kew.
const wcups = (await loadJson("data/edibility/wcups.json")) || {};
// PFAF edibility rating + how-to-eat + known hazards — see scripts/parse-pfaf.mjs.
// CC BY-NC-SA, Plants For A Future (prominent link kept in the UI).
const pfaf = (await loadJson("data/edibility/pfaf.json")) || {};
// Year of first description — see scripts/parse-gbif-years.mjs (GBIF backbone, CC BY).
const years = (await loadJson("data/described-years.json")) || {};
console.log(`Loaded ${species.length.toLocaleString()} species; wikidata ${Object.keys(wikidata).length.toLocaleString()}, wiki ${Object.keys(wiki).length.toLocaleString()}, gbif ${Object.keys(gbif).length.toLocaleString()}, inat ${Object.keys(inat).length.toLocaleString()}`);

// Upgrade iNat photo URLs to the 1024px "large" variant.
function largeInat(url) {
  if (!url) return url;
  return url.replace(/\/(square|small|medium)\.(jpe?g|png|webp|gif)(\?|$|#)/i, "/large.$2$3");
}

// Prefer a locally-downloaded copy (data/images/inat-<id>.<ext>, served at
// /images/) when present — that's the offline path; otherwise stream the large
// version from iNaturalist. See scripts/download-inat-photos.mjs.
const localImages = new Set(existsSync("data/images") ? readdirSync("data/images") : []);
function resolveInat(url) {
  const m = url && url.match(/\/photos\/(\d+)\/\w+\.(\w+)/);
  if (m) {
    const fn = `inat-${m[1]}.${m[2].toLowerCase()}`;
    if (localImages.has(fn)) return `/images/${fn}`;
  }
  return largeInat(url);
}
// Wikimedia Commons can rasterise TIFF / SVG / PDF originals to a JPEG thumbnail
// via ?width= — browsers can't render those formats directly. Other Commons
// images pass through unchanged (just https).
function commonsImg(url) {
  if (!url) return null;
  url = url.replace(/^http:\/\//, "https://");
  if (/\.(tiff?|svg|pdf)$/i.test(url.split("?")[0])) url += (url.includes("?") ? "&" : "?") + "width=1024";
  return url;
}

const MIN_COUNTRY_OBS = 10;
function countriesFor(name) {
  const g = gbif[name];
  if (!g || !g.facets || !g.facets.country) return [];
  return g.facets.country.filter((c) => c.count >= MIN_COUNTRY_OBS && c.name !== "ZZ").map((c) => c.name);
}
function distillGbif(name) {
  const g = gbif[name];
  if (!g || !g.total) return null;
  const trim = (a, n) => (a || []).slice(0, n);
  return {
    total: g.total,
    country: g.facets.country || [],
    stateProvince: trim(g.facets.stateProvince, 30),
    continent: g.facets.continent || [],
    month: g.facets.month || [],
    year: trim(g.facets.year, 30),
    establishmentMeans: g.facets.establishmentMeans || [],
  };
}

const slug = (s) => String(s).replace(/\s+/g, "-").replace(/[^A-Za-z0-9-]/g, "");
const nodes = new Map();
// Create a node once and link it to its parent ONLY on creation, so every node
// has exactly one parent — a strict tree, not a DAG. (A handful of genus names
// GBIF files under two different families would otherwise double-count; the
// genus keeps whichever family it was first seen under.)
function ensureNode(id, parentId, init) {
  let n = nodes.get(id);
  if (n) return n;
  n = { id, parent: parentId, ...init, children: [] };
  nodes.set(id, n);
  if (parentId != null) nodes.get(parentId).children.push(id);
  return n;
}

ensureNode(ROOT_ID, null, { type: "root", name: "Plantae", commonName: "Plants" });

const RANK_PREFIX = { phylum: "p", class: "c", order: "o", family: "f", genus: "g" };

for (const sp of species) {
  // Walk the lineage chain, skipping any rank GBIF left null so the tree stays
  // connected (e.g. attach order directly under phylum when class is missing).
  const chain = [
    ["phylum", sp.phylum], ["class", sp.class], ["order", sp.order],
    ["family", sp.family], ["genus", sp.genus],
  ].filter(([, name]) => name);
  let parentId = ROOT_ID;
  for (const [rank, name] of chain) {
    const id = `${RANK_PREFIX[rank]}-${slug(name)}`;
    ensureNode(id, parentId, { type: rank, name });
    parentId = id;
  }
  const genusId = parentId; // chain always ends at genus (family+genus guaranteed)

  const wd = wikidata[sp.scientificName];
  const inatRec = inat[sp.scientificName];
  const inatPhotos = inatRec && inatRec.photos && inatRec.photos.length
    ? inatRec.photos.map((p) => ({ ...p, url: resolveInat(p.url) })) : null;
  // Primary photo: Wikidata/Commons if we have it, else fall back to the first
  // iNat photo so the card thumbnail isn't blank.
  let image = wd && wd.image ? commonsImg(wd.image) : null;
  let imageSource = image ? "commons" : null;
  let imageAttribution = null;
  let extraPhotos = inatPhotos;
  if (!image && inatPhotos) {
    image = inatPhotos[0].url;
    imageSource = "inat";
    imageAttribution = inatPhotos[0].attribution || null;
    extraPhotos = inatPhotos.length > 1 ? inatPhotos.slice(1) : null;
  }
  const altNames = (() => {
    const m = wd && wd.names; if (!m) return null;
    const out = { ...m }; delete out.en;
    return Object.keys(out).length ? out : null;
  })();
  ensureNode(`s-${slug(sp.scientificName)}`, genusId, {
    type: "species",
    name: sp.scientificName,
    commonName: (wd && wd.names && wd.names.en) || null,
    image,
    imageSource,
    imageAttribution,
    countries: countriesFor(sp.scientificName),
    observations: distillGbif(sp.scientificName),
    wiki: wiki[sp.scientificName] || null,
    iucn: (wd && wd.iucn) || null,
    altNames,
    extraPhotos,
    inatId: (inatRec && inatRec.taxonId) || null,
    uses: wcups[sp.scientificName] || null,
    pfaf: pfaf[sp.scientificName] || null,
    describedYear: (years[sp.scientificName] || {}).year || null,
    describedBy: (years[sp.scientificName] || {}).author || null,
    gbifKey: sp.gbifKey,
  });
}

console.log(`Built ${nodes.size.toLocaleString()} nodes`);

// Sort children by display name.
for (const n of nodes.values()) {
  n.children.sort((a, b) => {
    const an = nodes.get(a).commonName || nodes.get(a).name;
    const bn = nodes.get(b).commonName || nodes.get(b).name;
    return an.localeCompare(bn);
  });
}

// speciesCount per node.
function speciesCount(id) {
  const n = nodes.get(id);
  if (n.type === "species") return 1;
  if (n._count != null) return n._count;
  let sum = 0;
  for (const c of n.children) sum += speciesCount(c);
  n._count = sum;
  return sum;
}
speciesCount(ROOT_ID);
for (const n of nodes.values()) { if (n._count != null) n.speciesCount = n._count; delete n._count; }

// reprImg: a node's own Wikipedia photo if we have one, else first descendant.
function ownWiki(n) {
  const p = higher.plant || {};
  return p[n.name] || (n.commonName ? p[n.commonName] : null) || null;
}
const reprImg = new Map();
function computeReprImg(id) {
  if (reprImg.has(id)) return reprImg.get(id);
  const n = nodes.get(id);
  if (n.type === "species") { reprImg.set(id, n.image || null); return n.image || null; }
  let img = null;
  for (const c of n.children) { const r = computeReprImg(c); if (r && !img) img = r; }
  reprImg.set(id, img);
  return img;
}
computeReprImg(ROOT_ID);

// ---- Emit trunk (down to genus) + one chunk per genus ---------------------
await mkdir(`${WEB}/chunks`, { recursive: true });
for (const f of await readdir(`${WEB}/chunks`).catch(() => [])) {
  if (f.endsWith(".json")) await unlink(`${WEB}/chunks/${f}`);
}

const trunk = {};
const chunks = new Map(); // genusId -> { speciesId: fullNode }

for (const n of nodes.values()) {
  if (n.type === "species") {
    // Goes into its genus's chunk as a full node (light fields + heavy detail).
    const heavy = { id: n.id, type: "species", name: n.name, parent: n.parent };
    if (n.commonName) heavy.commonName = n.commonName;
    if (n.image) heavy.image = n.image;
    for (const k of ["countries", "observations", "wiki", "iucn", "altNames", "extraPhotos", "inatId", "uses", "pfaf", "describedYear", "describedBy", "gbifKey", "imageSource", "imageAttribution"]) {
      const v = n[k];
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      heavy[k] = v;
    }
    if (!chunks.has(n.parent)) chunks.set(n.parent, {});
    chunks.get(n.parent)[n.id] = heavy;
  } else {
    const light = { id: n.id, type: n.type, name: n.name, parent: n.parent };
    if (n.commonName) light.commonName = n.commonName;
    if (n.id === ROOT_ID) light.displayRank = "Kingdom";
    if (n.speciesCount) light.speciesCount = n.speciesCount;
    const w = ownWiki(n);
    const r = (w && w.image) || reprImg.get(n.id);
    if (r) light.reprImg = r;
    if (w && w.page) { light.wikiUrl = w.page; if (w.title) light.wikiTitle = w.title; if (w.extract) light.wikiExtract = w.extract; }
    if (n.type === "genus") {
      // Leaf of the trunk: its species live in a chunk, fetched on demand.
      light.chunkId = n.id;
      light.lazyChildren = true;
    } else {
      light.children = n.children; // internal nodes keep their child list
    }
    trunk[n.id] = light;
  }
}

await writeFile(`${WEB}/tree.json`, JSON.stringify({ generatedAt: new Date().toISOString(), lazy: true, root: ROOT_ID, nodes: trunk }));

let totalChunkBytes = 0;
for (const [genusId, data] of chunks) {
  const json = JSON.stringify(data);
  totalChunkBytes += json.length;
  await writeFile(`${WEB}/chunks/${genusId}.json`, json);
}

for (const f of ["index.html", "app.js", "style.css"]) {
  if (existsSync(`web/_shell/${f}`)) await copyFile(`web/_shell/${f}`, `${WEB}/${f}`);
}

const trunkBytes = JSON.stringify(trunk).length;
console.log(`Wrote ${WEB}/tree.json — trunk ${(trunkBytes / 1e6).toFixed(2)} MB (${Object.keys(trunk).length.toLocaleString()} nodes down to genus)`);
console.log(`Wrote ${chunks.size.toLocaleString()} genus chunks (${(totalChunkBytes / 1e6).toFixed(1)} MB total, avg ${(totalChunkBytes / chunks.size / 1024).toFixed(1)} KB)`);
const withPhoto = [...nodes.values()].filter((n) => n.type === "species" && n.image).length;
console.log(`Species with photo: ${withPhoto.toLocaleString()} / ${species.length.toLocaleString()} (${(withPhoto / species.length * 100).toFixed(1)}%)`);
