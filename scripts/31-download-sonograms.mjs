// Downloads the xeno-canto sonogram PNG for every species into
// data/sonograms/. They're tiny (~5–15 KB each); total ~100 MB for 10K
// species. Resumable.

import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const XC_PATH = "data/xc-recordings.json";
const DIR = "data/sonograms";
const CONCURRENCY = 4;
const PER_REQUEST_DELAY_MS = 150;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

await mkdir(DIR, { recursive: true });
const xc = JSON.parse(await readFile(XC_PATH, "utf8"));
const todo = Object.entries(xc)
  .filter(([_, v]) => v?.sonogram)
  .map(([name, v]) => ({ name, url: v.sonogram }));
console.log(`${todo.length} species with sonogram URLs.`);

function slugFor(sci) { return "s-" + sci.replace(/\s+/g, "-"); }

async function downloadOne(name, url) {
  const target = `${DIR}/${slugFor(name)}.png`;
  if (existsSync(target)) return "skip";
  const u = url.replace(/^http:\/\//, "https://");
  const res = await fetch(u, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
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
    if (done % 100 === 0) {
      const rate = done / ((Date.now() - start) / 1000);
      const eta = ((todo.length - done) / rate / 60).toFixed(1);
      process.stdout.write(`  ${done}/${todo.length} | dl ${dl}, skipped ${skipped}, errors ${errors} | ${rate.toFixed(1)}/s | ETA ${eta}min\n`);
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. Downloaded ${dl}, skipped ${skipped}, errors ${errors}.`);
