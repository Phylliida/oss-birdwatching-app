// Fetches one representative recording from xeno-canto for each IOC species.
// Uses API v3 (https://xeno-canto.org/explore/api), which requires an API key
// — set XC_API_KEY in the environment. NEVER commit your key to git.
//
// For each species we query gen:G+sp:s+grp:birds, sort the results by quality
// (A > B > C > D > E) preferring sound type "song" over "call", and pick the
// top one. License is preserved per-recording so we can attribute correctly.
//
// Output: data/xc-recordings.json keyed by IOC scientific name.
// Audio files themselves are NOT downloaded — we store the URL and rely on
// HTML5 <audio> to stream. Full offline support is a later step.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const KEY = process.env.XC_API_KEY;
if (!KEY) {
  console.error("Missing XC_API_KEY env var. Get one from https://xeno-canto.org/account and run as:");
  console.error("  XC_API_KEY=yourkey npm run fetch-xc");
  process.exit(1);
}

const SPECIES_PATH = "data/ioc-species.json";
const OUT_PATH = "data/xc-recordings.json";
const CONCURRENCY = 2;
const PER_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const species = JSON.parse(await readFile(SPECIES_PATH, "utf8"));
let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch (err) { console.warn(`Couldn't parse ${OUT_PATH} (${err.message}); starting fresh.`); }
}
console.log(`${species.length} species; ${Object.keys(existing).length} already cached`);

const QUALITY_RANK = { A: 5, B: 4, C: 3, D: 2, E: 1, "": 0 };

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

function pickBest(recordings) {
  // Score by quality first, then preference for "song" over "call" over other,
  // then prefer recordings with confirmed identification (no restriction).
  return recordings
    .filter((r) => r.file && !r._meta?.redacted_fields?.file)  // skip restricted
    .map((r) => {
      const qScore = QUALITY_RANK[r.q] ?? 0;
      const tScore = /song/i.test(r.type) ? 2 : /call/i.test(r.type) ? 1 : 0;
      return { r, score: qScore * 10 + tScore };
    })
    .sort((a, b) => b.score - a.score)[0]?.r || null;
}

async function lookup(name) {
  const [gen, sp] = name.split(" ");
  if (!gen || !sp) return null;
  // xeno-canto wants spaces between tags (URL-encoded as "+"). URLSearchParams
  // does that automatically; if we used encodeURIComponent we'd get "%2B"
  // (literal plus), which the API treats as one big tag string and matches
  // nothing.
  const q = `gen:${gen} sp:${sp} grp:birds`;
  const params = new URLSearchParams({ query: q, per_page: "50", key: KEY });
  const url = `https://xeno-canto.org/api/3/recordings?${params}`;
  const json = await fetchJson(url);
  if (json.error) throw new Error(json.error.message || "xc error");
  if (!json.recordings || json.recordings.length === 0) return null;
  const best = pickBest(json.recordings);
  if (!best) return null;
  // Normalize //protocol-relative URLs to https.
  const fix = (u) => (u ? u.replace(/^\/\//, "https://") : null);
  return {
    id: best.id,
    file: fix(best.file),
    pageUrl: fix(best.url),
    type: best.type || null,
    quality: best.q || null,
    length: best.length || null,
    country: best.cnt || null,
    recordist: best.rec || null,
    license: fix(best.lic),
    date: best.date || null,
    sex: best.sex || null,
    stage: best.stage || null,
    sonogram: fix(best.sono?.small),
    totalRecordings: parseInt(json.numRecordings, 10) || json.recordings.length,
  };
}

let nextIdx = 0;
let done = 0;
let found = 0;
let missing = 0;
let errors = 0;
let dirty = false;
const start = Date.now();

async function worker() {
  while (nextIdx < species.length) {
    const i = nextIdx++;
    const name = species[i].scientificName;
    if (name in existing) { done++; continue; }
    try {
      const r = await lookup(name);
      existing[name] = r; // null means "we checked, no recording"
      dirty = true;
      if (r) found++;
      else missing++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  Error for ${name}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) {
      if (dirty) { await writeFile(OUT_PATH, JSON.stringify(existing)); dirty = false; }
      const rate = done / ((Date.now() - start) / 1000);
      const remaining = species.length - done;
      const eta = (remaining / rate / 60).toFixed(1);
      process.stdout.write(
        `  ${done}/${species.length} | ${found} with audio, ${missing} no recording, ${errors} errors | ${rate.toFixed(1)}/s | ETA ${eta}min\n`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT_PATH, JSON.stringify(existing));
const withAudio = Object.values(existing).filter((v) => v).length;
console.log(`\nDone. ${withAudio}/${species.length} species have audio (${((withAudio / species.length) * 100).toFixed(1)}%)`);
