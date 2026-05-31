// Builds web/trees/tree.json (skeleton) + web/trees/chunks/*.json
// from the conifer data. Same chunking algorithm as the bird build.
// App code is copied into web/trees/ so the same SPA loads conifer data.

import { readFile, writeFile, mkdir, readdir, unlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES_PATH = "data/conifers/species.json";
const CHUNK_THRESHOLD = 1000;

const rawSpecies = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
const wikidata = existsSync("data/conifers/wikidata.json")
  ? JSON.parse(await readFile("data/conifers/wikidata.json", "utf8"))
  : {};
const wiki = existsSync("data/conifers/wiki.json")
  ? JSON.parse(await readFile("data/conifers/wiki.json", "utf8"))
  : {};
const gbif = existsSync("data/conifers/gbif.json")
  ? JSON.parse(await readFile("data/conifers/gbif.json", "utf8"))
  : {};
const sistersOtol = existsSync("data/conifers/sister-species-otol.json")
  ? JSON.parse(await readFile("data/conifers/sister-species-otol.json", "utf8"))
  : {};
const inat = existsSync("data/conifers/inat.json")
  ? JSON.parse(await readFile("data/conifers/inat.json", "utf8"))
  : {};

// Families that exist only as fossils (or, in Taxodiaceae's case, are
// deprecated and now merged into Cupressaceae). For these we require BOTH a
// Wikipedia article AND a Wikidata image — i.e. notable enough to keep.
const EXTINCT_FAMILIES = new Set([
  "Cordaitaceae", "Cheirolepidiaceae", "Czekanowskiaceae", "Palissyaceae",
  "Taxodiaceae", "Vojnovskyaceae", "Utrechtiaceae", "Voltziaceae",
  "Buriadiaceae", "Ferugliocladaceae", "Majonicaceae", "Rufloriaceae",
  "Ullmanniaceae",
]);

// Filter: keep species that pass our coverage rules. Extant families: any
// data point suffices. Extinct families: must have both wiki and image.
const species = [];
const dropStats = { extinctEmpty: 0, extantEmpty: 0, kept: 0, keptExtinct: 0 };
for (const sp of rawSpecies) {
  const wd = wikidata[sp.scientificName];
  const w = wiki[sp.scientificName];
  const g = gbif[sp.scientificName];
  const hasWiki = !!w;
  const hasImage = !!wd?.image;
  // Only count "names" as data if there's a vernacular name distinct from the
  // scientific name itself. Wikidata often stores the scientific name as the
  // en-label for obscure taxa, which is not useful evidence of documentation.
  const realNames = Object.entries(wd?.names || {}).filter(([_, v]) => v && v !== sp.scientificName);
  const hasAny = hasWiki || hasImage || !!wd?.iucn || realNames.length > 0 || (g?.total > 0);
  const extinct = EXTINCT_FAMILIES.has(sp.family);
  if (extinct) {
    if (hasWiki && hasImage) { species.push(sp); dropStats.keptExtinct++; }
    else dropStats.extinctEmpty++;
  } else {
    if (hasAny) { species.push(sp); dropStats.kept++; }
    else dropStats.extantEmpty++;
  }
}
console.log(`Filtered ${rawSpecies.length} → ${species.length} species`);
console.log(`  Kept (extant w/ data):       ${dropStats.kept}`);
console.log(`  Kept (extinct w/ wiki+img):  ${dropStats.keptExtinct}`);
console.log(`  Dropped (extinct, no data):  ${dropStats.extinctEmpty}`);
console.log(`  Dropped (extant, no data):   ${dropStats.extantEmpty}`);

const MIN_COUNTRY_OBS = 10;
function countriesFor(name) {
  const g = gbif[name];
  if (!g?.facets?.country) return [];
  return g.facets.country
    .filter((c) => c.count >= MIN_COUNTRY_OBS && c.name !== "ZZ")
    .map((c) => c.name);
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

// --- Build node graph ---------------------------------------------------------
const slug = (s) => s.replace(/\s+/g, "-");
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
const nodes = new Map();
function getOrCreate(id, init) {
  if (!nodes.has(id)) nodes.set(id, { id, ...init, children: [] });
  return nodes.get(id);
}

getOrCreate("pinopsida", { type: "root", name: "Pinopsida", commonName: "Conifers", parent: null });

for (const sp of species) {
  const familyId = `f-${slug(sp.family)}`;
  const genusId = `g-${slug(sp.genus)}`;
  const speciesId = `s-${slug(sp.scientificName)}`;
  const familyNode = getOrCreate(familyId, { type: "family", name: sp.family, parent: "pinopsida" });
  const genusNode = getOrCreate(genusId, { type: "genus", name: sp.genus, parent: familyId });

  const wd = wikidata[sp.scientificName];
  // Convert Wikidata image URL (full Commons file URL) to our Special:FilePath
  // form so the existing UI's thumbnail-with-?width query string works.
  let image = null;
  if (wd?.image) {
    // wd.image looks like http://commons.wikimedia.org/wiki/Special:FilePath/...
    image = wd.image.replace(/^http:\/\//, "https://");
  }

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
      const m = wd?.names;
      if (!m) return null;
      const out = { ...m };
      delete out.en;
      return Object.keys(out).length ? out : null;
    })(),
    // OToL sisters carry edge-distance, not Mya — shared sister UI handles both.
    sisters: (sistersOtol[sp.scientificName] || []).map((s) => ({
      name: s.name, edges: s.dist, source: "otol",
    })).slice(0, 6) || null,
    extraPhotos: inatRec?.photos?.length ? inatRec.photos : null,
    inatId: inatRec?.taxonId || null,
    gbifKey: sp.gbifKey,
  });

  for (const [parent, childId] of [
    [nodes.get("pinopsida"), familyId],
    [familyNode, genusId],
    [genusNode, speciesId],
  ]) {
    if (!parent.children.includes(childId)) parent.children.push(childId);
  }
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
for (const n of nodes.values()) {
  if (n._count != null) n.speciesCount = n._count;
  delete n._count;
}

