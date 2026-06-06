// Sharded storage for the per-species Wikidata cache. Animalia is so large
// (~1.82M species × names in many languages) that the whole cache as one JSON
// string blows past V8's ~512 MB string cap — JSON.stringify and even readFile
// throw RangeError. So we split it into 16 shards by a hash of the name; each
// shard stays comfortably small, and merging them back is trivial.
//
// Files: <dir>/wikidata-<00..0f>.json . A legacy single <dir>/wikidata.json
// (plants, birds — small enough) is still read on load and removed on first save.

import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

const SHARDS = 16;

export function shardOf(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % SHARDS).toString(16).padStart(2, "0");
}

const isShard = (f) => /^wikidata-[0-9a-f]{2}\.json$/.test(f);

// Merge all shards (or the legacy monolith) into one flat object.
export async function loadWikidata(dir) {
  const data = {};
  const shardFiles = existsSync(dir) ? (await readdir(dir)).filter(isShard) : [];
  if (shardFiles.length) {
    for (const f of shardFiles) {
      try { Object.assign(data, JSON.parse(await readFile(`${dir}/${f}`, "utf8"))); } catch { /* skip bad shard */ }
    }
    return data;
  }
  if (existsSync(`${dir}/wikidata.json`)) {
    try { Object.assign(data, JSON.parse(await readFile(`${dir}/wikidata.json`, "utf8"))); } catch { /* start fresh */ }
  }
  return data;
}

// Write shards. If `dirty` (a Set of shard ids) is given, only those are
// rewritten — avoids re-serialising the whole cache on every periodic save.
export async function saveWikidata(dir, data, dirty = null) {
  const buckets = {};
  for (let i = 0; i < SHARDS; i++) buckets[i.toString(16).padStart(2, "0")] = {};
  for (const [k, v] of Object.entries(data)) buckets[shardOf(k)][k] = v;
  const ids = dirty ? [...dirty] : Object.keys(buckets);
  for (const sh of ids) await writeFile(`${dir}/wikidata-${sh}.json`, JSON.stringify(buckets[sh] || {}));
  if (existsSync(`${dir}/wikidata.json`)) await unlink(`${dir}/wikidata.json`);
}
