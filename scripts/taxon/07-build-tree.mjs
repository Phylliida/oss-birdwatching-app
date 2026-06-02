// Build skeleton + chunks for a taxon under web/{webDir}/.
// Usage:  TAXON=oaks node scripts/taxon/07-build-tree.mjs

import { readFile, writeFile, mkdir, readdir, unlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTaxon } from "../taxa.mjs";

const taxon = getTaxon(process.env.TAXON);
const CHUNK_THRESHOLD = 1000;

const rawSpecies = JSON.parse(await readFile(`${taxon.dataDir}/species.json`, "utf8"));
const wikidata = existsSync(`${taxon.dataDir}/wikidata.json`)
  ? JSON.parse(await readFile(`${taxon.dataDir}/wikidata.json`, "utf8")) : {};
const wiki = existsSync(`${taxon.dataDir}/wiki.json`)
  ? JSON.parse(await readFile(`${taxon.dataDir}/wiki.json`, "utf8")) : {};
const gbif = existsSync(`${taxon.dataDir}/gbif.json`)
  ? JSON.parse(await readFile(`${taxon.dataDir}/gbif.json`, "utf8")) : {};
const sistersOtol = existsSync(`${taxon.dataDir}/sister-species-otol.json`)
  ? JSON.parse(await readFile(`${taxon.dataDir}/sister-species-otol.json`, "utf8")) : {};
const inat = existsSync(`${taxon.dataDir}/inat.json`)
  ? JSON.parse(await readFile(`${taxon.dataDir}/inat.json`, "utf8")) : {};

