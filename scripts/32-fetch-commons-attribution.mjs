// Fetches per-photo artist + license for our Wikimedia Commons images via
// the MediaWiki API's imageinfo/extmetadata. Batched 50 files per call.
//
// Output: data/commons-attribution.json keyed by filename (without "File:"):
//   { artist, license, licenseUrl, filePage, attributionRequired }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const COVERAGE_PATH = "data/coverage-report.json";
const OUT_PATH = "data/commons-attribution.json";
const API = "https://commons.wikimedia.org/w/api.php";
const BATCH = 50;
const PER_REQUEST_DELAY_MS = 700;
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const coverage = JSON.parse(await readFile(COVERAGE_PATH, "utf8"));

function filenameFromUrl(url) {
  const m = (url || "").match(/Special:FilePath\/(.+?)(?:\?|$|#)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, "%20")); }
  catch { return m[1]; }
}

// Strip HTML tags Wikimedia often wraps the artist field in (anchor with
// link to user page, etc.) so we end up with a plain display name.
function stripHtml(s) {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

const filenameToSpecies = new Map();
for (const s of coverage.species) {
  if (!s.commonsImage) continue;
  const fn = filenameFromUrl(s.commonsImage);
  if (fn) filenameToSpecies.set(fn, s.scientificName);
}
const filenames = [...filenameToSpecies.keys()];
console.log(`${filenames.length} Commons filenames to look up`);

let existing = {};
if (existsSync(OUT_PATH)) {
  try { existing = JSON.parse(await readFile(OUT_PATH, "utf8")); }
  catch { console.warn(`Couldn't parse ${OUT_PATH}; starting fresh.`); }
}
const todo = filenames.filter((f) => !(f in existing));
console.log(`${Object.keys(existing).length} cached, ${todo.length} to fetch`);

async function fetchBatch(names) {
  const titles = names.map((n) => "File:" + n).join("|");
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    titles,
    prop: "imageinfo",
    iiprop: "extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|License|AttributionRequired|Credit",
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let done = 0, found = 0, errors = 0;
const start = Date.now();
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  try {
    const json = await fetchBatch(batch);
    const pages = json.query?.pages || {};
    for (const p of Object.values(pages)) {
      // The API title is "File:X.jpg"; strip the prefix for our key.
      const fn = (p.title || "").replace(/^File:/, "");
      const meta = p.imageinfo?.[0]?.extmetadata || {};
      const artist = stripHtml(meta.Artist?.value);
      const licenseShort = meta.LicenseShortName?.value || meta.License?.value || null;
      const licenseUrl = meta.LicenseUrl?.value || null;
      const credit = stripHtml(meta.Credit?.value);
      existing[fn] = {
        artist: artist || null,
        license: licenseShort,
        licenseUrl,
        credit: credit || null,
        filePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent("File:" + fn)}`,
      };
      if (artist || licenseShort) found++;
    }
    done += batch.length;
  } catch (err) {
    errors++;
    if (errors <= 5) console.warn(`  Batch ${i} error: ${err.message}`);
    done += batch.length;
  }
  if (i % (BATCH * 4) === 0) {
    await writeFile(OUT_PATH, JSON.stringify(existing));
    const rate = done / ((Date.now() - start) / 1000);
    const eta = ((todo.length - done) / rate / 60).toFixed(1);
    process.stdout.write(`  ${done}/${todo.length} | ${found} with metadata | ${errors} batch errors | ${rate.toFixed(0)}/s | ETA ${eta}min\n`);
  }
  await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
}

await writeFile(OUT_PATH, JSON.stringify(existing));
const withArtist = Object.values(existing).filter((v) => v.artist).length;
const withLicense = Object.values(existing).filter((v) => v.license).length;
console.log(`\nDone.`);
console.log(`  With artist name: ${withArtist}/${filenames.length} (${(withArtist / filenames.length * 100).toFixed(1)}%)`);
console.log(`  With license:     ${withLicense}/${filenames.length} (${(withLicense / filenames.length * 100).toFixed(1)}%)`);
