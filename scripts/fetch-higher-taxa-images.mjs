// Fetch each higher taxon's OWN Wikipedia lead image + article URL, so cards
// for orders/families/genera/roots (and the abstract landing nodes Animalia /
// Plantae / Gymnosperms / Angiosperms) show a representative photo of *that*
// taxon instead of the first photo of its lowest-level descendant species.
//
// Reads every web/<app>/tree.json, collects internal (non-species) nodes, and
// queries the Wikipedia REST summary endpoint. Resumable: cached keys are
// skipped, so it's safe to re-run. Runs against en.wikipedia.org — a different
// host from iNaturalist, so it's fine to run alongside the iNat pipeline.
//
// Output: data/higher-taxa-wiki.json  { <taxonName|abstractKey>: { title, page, image } }
//   image is a Commons Special:FilePath URL when possible (so ?width=NNN
//   scaling works), otherwise the raw thumbnail URL. image may be null.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "data/higher-taxa-wiki.json";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const CONCURRENCY = 4;
const DELAY = 120;
const MAX_RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Collect internal taxon nodes from every app's tree.json -------------
// Keyed by scientific name so the build scripts can look up by node.name.
const targets = new Map();
for (const d of await readdir("web", { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const p = `web/${d.name}/tree.json`;
  if (!existsSync(p)) continue;
  let tree;
  try { tree = JSON.parse(await readFile(p, "utf8")); } catch { continue; }
  for (const n of Object.values(tree.nodes)) {
    if (n.type === "species" || !n.name) continue;
    if (targets.has(n.name)) continue;
    const queries = [n.name];
    if (n.commonName && n.commonName !== n.name) queries.push(n.commonName);
    targets.set(n.name, { key: n.name, queries });
  }
}

// Abstract landing nodes (no taxon row of their own).
for (const a of [
  { key: "Animalia",     queries: ["Animal"] },
  { key: "Plantae",      queries: ["Plant"] },
  { key: "Gymnosperms",  queries: ["Gymnosperm"] },
  { key: "Angiosperms",  queries: ["Flowering plant"] },
]) targets.set(a.key, a);

const list = [...targets.values()];

let cache = {};
if (existsSync(OUT)) { try { cache = JSON.parse(await readFile(OUT, "utf8")); } catch { cache = {}; } }
console.log(`${list.length} higher taxa, ${Object.keys(cache).length} cached`);

// Convert an upload.wikimedia.org Commons URL into a Special:FilePath URL so the
// front-end's thumbUrl(?width=) scaling works. Returns null if not a Commons file.
function commonsFilePath(src) {
  if (!src) return null;
  const m = src.match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-fA-F]\/[0-9a-fA-F]{2}\/([^/]+?)(?:\/\d+px-[^/]+)?$/);
  return m ? `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}` : null;
}

async function summary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      if (j.type === "disambiguation") return null;
      const src = j.originalimage?.source || j.thumbnail?.source || null;
      return {
        title: j.title || title,
        page: j.content_urls?.desktop?.page || null,
        image: src ? (commonsFilePath(src) || src) : null,
      };
    } catch {
      if (attempt < MAX_RETRIES - 1) await sleep(500 * 2 ** attempt);
      else return null;
    }
  }
  return null;
}

let i = 0, done = 0, withImg = 0, dirty = false;
async function worker() {
  while (i < list.length) {
    const t = list[i++];
    if (t.key in cache) { done++; if (cache[t.key]?.image) withImg++; continue; }
    // Try each candidate title; keep the first result that has an image,
    // else the first result with at least an article page.
    let best = null;
    for (const q of t.queries) {
      const r = await summary(q);
      if (r) { if (!best) best = r; if (r.image) { best = r; break; } }
      await sleep(DELAY);
    }
    cache[t.key] = best;
    if (best?.image) withImg++;
    done++;
    dirty = true;
    if (done % 50 === 0) {
      if (dirty) { await writeFile(OUT, JSON.stringify(cache)); dirty = false; }
      console.log(`  ${done}/${list.length} | ${withImg} with image`);
    }
    await sleep(DELAY);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT, JSON.stringify(cache));
const total = Object.values(cache).filter((v) => v?.image).length;
console.log(`Done. ${total}/${Object.keys(cache).length} entries have an image.`);
