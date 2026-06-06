// Build the unified, lazily-loaded animal tree under web/animalia/.
//
// Animalia is ~1.82M species / 205K genera — a down-to-genus trunk (like plants)
// would be ~50 MB, too big to ship up front. So we cut the trunk higher, at
// FAMILY, and use TWO lazy levels:
//
//   tree.json  : trunk down to family (~20K nodes). Families are lazy stubs.
//   chunks/f-* : a family's genus stubs (each itself a lazy stub).
//   chunks/g-* : a genus's species  +  a self-descriptor of the genus.
//
// The genus's self-descriptor in its own chunk is the trick that keeps deep
// links working without any genus→family index: a cold link to s-Genus-epithet
// derives g-Genus (chunk name), loads it (getting the species AND the genus
// node), and the genus's parent family already lives in the trunk — so the
// breadcrumb chain resolves all the way up. The shared shell's generalized
// ensureContainerLoaded() handles all of this (and the plant single-level case).
//
// Usage:  node --max-old-space-size=24576 scripts/build-animalia-tree.mjs

import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";

const DATA = process.env.ANIMALIA_DATA || "data/animalia";
const WEB = process.env.ANIMALIA_WEB || "web/animalia";
const ROOT_ID = "animalia";

const loadJson = async (p) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null);

const species = JSON.parse(await readFile(`${DATA}/species.json`, "utf8"));
const wikidata = (await loadJson(`${DATA}/wikidata.json`)) || {};
const wiki = (await loadJson(`${DATA}/wiki.json`)) || {};
const gbif = (await loadJson(`${DATA}/gbif.json`)) || {};
const inat = (await loadJson(`${DATA}/inat.json`)) || {};
// Museum / specialist still images from a GBIF DwC-A media download — gap-fill
// for the microscopic phyla iNat barely covers. See parse-gbif-media-dwca.mjs.
const gbifMedia = (await loadJson(`${DATA}/gbif-media.json`)) || {};
// Locally-downloaded copies of those (originalUrl -> "/images/..." when saved,
// or null when the source was dead/non-image); see download-gbif-media.mjs.
const gbifLocal = (await loadJson(`${DATA}/gbif-media-local.json`)) || {};
const higher = (await loadJson("data/higher-taxa-wiki.json")) || {};
const years = (await loadJson("data/described-years.json")) || {};
console.log(`Loaded ${species.length.toLocaleString()} species; wikidata ${Object.keys(wikidata).length.toLocaleString()}, wiki ${Object.keys(wiki).length.toLocaleString()}, gbif ${Object.keys(gbif).length.toLocaleString()}, inat ${Object.keys(inat).length.toLocaleString()}`);

