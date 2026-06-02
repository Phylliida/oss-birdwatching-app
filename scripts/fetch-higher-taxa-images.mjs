// Fetch each higher taxon's photo + Wikipedia article — resolved through
// Wikidata's taxon-name property (P225), NOT by guessing a Wikipedia title.
//
// Why: titles are ambiguous. "Lesbia" is a hummingbird genus, but Wikipedia's
// primary topic for that title is the Roman poet — and it's not even a
// disambiguation page, so a title lookup silently returns the wrong article.
// P225 only matches taxa, so it lands on the real genus → its correct article
// ("Trainbearer") and canonical photo.
//
// Homonyms (e.g. "Iris" is both a mantis genus and a plant genus, "Oenanthe" is
// both a bird and a plant) are disambiguated by kingdom: each app's nodes are
// tagged animal/plant, and a per-candidate kingdom ASK picks the right taxon.
// The cache is namespaced by kingdom so a name that lives in both still works.
//
// Output: data/higher-taxa-wiki.json
//   { animal: { <name>: {title,page,image} }, plant: { … }, abstract: { … } }

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "data/higher-taxa-wiki.json";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const SPARQL = "https://query.wikidata.org/sparql";
const KINGDOM = { animal: "Q729", plant: "Q756" };
const BATCH = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Collect internal taxon names per kingdom ----------------------------
// Birds is the only animal app; every other clade app is plants. (We skip the
// big unified /plantae/ tree here — the 16 clade apps cover the cached genera,
// and plantae's other genera fall back to a descendant photo as before.)
async function namesFrom(dir) {
  const p = `web/${dir}/tree.json`;
  if (!existsSync(p)) return [];
  let tree; try { tree = JSON.parse(await readFile(p, "utf8")); } catch { return []; }
  return Object.values(tree.nodes).filter((n) => n.type !== "species" && n.name).map((n) => n.name);
}
const animalNames = new Set(await namesFrom("birds"));
const plantNames = new Set();
for (const d of await readdir("web", { withFileTypes: true })) {
  if (!d.isDirectory() || ["birds", "plantae", "_shell"].includes(d.name)) continue;
  for (const n of await namesFrom(d.name)) plantNames.add(n);
}
console.log(`${animalNames.size} animal names, ${plantNames.size} plant names`);

// ---- Wikidata helpers ----------------------------------------------------
async function sparql(query, tries = 5) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(SPARQL + "?query=" + encodeURIComponent(query), {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * 2 ** a); continue; }
      if (!res.ok) return null;
      return (await res.json()).results.bindings;
    } catch { if (a === tries - 1) return null; await sleep(2000 * 2 ** a); }
  }
  return null;
}

function commonsFilePath(src) {
  if (!src) return null;
  const https = src.replace(/^http:\/\//, "https://");
  // P18 values are already Special:FilePath URLs; REST thumbnails are upload URLs.
  const m = https.match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-fA-F]\/[0-9a-fA-F]{2}\/([^/]+?)(?:\/\d+px-[^/]+)?$/);
  return m ? `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}` : https;
}

// Wikipedia REST summary — used only to grab a lead image for the (correct,
// Wikidata-supplied) article when the taxon item has no P18.
async function restThumb(title) {
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json();
    const src = j.originalimage?.source || j.thumbnail?.source;
    return src ? commonsFilePath(src) : null;
  } catch { return null; }
}

// ASK returns a boolean (not bindings), so query it directly.
async function askKingdom(qid, kingdomQ) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(SPARQL + "?query=" + encodeURIComponent(`ASK { wd:${qid} wdt:P171* wd:${kingdomQ} }`),
        { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) { await sleep(1500 * 2 ** a); continue; }
      return (await res.json()).boolean === true;
    } catch { await sleep(1500 * 2 ** a); }
  }
  return false;
}

const titleFromArticle = (url) => decodeURIComponent(url.replace("https://en.wikipedia.org/wiki/", "")).replace(/_/g, " ");

// Resolve a name → {title, page, image} within a kingdom.
async function resolve(matches, kingdomQ) {
  let chosen = matches[0];
  if (matches.length > 1) {
    chosen = null;
    for (const m of matches) { if (await askKingdom(m.qid, kingdomQ)) { chosen = m; break; } }
    if (!chosen) chosen = matches.find((m) => m.article) || matches[0];
  }
  if (!chosen) return null;
  let image = chosen.image ? commonsFilePath(chosen.image) : null;
  const page = chosen.article || null;
  const title = page ? titleFromArticle(page) : null;
  if (!image && title) image = await restThumb(title); // lead image of the correct article
  if (!image && !page) return null;
  return { title, page, image };
}

async function fetchKingdom(names, kingdomKey) {
  const kingdomQ = KINGDOM[kingdomKey];
  const list = [...names];
  const out = {};
  cache[kingdomKey] = out; // link so checkpoint writes capture progress
  let done = 0, withImg = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const values = batch.map((n) => `"${n.replace(/[\\"]/g, "\\$&")}"`).join(" ");
    const rows = await sparql(`
      SELECT ?name ?t ?image ?article WHERE {
        VALUES ?name { ${values} }
        ?t wdt:P225 ?name .
        OPTIONAL { ?t wdt:P18 ?image . }
        OPTIONAL { ?article schema:about ?t ; schema:isPartOf <https://en.wikipedia.org/> . }
      }`) || [];
    const byName = new Map();
    for (const b of rows) {
      const name = b.name.value;
      const qid = b.t.value.replace("http://www.wikidata.org/entity/", "");
      if (!byName.has(name)) byName.set(name, new Map());
      const m = byName.get(name);
      if (!m.has(qid)) m.set(qid, { qid, image: null, article: null });
      const rec = m.get(qid);
      if (b.image && !rec.image) rec.image = b.image.value;
      if (b.article && !rec.article) rec.article = b.article.value;
    }
    for (const name of batch) {
      const matches = byName.has(name) ? [...byName.get(name).values()] : [];
      if (!matches.length) { done++; continue; }
      const r = await resolve(matches, kingdomQ);
      if (r) { out[name] = r; if (r.image) withImg++; }
      done++;
    }
    console.log(`  [${kingdomKey}] ${done}/${list.length} | ${withImg} with image`);
    await writeFile(OUT, JSON.stringify(cache));
    await sleep(200);
  }
  return out;
}

// ---- Abstract landing nodes (curated common-name articles) ---------------
async function fetchAbstract() {
  const ABSTRACT = [["Animalia", "Animal"], ["Plantae", "Plant"], ["Gymnosperms", "Gymnosperm"], ["Angiosperms", "Flowering plant"]];
  const out = {};
  for (const [key, title] of ABSTRACT) {
    const img = await restThumb(title);
    out[key] = { title, page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`, image: img };
    await sleep(150);
  }
  return out;
}

const cache = { animal: {}, plant: {}, abstract: {} };
cache.abstract = await fetchAbstract();
cache.animal = await fetchKingdom(animalNames, "animal");
cache.plant = await fetchKingdom(plantNames, "plant");
await writeFile(OUT, JSON.stringify(cache));

const count = (o) => Object.values(o).filter((v) => v?.image).length;
console.log(`Done. animal ${count(cache.animal)}/${Object.keys(cache.animal).length}, plant ${count(cache.plant)}/${Object.keys(cache.plant).length}, abstract ${count(cache.abstract)}/${Object.keys(cache.abstract).length}`);