// --- Chunking (same algorithm as birds) ---------------------------------------
function findChunkRoots(nodeId, out = []) {
  const n = nodes.get(nodeId);
  if (n.type === "root" || n.speciesCount > CHUNK_THRESHOLD) {
    for (const c of n.children) findChunkRoots(c, out);
  } else out.push(nodeId);
  return out;
}
const chunkRoots = findChunkRoots("pinopsida");
const speciesToChunk = new Map();
function assignChunk(nodeId, chunkId) {
  const n = nodes.get(nodeId);
  if (n.type === "species") speciesToChunk.set(nodeId, chunkId);
  else for (const c of n.children) assignChunk(c, chunkId);
}
for (const root of chunkRoots) assignChunk(root, root);

const reprImg = new Map();
function computeReprImg(nodeId) {
  if (reprImg.has(nodeId)) return reprImg.get(nodeId);
  const n = nodes.get(nodeId);
  if (n.type === "species") { reprImg.set(nodeId, n.image || null); return n.image || null; }
  let img = null;
  for (const c of n.children) {
    const r = computeReprImg(c);
    if (r && !img) img = r;
  }
  reprImg.set(nodeId, img);
  return img;
}
computeReprImg("pinopsida");

const SKELETON_SPECIES_FIELDS = new Set([
  "id", "type", "name", "commonName", "parent", "image", "countries", "states",
]);
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
    const r = reprImg.get(n.id);
    if (r) light.reprImg = r;
    skeleton[n.id] = light;
  }
}

// --- Write outputs ------------------------------------------------------------
await mkdir("web/trees/chunks", { recursive: true });
for (const f of await readdir("web/trees/chunks").catch(() => [])) {
  if (f.endsWith(".json")) await unlink(`web/trees/chunks/${f}`);
}
await writeFile(
  "web/trees/tree.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), chunked: true, nodes: skeleton }),
);
let totalChunkBytes = 0;
for (const [chunkId, data] of chunks) {
  const json = JSON.stringify(data);
  totalChunkBytes += json.length;
  await writeFile(`web/trees/chunks/${chunkId}.json`, json);
}

// Copy the SPA shell so localhost:8000/trees/ runs the same app over conifer
// data. Map data (countries/states.geojson) is fetched at the absolute
// /countries.geojson path, shared across sub-apps.
for (const f of ["index.html", "app.js", "style.css"]) {
  if (existsSync(`web/_shell/${f}`)) await copyFile(`web/_shell/${f}`, `web/trees/${f}`);
}

console.log(`Wrote web/trees/tree.json (${(JSON.stringify(skeleton).length / 1e6).toFixed(1)} MB)`);
console.log(`Wrote ${chunks.size} chunks (${(totalChunkBytes / 1e6).toFixed(1)} MB total)`);
console.log(`Species: ${species.length}, families: ${[...nodes.values()].filter((n) => n.type === "family").length}, genera: ${[...nodes.values()].filter((n) => n.type === "genus").length}`);
const withImg = [...nodes.values()].filter((n) => n.type === "species" && n.image).length;
const withWiki = [...nodes.values()].filter((n) => n.type === "species" && n.wiki).length;
const withGbif = [...nodes.values()].filter((n) => n.type === "species" && n.countries?.length).length;
const withIucn = [...nodes.values()].filter((n) => n.type === "species" && n.iucn).length;
console.log(`  Photos: ${withImg}/${species.length} (${(withImg / species.length * 100).toFixed(0)}%)`);
console.log(`  Wiki:   ${withWiki}/${species.length} (${(withWiki / species.length * 100).toFixed(0)}%)`);
console.log(`  GBIF:   ${withGbif}/${species.length} (${(withGbif / species.length * 100).toFixed(0)}%)`);
console.log(`  IUCN:   ${withIucn}/${species.length} (${(withIucn / species.length * 100).toFixed(0)}%)`);
