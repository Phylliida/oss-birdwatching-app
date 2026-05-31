// Downloads the labeled (sex × life stage) and extra iNat photos shown in
// the thumb strip on bird species pages, so they're served from /images/
// like the main photos instead of streaming from iNat's S3 every time.
//
// Naming: data/images/{species-id}-{variant}.{ext}
//   labeled: s-Cardinalis-cardinalis-adult-male.jpg
//   extras:  s-Cardinalis-cardinalis-extra-0.jpg
//
// ~18K files total at ~250 KB each ≈ ~4–5 GB. Resumable.

import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const LABELED_PATH = "data/inat-labeled.json";
const EXTRAS_PATH = "data/inat-extras.json";
const IMG_DIR = "data/images";
const CONCURRENCY = 2;
const PER_REQUEST_DELAY_MS = 400;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

await mkdir(IMG_DIR, { recursive: true });

const labeled = existsSync(LABELED_PATH) ? JSON.parse(await readFile(LABELED_PATH, "utf8")) : {};
const extras = existsSync(EXTRAS_PATH) ? JSON.parse(await readFile(EXTRAS_PATH, "utf8")) : {};

function slugFor(sci) { return "s-" + sci.replace(/\s+/g, "-"); }

// Upgrade square/small/medium → large variants so we download the good size.
function largeInat(url) {
  if (!url) return url;
  return url.replace(/\/(square|small|medium)\.(jpe?g|png|webp|gif)(\?|$|#)/i, "/large.$2$3");
}
function extOf(url) {
  const m = url.match(/\.(jpe?g|png|webp|gif)(\?|$|#)/i);
  return m ? m[1].toLowerCase() : "jpg";
}

// Build a flat list of {targetPath, url} for everything to download.
const todo = [];
for (const [name, rec] of Object.entries(labeled)) {
  if (!rec?.photos) continue;
  const slug = slugFor(name);
  for (const [key, p] of Object.entries(rec.photos)) {
    if (!p?.url) continue;
    const url = largeInat(p.url.replace(/^http:\/\//, "https://"));
    todo.push({ target: `${IMG_DIR}/${slug}-${key}.${extOf(url)}`, url });
  }
}
for (const [name, rec] of Object.entries(extras)) {
  if (!rec?.photos?.length) continue;
  const slug = slugFor(name);
  rec.photos.forEach((p, i) => {
    if (!p?.url) return;
    const url = largeInat(p.url.replace(/^http:\/\//, "https://"));
    todo.push({ target: `${IMG_DIR}/${slug}-extra-${i}.${extOf(url)}`, url });
  });
}
console.log(`${todo.length} secondary photos queued.`);

async function downloadOne({ target, url }) {
  if (existsSync(target)) return "skip";
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
  return "ok";
}

let nextIdx = 0, done = 0, dl = 0, skipped = 0, errors = 0;
const start = Date.now();

async function worker() {
  while (nextIdx < todo.length) {
    const i = nextIdx++;
    try {
      const r = await downloadOne(todo[i]);
      if (r === "ok") dl++;
      else skipped++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${todo[i].target}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) {
      const rate = done / ((Date.now() - start) / 1000);
      const eta = ((todo.length - done) / rate / 60).toFixed(1);
      process.stdout.write(`  ${done}/${todo.length} | dl ${dl}, skipped ${skipped}, errors ${errors} | ${rate.toFixed(1)}/s | ETA ${eta}min\n`);
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. Downloaded ${dl}, skipped ${skipped}, ${errors} errors.`);