function largeInat(url) {
  if (!url) return url;
  return url.replace(/\/(square|small|medium)\.(jpe?g|png|webp|gif)(\?|$|#)/i, "/large.$2$3");
}
// Prefer a locally-downloaded copy (data/images/inat-<id>.<ext>); else stream.
const localImages = new Set(existsSync("data/images") ? readdirSync("data/images") : []);
function resolveInat(url) {
  const m = url && url.match(/\/photos\/(\d+)\/\w+\.(\w+)/);
  if (m) { const fn = `inat-${m[1]}.${m[2].toLowerCase()}`; if (localImages.has(fn)) return `/images/${fn}`; }
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
    total: g.total, country: g.facets.country || [], stateProvince: trim(g.facets.stateProvince, 30),
    continent: g.facets.continent || [], month: g.facets.month || [], year: trim(g.facets.year, 30),
    establishmentMeans: g.facets.establishmentMeans || [],
  };
}

const slug = (s) => String(s).replace(/\s+/g, "-").replace(/[^A-Za-z0-9-]/g, "");
const nodes = new Map();
function ensureNode(id, parentId, init) {
  let n = nodes.get(id);
  if (n) return n;
  n = { id, parent: parentId, ...init, children: [] };
  nodes.set(id, n);
  if (parentId != null) nodes.get(parentId).children.push(id);
  return n;
}

ensureNode(ROOT_ID, null, { type: "root", name: "Animalia", commonName: "Animals" });

const RANK_PREFIX = { phylum: "p", class: "c", order: "o", family: "f", genus: "g" };

for (const sp of species) {
  // Every accepted species name is a binomial, so derive the genus from the
  // name when GBIF didn't carry a genusKey — keeps every species under a genus
  // and the architecture uniform (family → genus → species, never family →
  // species directly).
  const genus = sp.genus || sp.scientificName.split(/\s+/)[0];
  // ~0.4% of species carry no phylum in the backbone; without a top rank their
  // genus would dangle directly off the root, scattering thousands of tiny
  // genus cards among the 34 real phyla. Bucket them under an "Incertae sedis"
  // (uncertain-placement) pseudo-phylum so the root stays tidy.
  const chain = [
    ["phylum", sp.phylum || "Incertae sedis"], ["class", sp.class], ["order", sp.order],
    ["family", sp.family], ["genus", genus],
  ].filter(([, name]) => name);
  let parentId = ROOT_ID;
  for (const [rank, name] of chain) {
    const id = `${RANK_PREFIX[rank]}-${slug(name)}`;
    ensureNode(id, parentId, { type: rank, name });
    parentId = id;
  }
  const genusId = parentId;

  const wd = wikidata[sp.scientificName];
  const inatRec = inat[sp.scientificName];
  const inatPhotos = inatRec && inatRec.photos && inatRec.photos.length
    ? inatRec.photos.map((p) => ({ ...p, url: resolveInat(p.url) })) : null;
  let image = wd && wd.image ? commonsImg(wd.image) : null;
  let imageSource = image ? "commons" : null;
  let imageAttribution = null;
  let extraPhotos = inatPhotos;
  if (!image && inatPhotos) {
    image = inatPhotos[0].url; imageSource = "inat"; imageAttribution = inatPhotos[0].attribution || null;
    extraPhotos = inatPhotos.length > 1 ? inatPhotos.slice(1) : null;
  }
  // Last resort (mostly the microscopic phyla): a CC museum/specialist image
  // aggregated by GBIF. Only when neither Commons nor iNat has anything.
  if (!image) {
    const gm = gbifMedia[sp.scientificName];
    if (gm && gm.photos && gm.photos.length) {
      // Drop URLs the local-download marked dead (404 / non-image) so the card
      // shows a clean "no photo" rather than a broken image; map the rest to the
      // local copy (keep the remote URL only if it wasn't downloaded yet).
      const ph = gm.photos
        .filter((p) => gbifLocal[p.url] !== null)
        .map((p) => ({ ...p, url: gbifLocal[p.url] || p.url }));
      if (ph.length) {
        image = ph[0].url; imageSource = "gbif"; imageAttribution = ph[0].attribution || null;
        extraPhotos = ph.length > 1 ? ph.slice(1) : null;
      }
    }
  }
  const altNames = (() => {
    const m = wd && wd.names; if (!m) return null;
    const out = { ...m }; delete out.en;
    return Object.keys(out).length ? out : null;
  })();
  ensureNode(`s-${slug(sp.scientificName)}`, genusId, {
    type: "species", name: sp.scientificName,
    commonName: (wd && wd.names && wd.names.en) || null,
    image, imageSource, imageAttribution,
    countries: countriesFor(sp.scientificName),
    observations: distillGbif(sp.scientificName),
    wiki: wiki[sp.scientificName] || null,
    iucn: (wd && wd.iucn) || null,
    altNames, extraPhotos,
    inatId: (inatRec && inatRec.taxonId) || null,
    describedYear: (years[sp.scientificName] || {}).year || null,
    describedBy: (years[sp.scientificName] || {}).author || null,
    gbifKey: sp.gbifKey,
  });
}

console.log(`Built ${nodes.size.toLocaleString()} nodes`);

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
speciesCount(ROOT_ID);
for (const n of nodes.values()) { if (n._count != null) n.speciesCount = n._count; delete n._count; }

function ownWiki(n) {
  const a = higher.animal || {};
  return a[n.name] || (n.commonName ? a[n.commonName] : null) || null;
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

// ---- Emit: trunk (down to family) + family chunks + genus chunks ----------
await rm(`${WEB}/chunks`, { recursive: true, force: true });
await mkdir(`${WEB}/chunks`, { recursive: true });

function withWiki(light, n) {
  const w = ownWiki(n);
  const r = (w && w.image) || reprImg.get(n.id);
  if (r) light.reprImg = r;
  if (w && w.page) { light.wikiUrl = w.page; if (w.title) light.wikiTitle = w.title; if (w.extract) light.wikiExtract = w.extract; }
  return light;
}
function genusStub(n) {
  const s = { id: n.id, type: "genus", name: n.name, parent: n.parent, chunkId: n.id, lazyChildren: true };
  if (n.commonName) s.commonName = n.commonName;
  if (n.speciesCount) s.speciesCount = n.speciesCount;
  return withWiki(s, n);
}
function heavySpecies(n) {
  const heavy = { id: n.id, type: "species", name: n.name, parent: n.parent };
  if (n.commonName) heavy.commonName = n.commonName;
  if (n.image) heavy.image = n.image;
  for (const k of ["countries", "observations", "wiki", "iucn", "altNames", "extraPhotos", "inatId", "describedYear", "describedBy", "gbifKey", "imageSource", "imageAttribution"]) {
    const v = n[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    heavy[k] = v;
  }
  return heavy;
}

const trunk = {};
const familyChunks = new Map(); // familyId -> { genusId: stub }
const genusChunks = new Map();  // genusId  -> { speciesId: heavy, genusId: selfStub }
const getChunk = (m, k) => { let c = m.get(k); if (!c) { c = {}; m.set(k, c); } return c; };

for (const n of nodes.values()) {
  if (n.type === "species") {
    getChunk(genusChunks, n.parent)[n.id] = heavySpecies(n);
  } else if (n.type === "genus") {
    const stub = genusStub(n);
    const parent = nodes.get(n.parent);
    if (parent && parent.type === "family") getChunk(familyChunks, n.parent)[n.id] = stub;
    else trunk[n.id] = stub; // orphan genus (parent is order/class/…) lives in the trunk
    getChunk(genusChunks, n.id)[n.id] = stub; // self-descriptor for cold deep-links
  } else {
    const light = withWiki({ id: n.id, type: n.type, name: n.name, parent: n.parent }, n);
    if (n.commonName) light.commonName = n.commonName;
    if (n.id === ROOT_ID) light.displayRank = "Kingdom";
    if (n.speciesCount) light.speciesCount = n.speciesCount;
    if (n.type === "family") { light.chunkId = n.id; light.lazyChildren = true; }
    else light.children = n.children; // root/phylum/class/order keep child lists
    trunk[n.id] = light;
  }
}

await writeFile(`${WEB}/tree.json`, JSON.stringify({ generatedAt: new Date().toISOString(), lazy: true, root: ROOT_ID, nodes: trunk }));

let chunkBytes = 0, chunkFiles = 0;
for (const m of [familyChunks, genusChunks]) {
  for (const [id, data] of m) {
    const json = JSON.stringify(data);
    chunkBytes += json.length; chunkFiles++;
    await writeFile(`${WEB}/chunks/${id}.json`, json);
  }
}

for (const f of ["index.html", "app.js", "style.css"]) {
  if (existsSync(`web/_shell/${f}`)) await copyFile(`web/_shell/${f}`, `${WEB}/${f}`);
}

const trunkBytes = JSON.stringify(trunk).length;
console.log(`Wrote ${WEB}/tree.json — trunk ${(trunkBytes / 1e6).toFixed(2)} MB (${Object.keys(trunk).length.toLocaleString()} nodes down to family)`);
console.log(`Wrote ${chunkFiles.toLocaleString()} chunks (${familyChunks.size.toLocaleString()} family + ${genusChunks.size.toLocaleString()} genus, ${(chunkBytes / 1e6).toFixed(0)} MB total)`);
const withPhoto = [...nodes.values()].filter((n) => n.type === "species" && n.image).length;
console.log(`Species with photo: ${withPhoto.toLocaleString()} / ${species.length.toLocaleString()} (${(withPhoto / species.length * 100).toFixed(1)}%)`);
