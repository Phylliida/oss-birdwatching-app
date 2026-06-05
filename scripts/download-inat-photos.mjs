// Download the referenced iNaturalist plant photos locally (medium size) so the
// plant tree works fully offline, like birds. Reads data/plantae/inat.json,
// saves each photo to data/images/inat-<photo_id>.<ext>, served via /images/.
//
// Resumable: skips files already on disk, so re-running retries only the gaps.
// Usage:  node scripts/download-inat-photos.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";

const IMG = "data/images";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const CONCURRENCY = 40;
await mkdir(IMG, { recursive: true });

// Which kingdom's photo set to fetch. Defaults to plants; set
// INAT_JSON=data/animalia/inat.json for animals. All photos land in the same
// data/images/inat-<id>.<ext> pool (the build's resolveInat finds them by id).
const INAT_JSON = process.env.INAT_JSON || "data/plantae/inat.json";
const inat = JSON.parse(await readFile(INAT_JSON, "utf8"));
const jobs = new Map(); // filename -> url
for (const v of Object.values(inat)) {
  if (!v || !v.photos) continue;
  for (const p of v.photos) {
    const m = p.url.match(/\/photos\/(\d+)\/\w+\.(\w+)/);
    if (!m) continue;
    const fn = `inat-${m[1]}.${m[2].toLowerCase()}`;
    // Force the size segment to "medium" (never square/small/large/original).
    const url = p.url.replace(/\/(square|small|medium|large|original)\./, "/medium.");
    if (!jobs.has(fn)) jobs.set(fn, url);
  }
}
const existing = new Set(readdirSync(IMG));
const todo = [...jobs].filter(([fn]) => !existing.has(fn));
console.log(`${jobs.size.toLocaleString()} unique photos | ${(jobs.size - todo.length).toLocaleString()} already on disk | ${todo.length.toLocaleString()} to fetch`);

let idx = 0, done = 0, failed = 0, bytes = 0;
const start = Date.now();
async function worker() {
  while (idx < todo.length) {
    const [fn, url] = todo[idx++];
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
        if (res.status === 404) break; // gone — don't retry
        if (!res.ok) { if (a === 2) failed++; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(`${IMG}/${fn}`, buf);
        bytes += buf.length;
        break;
      } catch { if (a === 2) failed++; }
    }
    if (++done % 5000 === 0) {
      const rate = done / ((Date.now() - start) / 1000);
      console.log(`  ${done.toLocaleString()}/${todo.length.toLocaleString()} | ${(bytes / 1e9).toFixed(1)} GB | ${failed} failed | ${rate.toFixed(0)}/s | ETA ${((todo.length - done) / rate / 60).toFixed(0)} min`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done. ${done.toLocaleString()} processed, ${failed} failed, ${(bytes / 1e9).toFixed(1)} GB written.`);
