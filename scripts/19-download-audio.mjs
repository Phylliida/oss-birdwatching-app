// Downloads the primary xeno-canto recording for every species we have a URL
// for, saving as data/audio/s-Genus-species.mp3.
// ~11K files × ~500 KB ≈ ~5 GB. Resumable: existing files are skipped.

import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const XC_PATH = "data/xc-recordings.json";
const AUDIO_DIR = "data/audio";
const CONCURRENCY = 4;
const PER_REQUEST_DELAY_MS = 150;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

await mkdir(AUDIO_DIR, { recursive: true });

if (!existsSync(XC_PATH)) {
  console.error(`Missing ${XC_PATH}. Run the xeno-canto fetcher first.`);
  process.exit(1);
}

const xc = JSON.parse(await readFile(XC_PATH, "utf8"));
const todo = Object.entries(xc)
  .filter(([_, v]) => v?.file)
  .map(([name, v]) => ({ name, url: v.file }));
console.log(`${todo.length} species with audio URLs.`);

function slugFor(sci) {
  return "s-" + sci.replace(/\s+/g, "-");
}

async function downloadOne(name, url) {
  const target = `${AUDIO_DIR}/${slugFor(name)}.mp3`;
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

let nextIdx = 0;
let done = 0, dl = 0, skipped = 0, errors = 0;
const start = Date.now();

async function worker() {
  while (nextIdx < todo.length) {
    const i = nextIdx++;
    const { name, url } = todo[i];
    try {
      const r = await downloadOne(name, url);
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
      // Sample the size of files written so far to estimate total.
      let bytes = 0;
      try {
        const s = await stat(AUDIO_DIR);
        bytes = s.size; // dir size won't be cumulative; we just print count.
      } catch {}
      process.stdout.write(
        `  ${done}/${todo.length} | dl ${dl}, skipped ${skipped}, errors ${errors} | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. Downloaded ${dl}, skipped ${skipped} (already existed), ${errors} errors.`);