const MIN_COUNTRY_OBS = 10;
function countriesFor(name) {
  const g = gbif[name];
  if (!g?.facets?.country) return [];
  return g.facets.country.filter((c) => c.count >= MIN_COUNTRY_OBS && c.name !== "ZZ").map((c) => c.name);
}
function distillGbif(name) {
  const g = gbif[name];
  if (!g?.total) return null;
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

const EXTINCT = new Set(taxon.extinctFamilies || []);
const EXCLUDE_GENERA = new Set(taxon.excludeGenera || []);

// Filter species: extant families need any data; extinct need wiki+image.
const species = [];
const stats = { extinctEmpty: 0, extantEmpty: 0, kept: 0, keptExtinct: 0, excludedGenus: 0 };
for (const sp of rawSpecies) {
  if (EXCLUDE_GENERA.has(sp.genus)) { stats.excludedGenus++; continue; }
  const wd = wikidata[sp.scientificName];
  const w = wiki[sp.scientificName];
  const g = gbif[sp.scientificName];
  const i = inat[sp.scientificName];
  const hasWiki = !!w;
  const hasImage = !!wd?.image;
  const realNames = Object.entries(wd?.names || {}).filter(([_, v]) => v && v !== sp.scientificName);
  const hasInat = i?.photos?.length > 0;
  const hasAny = hasWiki || hasImage || !!wd?.iucn || realNames.length > 0 || (g?.total > 0) || hasInat;
  const extinct = EXTINCT.has(sp.family);
  if (extinct) {
    if (hasWiki && hasImage) { species.push(sp); stats.keptExtinct++; }
    else stats.extinctEmpty++;
  } else {
    if (hasAny) { species.push(sp); stats.kept++; }
    else stats.extantEmpty++;
  }
}
console.log(`Filtered ${rawSpecies.length} → ${species.length} species`);
console.log(`  Kept extant: ${stats.kept}, kept extinct (w/ wiki+img): ${stats.keptExtinct}`);
console.log(`  Dropped extinct empty: ${stats.extinctEmpty}, extant empty: ${stats.extantEmpty}, excluded genus: ${stats.excludedGenus}`);

const slug = (s) => s.replace(/\s+/g, "-");
const nodes = new Map();
function getOrCreate(id, init) { if (!nodes.has(id)) nodes.set(id, { id, ...init, children: [] }); return nodes.get(id); }

getOrCreate(taxon.rootId, { type: "root", name: taxon.rootName, commonName: taxon.commonName, parent: null });

for (const sp of species) {
  const familyId = `f-${slug(sp.family)}`;
  const genusId = `g-${slug(sp.genus)}`;
  const speciesId = `s-${slug(sp.scientificName)}`;
  const familyNode = getOrCreate(familyId, { type: "family", name: sp.family, parent: taxon.rootId });
  const genusNode = getOrCreate(genusId, { type: "genus", name: sp.genus, parent: familyId });
  const wd = wikidata[sp.scientificName];
  let image = wd?.image ? wd.image.replace(/^http:\/\//, "https://") : null;
  const inatRec = inat[sp.scientificName];
  const speciesNode = getOrCreate(speciesId, {
    type: "species",
    name: sp.scientificName,
    commonName: wd?.names?.en || null,
    parent: genusId,
    image,
    imageSource: image ? "commons" : null,
    countries: countriesFor(sp.scientificName),
    observations: distillGbif(sp.scientificName),
    wiki: wiki[sp.scientificName] || null,
    iucn: wd?.iucn || null,
    altNames: (() => {
      const m = wd?.names; if (!m) return null;
      const out = { ...m }; delete out.en;
      return Object.keys(out).length ? out : null;
    })(),
    sisters: (sistersOtol[sp.scientificName] || []).map((s) => ({ name: s.name, edges: s.dist, source: "otol" })).slice(0, 6) || null,
    extraPhotos: inatRec?.photos?.length ? inatRec.photos : null,
    inatId: inatRec?.taxonId || null,
    gbifKey: sp.gbifKey,
  });
  for (const [parent, childId] of [
    [nodes.get(taxon.rootId), familyId],
    [familyNode, genusId],
    [genusNode, speciesId],
  ]) { if (!parent.children.includes(childId)) parent.children.push(childId); }
}

for (const n of nodes.values()) {
  n.children.sort((a, b) => {
    const an = nodes.get(a).commonName || nodes.get(a).name;
    const bn = nodes.get(b).commonName || nodes.get(b).name;
    return an.localeCompare(bn);
  });
}

function speciesCount(id) {
  const n = nodes.get(id);
  if (n.type === "species") return 1;
  if (n._count != null) return n._count;
  let sum = 0;
  for (const c of n.children) sum += speciesCount(c);
  n._count = sum;
  return sum;
}
for (const id of nodes.keys()) speciesCount(id);
for (const n of nodes.values()) { if (n._count != null) n.speciesCount = n._count; delete n._count; }

// Chunking
function findChunkRoots(nodeId, out = []) {
  const n = nodes.get(nodeId);
  if (n.type === "root" || n.speciesCount > CHUNK_THRESHOLD) {
    for (const c of n.children) findChunkRoots(c, out);
  } else out.push(nodeId);
  return out;
}
const chunkRoots = findChunkRoots(taxon.rootId);
const speciesToChunk = new Map();
function assignChunk(nodeId, chunkId) {
  const n = nodes.get(nodeId);
  if (n.type === "species") speciesToChunk.set(nodeId, chunkId);
  else for (const c of n.children) assignChunk(c, chunkId);
}
for (const r of chunkRoots) assignChunk(r, r);

const reprImg = new Map();
function computeReprImg(nodeId) {
  if (reprImg.has(nodeId)) return reprImg.get(nodeId);
  const n = nodes.get(nodeId);
  if (n.type === "species") { reprImg.set(nodeId, n.image || null); return n.image || null; }
  let img = null;
  for (const c of n.children) { const r = computeReprImg(c); if (r && !img) img = r; }
  reprImg.set(nodeId, img); return img;
}
computeReprImg(taxon.rootId);

// Higher-taxon Wikipedia images + article links (shared across all apps).
// A clade prefers its OWN wiki lead photo over the first descendant photo.
let higherWiki = {};
if (existsSync("data/higher-taxa-wiki.json")) {
  try { higherWiki = JSON.parse(await readFile("data/higher-taxa-wiki.json", "utf8")); }
  catch { higherWiki = {}; }
}
function ownWiki(n) {
  const p = higherWiki.plant || {};
  return p[n.name] || (n.commonName ? p[n.commonName] : null) || null;
}

const SKELETON_SPECIES_FIELDS = new Set(["id", "type", "name", "commonName", "parent", "image", "countries", "states"]);
const skeleton = {};
const chunks = new Map();
for (const n of nodes.values()) {
  if (n.type === "species") {
    const light = { id: n.id, type: n.type, name: n.name, parent: n.parent };
    if (n.commonName) light.commonName = n.commonName;
    if (n.image) light.image = n.image;
    if (n.countries?.length) light.countries = n.countries;
    const stateNames = n.observations?.stateProvince?.map((s) => s.name) || [];
    if (stateNames.length) light.states = stateNames;
    light.chunkId = speciesToChunk.get(n.id);
    skeleton[n.id] = light;
    const chunkId = speciesToChunk.get(n.id);
    if (!chunks.has(chunkId)) chunks.set(chunkId, {});
    const heavy = {};
    for (const [k, v] of Object.entries(n)) {
      if (SKELETON_SPECIES_FIELDS.has(k)) continue;
      if (k === "children" || k === "chunkId") continue;
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      heavy[k] = v;
    }
    chunks.get(chunkId)[n.id] = heavy;
  } else {
    const light = { id: n.id, type: n.type, name: n.name, parent: n.parent, children: n.children };
    if (n.commonName) light.commonName = n.commonName;
    if (n.speciesCount) light.speciesCount = n.speciesCount;
    // Prefer this clade's own Wikipedia lead photo; fall back to a descendant.
    const w = ownWiki(n);
    const r = (w && w.image) || reprImg.get(n.id);
    if (r) light.reprImg = r;
    if (w && w.page) { light.wikiUrl = w.page; if (w.title) light.wikiTitle = w.title; if (w.extract) light.wikiExtract = w.extract; }
    skeleton[n.id] = light;
  }
}

await mkdir(`${taxon.webDir}/chunks`, { recursive: true });
for (const f of await readdir(`${taxon.webDir}/chunks`).catch(() => [])) {
  if (f.endsWith(".json")) await unlink(`${taxon.webDir}/chunks/${f}`);
}
await writeFile(`${taxon.webDir}/tree.json`, JSON.stringify({ generatedAt: new Date().toISOString(), chunked: true, nodes: skeleton }));
let totalChunkBytes = 0;
for (const [chunkId, data] of chunks) {
  const json = JSON.stringify(data);
  totalChunkBytes += json.length;
  await writeFile(`${taxon.webDir}/chunks/${chunkId}.json`, json);
}
for (const f of ["index.html", "app.js", "style.css"]) {
  if (existsSync(`web/_shell/${f}`)) await copyFile(`web/_shell/${f}`, `${taxon.webDir}/${f}`);
}
console.log(`Wrote ${taxon.webDir}/tree.json (${(JSON.stringify(skeleton).length / 1e6).toFixed(2)} MB)`);
console.log(`Wrote ${chunks.size} chunks (${(totalChunkBytes / 1e6).toFixed(2)} MB total)`);
const sCount = (k) => [...nodes.values()].filter((n) => n.type === "species" && n[k]).length;
console.log(`  Photos: ${sCount("image")}/${species.length} (${(sCount("image") / species.length * 100).toFixed(0)}%)`);
console.log(`  Wiki:   ${sCount("wiki")}/${species.length} (${(sCount("wiki") / species.length * 100).toFixed(0)}%)`);
console.log(`  GBIF:   ${[...nodes.values()].filter(n => n.type === "species" && n.countries?.length).length}/${species.length}`);
console.log(`  IUCN:   ${sCount("iucn")}/${species.length} (${(sCount("iucn") / species.length * 100).toFixed(0)}%)`);
