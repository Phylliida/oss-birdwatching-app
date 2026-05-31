// Downloads the primary photo for each species — Wikimedia Commons preferred,
// iNaturalist as fallback (matching build-tree's priority). Commons URLs are
// reduced to width=1024 via ?width=N so we don't pull multi-MB originals.
// ~11K files × ~250 KB ≈ ~3 GB. Resumable.

import { readFile, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const COVERAGE_PATH = "data/coverage-report.json";
const INAT_PATH = "data/inat-photos.json";
const IMG_DIR = "data/images";
// Wikimedia asks for 1 sustained connection + ≤1 req/sec from bulk fetchers.
// We sit safely under that with 1.5s between requests, giving us ~0.6 req/sec
// effective rate — slow but should avoid 429s entirely.
const CONCURRENCY = 1;
const PER_REQUEST_DELAY_MS = 1500;
const MAX_RETRIES = 5;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

await mkdir(IMG_DIR, { recursive: true });

const coverage = JSON.parse(await readFile(COVERAGE_PATH, "utf8"));
const inat = existsSync(INAT_PATH) ? JSON.parse(await readFile(INAT_PATH, "utf8")) : {};

// Same license policy as build-tree: reject ARR (null) and ND variants.
const OK_LICENSES = new Set(["cc0", "pd", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"]);
const todo = coverage.species
  .map((s) => {
    const wd = s.commonsImage;
    if (wd) return { name: s.scientificName, url: wd, source: "commons" };
    const i = inat[s.scientificName];
    if (i?.url && typeof i.license === "string" && OK_LICENSES.has(i.license.toLowerCase())) {
      return { name: s.scientificName, url: i.url, source: "inat" };
    }
    return null;
  })
  .filter(Boolean);
console.log(`${todo.length} species with image URLs.`);

function slugFor(sci) { return "s-" + sci.replace(/\s+/g, "-"); }

function extFromUrl(url) {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$|#)/i);
  return m ? m[1].toLowerCase() : "jpg";
}

function targetPath(name, url) {
  return `${IMG_DIR}/${slugFor(name)}.${extFromUrl(url)}`;
}

async function downloadOne(name, url, source) {
  // Determine target with the URL's extension. If a file with any image
  // extension exists for this slug, treat as already downloaded.
  const slug = slugFor(name);
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    if (existsSync(`${IMG_DIR}/${slug}.${ext}`)) return "skip";
  }
  // Normalize http→https; for Commons add a width hint; for iNat upgrade
  // medium (~500 px) → large (~1024 px) which matches the display slot.
  let dl = url.replace(/^http:\/\//, "https://");
  if (source === "commons" && dl.includes("Special:FilePath")) {
    dl += dl.includes("?") ? "&width=1024" : "?width=1024";
  } else if (source === "inat") {
    dl = dl.replace(/\/medium\.(jpe?g|png|webp|gif)(\?|$|#)/i, "/large.$1$2");
  }
  let lastStatus = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(dl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(60_000),
      redirect: "follow",
    });
    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      try { await res.arrayBuffer(); } catch {}
      // Bigger backoff: 5s, 10s, 20s, 40s, 80s. If we're hitting the limit,
      // we want to back well off rather than poke it every couple seconds.
      await new Promise((r) => setTimeout(r, 5000 * Math.pow(2, attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(targetPath(name, url)));
    return "ok";
  }
  throw new Error(`HTTP ${lastStatus} after ${MAX_RETRIES} retries`);
}

let nextIdx = 0;
let done = 0, dl = 0, skipped = 0, errors = 0;
const start = Date.now();

async function worker() {
  while (nextIdx < todo.length) {
    const i = nextIdx++;
    const { name, url, source } = todo[i];
    try {
      const r = await downloadOne(name, url, source);
      if (r === "ok") dl++;
      else skipped++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    done++;
    if (done % 50 === 0) {
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = todo.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(
        `  ${done}/${todo.length} | dl ${dl}, skipped ${skipped}, errors ${errors} | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. Downloaded ${dl}, skipped ${skipped} (already existed), ${errors} errors.`);
