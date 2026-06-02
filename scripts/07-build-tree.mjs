// Joins ioc-species.json + Wikidata image coverage into a single navigable
// hierarchy keyed by node ID:
//   aves > o-<Order> > f-<Family> > g-<Genus> > s-<Genus>-<species>
//
// Output: web/birds/tree.json — small enough to ship with the app, large enough to
// drive every page. ~2 MB JSON; we'll worry about packing later.

import { readFile, writeFile, mkdir, readdir, unlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Detect locally downloaded audio/image files so we can serve them via the
// dev server (/audio/, /images/) instead of streaming from the remote source.
// Falls through to the remote URL if no local file is found.
const localAudio = new Set();
if (existsSync("data/audio")) {
  for (const f of await readdir("data/audio")) if (f.endsWith(".mp3")) localAudio.add(f.slice(0, -4));
}
const localSono = new Set();
if (existsSync("data/sonograms")) {
  for (const f of await readdir("data/sonograms")) if (f.endsWith(".png")) localSono.add(f.slice(0, -4));
}
const localImage = new Map(); // slug → extension (main photos: s-Genus-species.jpg)
const localSecondary = new Map(); // "{slug}-{variant}" → extension
if (existsSync("data/images")) {
  for (const f of await readdir("data/images")) {
    const m = f.match(/^(s-[A-Za-z]+-[a-z-]+)\.(jpg|jpeg|png|webp|gif)$/i);
    if (m) { localImage.set(m[1], m[2].toLowerCase()); continue; }
    // Secondary photo: s-Genus-species-{variant}.ext where variant is
    // adult-male / adult-female / juvenile / adult / extra-{n}.
    const m2 = f.match(/^(s-[A-Za-z]+-[a-z-]+)-(adult-male|adult-female|juvenile|adult|extra-\d+)\.(jpg|jpeg|png|webp|gif)$/i);
    if (m2) localSecondary.set(`${m2[1]}-${m2[2].toLowerCase()}`, m2[3].toLowerCase());
  }
}
function findLocalSecondary(slug, variant) {
  const ext = localSecondary.get(`${slug}-${variant}`);
  return ext ? `/images/${slug}-${variant}.${ext}` : null;
}

const species = JSON.parse(await readFile("data/ioc-species.json", "utf8"));
const coverage = JSON.parse(await readFile("data/coverage-report.json", "utf8"));
const inat = existsSync("data/inat-photos.json")
  ? JSON.parse(await readFile("data/inat-photos.json", "utf8"))
  : {};
const avonet = existsSync("data/avonet.json")
  ? JSON.parse(await readFile("data/avonet.json", "utf8"))
  : { rows: [] };
const gbif = existsSync("data/gbif-ranges.json")
  ? JSON.parse(await readFile("data/gbif-ranges.json", "utf8"))
  : {};
const gbifFull = existsSync("data/gbif-full.json")
  ? JSON.parse(await readFile("data/gbif-full.json", "utf8"))
  : {};
const wiki = existsSync("data/wiki-summaries.json")
  ? JSON.parse(await readFile("data/wiki-summaries.json", "utf8"))
  : {};
const sisters = existsSync("data/sister-species.json")
  ? JSON.parse(await readFile("data/sister-species.json", "utf8"))
  : {};
const sistersOtol = existsSync("data/sister-species-otol.json")
  ? JSON.parse(await readFile("data/sister-species-otol.json", "utf8"))
  : {};

// Combine sister-species sources. BirdTree has branch lengths (Mya), OToL
// only edges to MRCA. Prefer BirdTree where present; otherwise convert OToL
// entries to a shared shape with `source` so the UI can show the appropriate
// label.
function sistersFor(name) {
  const bt = sisters[name];
  if (bt?.length) return bt.map((s) => ({ ...s, source: "birdtree" }));
  const ot = sistersOtol[name];
  if (ot?.length) return ot.map((s) => ({ name: s.name, edges: s.dist, source: "otol" }));
  return null;
}
const iucn = existsSync("data/iucn-status.json")
  ? JSON.parse(await readFile("data/iucn-status.json", "utf8"))
  : {};
const xc = existsSync("data/xc-recordings.json")
  ? JSON.parse(await readFile("data/xc-recordings.json", "utf8"))
  : {};
const subspecies = existsSync("data/subspecies.json")
  ? JSON.parse(await readFile("data/subspecies.json", "utf8"))
  : {};
const inatExtras = existsSync("data/inat-extras.json")
  ? JSON.parse(await readFile("data/inat-extras.json", "utf8"))
  : {};
const inatLabeled = existsSync("data/inat-labeled.json")
  ? JSON.parse(await readFile("data/inat-labeled.json", "utf8"))
  : {};
const commonsAttr = existsSync("data/commons-attribution.json")
  ? JSON.parse(await readFile("data/commons-attribution.json", "utf8"))
  : {};

function commonsFilenameFromUrl(url) {
  const m = (url || "").match(/Special:FilePath\/(.+?)(?:\?|$|#)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, "%20")); }
  catch { return m[1]; }
}
const wdExtras = existsSync("data/wikidata-extras.json")
  ? JSON.parse(await readFile("data/wikidata-extras.json", "utf8"))
  : {};
const ebirdCodes = existsSync("data/ebird-codes.json")
  ? JSON.parse(await readFile("data/ebird-codes.json", "utf8"))
  : {};
const synonyms = existsSync("data/synonyms.json")
  ? JSON.parse(await readFile("data/synonyms.json", "utf8"))
  : {};

const MIN_COUNTRY_OBS = 10;
function countriesFor(name) {
  // Prefer the richer file (with full counts) when present, so we can apply
  // our own threshold consistently. Fall back to the legacy list otherwise.
  const f = gbifFull[name];
  if (f?.matched && f.facets?.country) {
    return f.facets.country
      .filter((c) => c.count >= MIN_COUNTRY_OBS && c.name !== "ZZ")
      .map((c) => c.name);
  }
  return gbif[name]?.countries || [];
}

// GBIF facet data per species. We trim the long tails (stateProvince has
// hundreds of free-text entries for wide-ranging species; year goes back
// centuries) to keep tree.json under control, but preserve enough for the UI.
function distillGbif(name) {
  const f = gbifFull[name];
  if (!f || !f.matched || !f.facets) return null;
  const trim = (arr, n) => (arr || []).slice(0, n);
  return {
    total: f.total || 0,
    country: f.facets.country || [],                       // usually small, keep all
    stateProvince: trim(f.facets.stateProvince, 30),        // long tail of place names
    continent: f.facets.continent || [],
    month: f.facets.month || [],                            // max 12 entries
    year: trim(f.facets.year, 30),                          // most recent meaningful years
    basisOfRecord: f.facets.basisOfRecord || [],
    establishmentMeans: f.facets.establishmentMeans || [],
  };
}

// AVONET is keyed by Species1 (BirdLife taxonomy); we match against IOC names
// directly — 88% hit rate is acceptable for now. Stored under `traits` on
// each species node so all AVONET fields appear on the species detail page.
const avonetBySci = new Map();
for (const row of avonet.rows) {
  if (row.Species1) avonetBySci.set(row.Species1, row);
}

// Licenses we accept for redistribution. CC0/PD/BY/BY-SA/BY-NC/BY-NC-SA are
// fine for our non-commercial app. We reject ARR (null) and ND variants
// because ND prohibits the derivative work of thumbnailing/resizing.
const OK_LICENSES = new Set(["cc0", "pd", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"]);
function licenseOK(code) {
  return typeof code === "string" && OK_LICENSES.has(code.toLowerCase());
}

// iNat S3 photos come at /square.jpg /small.jpg /medium.jpg /large.jpg
// /original.jpg. Older fetcher scripts sometimes stored square_url (75 px!)
// when medium_url was null, which looks awful in our ~1024 px slot. Upgrade
// any smaller variant to "large".
function largeInat(url) {
  if (!url) return url;
  return url.replace(/\/(square|small|medium)\.(jpe?g|png|webp|gif)(\?|$|#)/i, "/large.$2$3");
}

// imageFor(scientificName) → { url, source, attribution, license, filePage } | null
// For Commons photos we now have artist + license metadata to surface in the
// per-photo credit line.
function imageFor(name) {
  const wd = coverage.species.find((s) => s.scientificName === name);
  if (wd?.commonsImage) {
    const fn = commonsFilenameFromUrl(wd.commonsImage);
    const attr = (fn && commonsAttr[fn]) || {};
    return {
      url: wd.commonsImage,
      source: "commons",
      attribution: attr.artist || null,
      license: attr.license || null,
      filePage: attr.filePage || null,
    };
  }
  const i = inat[name];
  if (i?.url && licenseOK(i.license)) {
    return { url: largeInat(i.url), source: "inat", attribution: i.attribution || null, license: i.license || null };
  }
  return null;
}
// Build a one-shot map so we don't .find() linearly inside the inner loop.
const imageBySci = new Map();
for (const sp of species) {
  const img = imageFor(sp.scientificName);
  if (img) imageBySci.set(sp.scientificName, img);
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
const slug = (s) => s.replace(/\s+/g, "-");

const nodes = new Map();
function getOrCreate(id, init) {
  if (!nodes.has(id)) nodes.set(id, { id, ...init, children: [] });
  return nodes.get(id);
}

// Root
getOrCreate("aves", {
  type: "root",
  name: "Aves",
  commonName: "Birds",
  parent: null,
});

for (const sp of species) {
  const orderId = `o-${slug(titleCase(sp.order))}`;
  const familyId = `f-${slug(sp.family)}`;
  const genusId = `g-${slug(sp.genus)}`;
  const speciesId = `s-${slug(sp.scientificName)}`;

  const orderNode = getOrCreate(orderId, {
    type: "order",
    name: titleCase(sp.order),
    parent: "aves",
  });
  const familyNode = getOrCreate(familyId, {
    type: "family",
    name: sp.family,
    commonName: sp.familyEnglish,
    parent: orderId,
  });
  const genusNode = getOrCreate(genusId, {
    type: "genus",
    name: sp.genus,
    parent: familyId,
  });
  let img = imageBySci.get(sp.scientificName) || null;
  // If we have a local image file for this species, switch to that path so
  // the app loads it from /images/* instead of the remote source.
  if (img && localImage.has(speciesId)) {
    img = { ...img, url: `/images/${speciesId}.${localImage.get(speciesId)}` };
  }
  const av = avonetBySci.get(sp.scientificName) || null;
  // Strip AVONET bookkeeping fields (IDs, sample counts, provenance) — keep
  // only the species-attribute fields a reader actually cares about.
  const traits = av
    ? Object.fromEntries(
        Object.entries(av).filter(
          ([k]) =>
            ![
              "Sequence",
              "Species1",
              "Family1",
              "Order1",
              "Avibase.ID1",
              "Total.individuals",
              "Female",
              "Male",
              "Unknown",
              "Complete.measures",
              "Mass.Source",
              "Mass.Refs.Other",
              "Inference",
              "Traits.inferred",
              "Reference.species",
            ].includes(k),
        ),
      )
    : null;
  const speciesNode = getOrCreate(speciesId, {
    type: "species",
    name: sp.scientificName,
    commonName: sp.commonName,
    parent: genusId,
    image: img?.url || null,
    imageSource: img?.source || null,
    imageAttribution: img?.attribution || null,
    imageLicense: img?.license || null,
    imageFilePage: img?.filePage || null,
    traits,
    countries: countriesFor(sp.scientificName),
    observations: distillGbif(sp.scientificName),
    wiki: wiki[sp.scientificName] || null,
    sisters: sistersFor(sp.scientificName),
    audio: (() => {
      const a = xc[sp.scientificName];
      if (!a) return null;
      const out = { ...a };
      if (a.file && localAudio.has(speciesId)) out.file = `/audio/${speciesId}.mp3`;
      if (a.sonogram && localSono.has(speciesId)) out.sonogram = `/sonograms/${speciesId}.png`;
      return out;
    })(),
    subspecies: subspecies[sp.scientificName] || null,
    // Drop ARR / ND photos from extras (the older fetcher didn't filter) and
    // upgrade iNat URLs from {square,small,medium} → large. Then swap in a
    // local path if we have one cached on disk.
    extraPhotos: (() => {
      const list = inatExtras[sp.scientificName]?.photos || [];
      const ok = list.filter((p) => licenseOK(p.license)).map((p, i) => {
        const url = largeInat(p.url);
        const local = findLocalSecondary(speciesId, `extra-${i}`);
        return { ...p, url: local || url };
      });
      return ok.length ? ok : null;
    })(),
    // labeledPhotos: already license-filtered at fetch time; transform URLs
    // and swap to local path when present.
    labeledPhotos: (() => {
      const p = inatLabeled[sp.scientificName]?.photos;
      if (!p || !Object.keys(p).length) return null;
      const upgraded = {};
      for (const [k, v] of Object.entries(p)) {
        const url = largeInat(v.url);
        const local = findLocalSecondary(speciesId, k);
        upgraded[k] = { ...v, url: local || url };
      }
      return upgraded;
    })(),
    // iNat taxon ID for the species-page link. Pulled from whichever cache
    // happens to have it; prefer labeled (most recent).
    inatId: inatLabeled[sp.scientificName]?.taxonId
         || inatExtras[sp.scientificName]?.taxonId
         || null,
    // Wikidata multilingual names; null if none. Strip "en" since the IOC
    // common name already covers English.
    altNames: (() => {
      const m = wdExtras[sp.scientificName]?.names;
      if (!m) return null;
      const out = { ...m };
      delete out.en;
      return Object.keys(out).length ? out : null;
    })(),
    wingspan: wdExtras[sp.scientificName]?.wingspan || null,
    // IUCN: prefer iNat's value where present; fall back to Wikidata's P141 label.
    iucn: iucn[sp.scientificName] || wdExtras[sp.scientificName]?.iucn || null,
    ebird: ebirdCodes[sp.scientificName] || null,
    synonyms: synonyms[sp.scientificName] || null,
  });

  // Wire children (idempotent — only push if missing).
  for (const [parent, childId] of [
    [nodes.get("aves"), orderId],
    [orderNode, familyId],
    [familyNode, genusId],
    [genusNode, speciesId],
  ]) {
    if (!parent.children.includes(childId)) parent.children.push(childId);
  }
}

// Sort children alphabetically by display name (cheap and predictable).
for (const n of nodes.values()) {
  n.children.sort((a, b) => {
    const an = nodes.get(a).commonName || nodes.get(a).name;
    const bn = nodes.get(b).commonName || nodes.get(b).name;
    return an.localeCompare(bn);
  });
}

// Precompute speciesCount for non-leaf nodes so pages can show "N species" badges.
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

await mkdir("web", { recursive: true });

// === Chunked output ========================================================
// The legacy big tree.json (~60 MB) was a load bottleneck. Split into:
//   web/birds/tree.json     — skeleton: every node with light fields only
//   web/birds/chunks/{id}.json — heavy per-species data for that subtree
// Chunk root = the highest ancestor whose speciesCount fits the threshold.

const CHUNK_THRESHOLD = 1000;

function findChunkRoots(nodeId, out = []) {
  const n = nodes.get(nodeId);
  if (n.type === "root" || n.speciesCount > CHUNK_THRESHOLD) {
    for (const c of n.children) findChunkRoots(c, out);
  } else {
    out.push(nodeId);
  }
  return out;
}
const chunkRoots = findChunkRoots("aves");

const speciesToChunk = new Map();
function assignChunk(nodeId, chunkId) {
  const n = nodes.get(nodeId);
  if (n.type === "species") speciesToChunk.set(nodeId, chunkId);
  else for (const c of n.children) assignChunk(c, chunkId);
}
for (const root of chunkRoots) assignChunk(root, root);

// Representative image per clade so cards work without loading the chunk.
// We must recurse into every child (not stop at the first image found) so
// every sibling subtree also gets its own reprImg computed and cached.
const reprImg = new Map();
function computeReprImg(nodeId) {
  if (reprImg.has(nodeId)) return reprImg.get(nodeId);
  const n = nodes.get(nodeId);
  if (n.type === "species") {
    const v = n.image || null;
    reprImg.set(nodeId, v);
    return v;
  }
  let myImg = null;
  for (const c of n.children) {
    const r = computeReprImg(c);
    if (r && !myImg) myImg = r;
  }
  reprImg.set(nodeId, myImg);
  return myImg;
}
computeReprImg("aves");

// Higher-taxon Wikipedia images + article links (shared across all apps).
// A clade prefers its OWN wiki lead photo over the first descendant photo.
let higherWiki = {};
if (existsSync("data/higher-taxa-wiki.json")) {
  try { higherWiki = JSON.parse(await readFile("data/higher-taxa-wiki.json", "utf8")); }
  catch { higherWiki = {}; }
}
function ownWiki(n) {
  const a = higherWiki.animal || {};
  return a[n.name] || (n.commonName ? a[n.commonName] : null) || null;
}

// Light fields the skeleton needs for browse, search, /nearby filter.
// (`states` is computed below from observations.stateProvince.)
const SKELETON_SPECIES_FIELDS = new Set([
  "id", "type", "name", "commonName", "parent", "image", "countries", "ebird", "inatId", "states",
]);

const skeleton = {};
const chunks = new Map();

for (const n of nodes.values()) {
  if (n.type === "species") {
    const light = { id: n.id, type: n.type, name: n.name, parent: n.parent };
    if (n.commonName) light.commonName = n.commonName;
    if (n.image) light.image = n.image;
    if (n.countries?.length) light.countries = n.countries;
    if (n.ebird) light.ebird = n.ebird;
    if (n.inatId) light.inatId = n.inatId;
    // Pull just the state names out of observations.stateProvince so the
    // /nearby state-level filter can stay client-side without loading chunks.
    const stateNames = n.observations?.stateProvince?.map((s) => s.name) || [];
    if (stateNames.length) light.states = stateNames;
    light.chunkId = speciesToChunk.get(n.id);
    skeleton[n.id] = light;

    const chunkId = speciesToChunk.get(n.id);
    if (!chunks.has(chunkId)) chunks.set(chunkId, {});
    const heavy = {};
    for (const [k, v] of Object.entries(n)) {
      if (SKELETON_SPECIES_FIELDS.has(k)) continue;
      if (k === "children") continue;
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
    if (w && w.page) { light.wikiUrl = w.page; if (w.title) light.wikiTitle = w.title; }
    skeleton[n.id] = light;
  }
}

// Wipe stale chunks from previous builds.
await mkdir("web/birds/chunks", { recursive: true });
for (const f of await readdir("web/birds/chunks")) {
  if (f.endsWith(".json")) await unlink(`web/birds/chunks/${f}`);
}

await writeFile(
  "web/birds/tree.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), chunked: true, nodes: skeleton }),
);
let totalChunkBytes = 0;
for (const [chunkId, data] of chunks) {
  const json = JSON.stringify(data);
  totalChunkBytes += json.length;
  await writeFile(`web/birds/chunks/${chunkId}.json`, json);
}
console.log(`Chunks: ${chunks.size} files, ${(totalChunkBytes / 1e6).toFixed(1)} MB total`);

// Copy SPA shell into the bird app dir so /birds/ runs the same app.
for (const f of ["index.html", "app.js", "style.css"]) {
  await copyFile(`web/_shell/${f}`, `web/birds/${f}`);
}

const sizes = { root: 0, order: 0, family: 0, genus: 0, species: 0 };
const photoBySource = { commons: 0, inat: 0, none: 0 };
for (const n of nodes.values()) {
  sizes[n.type]++;
  if (n.type === "species") photoBySource[n.imageSource || "none"]++;
}
const bytes = (await readFile("web/birds/tree.json")).length;
console.log(
  `Wrote web/birds/tree.json — ${nodes.size} nodes (${sizes.order} orders, ${sizes.family} families, ${sizes.genus} genera, ${sizes.species} species), ${(bytes / 1024 / 1024).toFixed(2)} MB`,
);
const totalCovered = photoBySource.commons + photoBySource.inat;
console.log(
  `Photo coverage: ${totalCovered}/${sizes.species} (${((totalCovered / sizes.species) * 100).toFixed(1)}%) — ` +
    `${photoBySource.commons} Commons, ${photoBySource.inat} iNat, ${photoBySource.none} missing`,
);
const traitsCount = [...nodes.values()].filter((n) => n.type === "species" && n.traits).length;
console.log(
  `AVONET traits: ${traitsCount}/${sizes.species} (${((traitsCount / sizes.species) * 100).toFixed(1)}%)`,
);
const rangeCount = [...nodes.values()].filter((n) => n.type === "species" && n.countries?.length > 0).length;
console.log(
  `GBIF country data: ${rangeCount}/${sizes.species} (${((rangeCount / sizes.species) * 100).toFixed(1)}%)`,
);
const wikiCount = [...nodes.values()].filter((n) => n.type === "species" && n.wiki).length;
console.log(
  `Wikipedia summaries: ${wikiCount}/${sizes.species} (${((wikiCount / sizes.species) * 100).toFixed(1)}%)`,
);
const sisterCount = [...nodes.values()].filter((n) => n.type === "species" && n.sisters).length;
console.log(
  `Sister species data: ${sisterCount}/${sizes.species} (${((sisterCount / sizes.species) * 100).toFixed(1)}%)`,
);
const iucnCount = [...nodes.values()].filter((n) => n.type === "species" && n.iucn).length;
console.log(
  `IUCN status: ${iucnCount}/${sizes.species} (${((iucnCount / sizes.species) * 100).toFixed(1)}%)`,
);
const audioCount = [...nodes.values()].filter((n) => n.type === "species" && n.audio).length;
console.log(
  `Xeno-canto audio: ${audioCount}/${sizes.species} (${((audioCount / sizes.species) * 100).toFixed(1)}%)`,
);
console.log(
  `Local downloads: ${localImage.size} images, ${localAudio.size} audio`,
);
const sspCount = [...nodes.values()].filter((n) => n.type === "species" && n.subspecies?.length).length;
const sspTotal = [...nodes.values()].reduce((s, n) => s + (n.subspecies?.length || 0), 0);
console.log(
  `Subspecies: ${sspTotal} across ${sspCount}/${sizes.species} species`,
);
const extraCount = [...nodes.values()].filter((n) => n.type === "species" && n.extraPhotos?.length).length;
console.log(
  `Extra photos (iNat): ${extraCount}/${sizes.species} species`,
);
const labeledCount = [...nodes.values()].filter((n) => n.type === "species" && n.labeledPhotos).length;
const labeledTotal = [...nodes.values()].reduce((s, n) => s + Object.keys(n.labeledPhotos || {}).length, 0);
console.log(
  `Labeled photos: ${labeledTotal} across ${labeledCount}/${sizes.species} species`,
);
const inatLinkCount = [...nodes.values()].filter((n) => n.type === "species" && n.inatId).length;
console.log(
  `iNat species IDs: ${inatLinkCount}/${sizes.species}`,
);
const ebirdCount = [...nodes.values()].filter((n) => n.type === "species" && n.ebird).length;
console.log(
  `eBird codes: ${ebirdCount}/${sizes.species} (${((ebirdCount / sizes.species) * 100).toFixed(1)}%)`,
);
