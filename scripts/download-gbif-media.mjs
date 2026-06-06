// Download the GBIF museum/specialist images referenced in gbif-media.json to
// data/images/, so the microscopic-animal cards are offline like everything
// else. Unlike iNat (one CDN, clean URLs), these come from many museum hosts in
// varied formats — some are query-strings with no extension — so we name each
// file by a hash of its URL plus the extension from the HTTP Content-Type, and
// write a manifest (originalUrl -> /images/<file>) that build-animalia-tree.mjs
// reads to point cards at the local copy.
//
// Resumable: skips URLs already resolved (or marked dead) in the manifest.
// Usage:  node scripts/download-gbif-media.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const GM = "data/animalia/gbif-media.json";
const MANIFEST = "data/animalia/gbif-media-local.json";
const IMG = "data/images";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const CONCURRENCY = 8;
// Only browser-renderable formats — TIFF is excluded (browsers can't show it,
// and museum TIFFs run to tens of MB each); a TIFF-only source is left "dead".
const EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

await mkdir(IMG, { recursive: true });
const gm = JSON.parse(await readFile(GM, "utf8"));
const urls = new Set();
for (const v of Object.values(gm)) if (v && v.photos) for (const p of v.photos) if (p.url) urls.add(p.url);

// manifest[url] = "/images/..." (downloaded) | null (dead/non-image, don't retry)
let manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : {};
const todo = [...urls].filter((u) => !(u in manifest));
console.log(`${urls.size.toLocaleString()} unique GBIF media URLs | ${(urls.size - todo.length).toLocaleString()} already handled | ${todo.length.toLocaleString()} to fetch`);

const hash = (u) => createHash("sha1").update(u).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idx = 0, done = 0, ok = 0, dead = 0, bytes = 0, dirty = 0;
async function worker() {
  while (idx < todo.length) {
    const u = todo[idx++];
    let result = null; // null => give up (cached as dead)
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000), redirect: "follow" });
        if (res.status === 404 || res.status === 410) break;          // gone — don't retry
        if (!res.ok) { if (a < 2) { await sleep(1000 * 2 ** a); continue; } break; }
        const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext = EXT[ct];
        if (!ext) break;                                              // not an image we handle
        const buf = Buffer.from(await res.arrayBuffer());
        const fn = `gbifmedia-${hash(u)}.${ext}`;
        await writeFile(`${IMG}/${fn}`, buf);
        result = `/images/${fn}`; bytes += buf.length;
        break;
      } catch { if (a < 2) await sleep(1000 * 2 ** a); }
    }
    manifest[u] = result;
    if (result) ok++; else dead++;
    done++; dirty++;
    if (dirty >= 200) { await writeFile(MANIFEST, JSON.stringify(manifest)); dirty = 0; }
    if (done % 500 === 0) console.log(`  ${done}/${todo.length} | ${ok} saved, ${dead} dead/non-image | ${(bytes / 1e6).toFixed(0)} MB`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(MANIFEST, JSON.stringify(manifest));
const local = Object.values(manifest).filter(Boolean).length;
console.log(`Done. ${ok.toLocaleString()} saved this run (${(bytes / 1e6).toFixed(0)} MB), ${dead} dead/non-image. ${local.toLocaleString()} URLs now local.`);
