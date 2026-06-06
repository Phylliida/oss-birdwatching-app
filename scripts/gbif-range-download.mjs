// Submit + poll + fetch a GBIF occurrence DOWNLOAD of all Plantae occurrences
// (~610M records) as SIMPLE_CSV, for OFFLINE range aggregation. This replaces
// the per-species faceted API crawl (04-fetch-gbif), which GBIF deliberately
// rate-limits (HTTP 429 above concurrency 1) — making 436K species take weeks.
//
// Why a download is faster here even though it moves far more bytes: the crawl
// is RATE-limited (hundreds of thousands of throttled calls), while a download
// is one allowed BANDWIDTH-limited transfer (~60-120 GB in ~1-2 h), then a
// streaming aggregate (parse-gbif-range.mjs) a few hours. Hours, not weeks.
//
// SIMPLE_CSV carries countryCode, stateProvince, month, year, establishmentMeans
// and speciesKey — every facet the range UI needs (no media, so it's leaner than
// DWCA). Needs a FREE GBIF.org account; the download is async and gets a DOI.
//
//   GBIF_USER=you GBIF_PWD=secret node scripts/gbif-range-download.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API = "https://api.gbif.org/v1/occurrence/download";
const STATE = "data/plantae/gbif-range-download.json";
const ZIP = "data/plantae/gbif-occurrences.zip";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

const predicate = { type: "equals", key: "TAXON_KEY", value: "6" }; // kingdom Plantae

await mkdir("data/plantae", { recursive: true });
function auth() {
  const u = process.env.GBIF_USER, p = process.env.GBIF_PWD;
  if (!u || !p) { console.error("Set GBIF_USER and GBIF_PWD (free GBIF.org account) and re-run."); process.exit(1); }
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}
const load = async () => (existsSync(STATE) ? JSON.parse(await readFile(STATE, "utf8")) : {});
const save = async (s) => writeFile(STATE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit() {
  const res = await fetch(`${API}/request`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ creator: process.env.GBIF_USER, sendNotification: false, format: "SIMPLE_CSV", predicate }),
  });
  if (!res.ok) { console.error(`Submit failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const key = (await res.text()).trim();
  console.log(`Submitted. Download key: ${key} (~610M records — GBIF may take a while to assemble)`);
  return key;
}
async function status(key) {
  const res = await fetch(`${API}/${key}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json();
}

let st = await load();
if (!st.key) { st.key = await submit(); st.status = "PREPARING"; await save(st); }
else console.log(`Resuming download ${st.key} (last status ${st.status || "?"})`);

let info;
for (;;) {
  info = await status(st.key);
  st.status = info.status; await save(st);
  console.log(`  status: ${info.status}${info.totalRecords != null ? ` | ${info.totalRecords.toLocaleString()} records` : ""}`);
  if (["SUCCEEDED", "FAILED", "KILLED"].includes(info.status)) break;
  await sleep(60000);
}
if (info.status !== "SUCCEEDED") { console.error(`Download ${info.status}. See https://www.gbif.org/occurrence/download/${st.key}`); process.exit(1); }

console.log(`Ready: ${info.totalRecords.toLocaleString()} records, ${(info.size / 1e9).toFixed(1)} GB. Fetching ...`);
const dl = await fetch(info.downloadLink, { headers: { "User-Agent": UA } });
if (!dl.ok) { console.error(`Fetch failed: HTTP ${dl.status}`); process.exit(1); }
await pipeline(Readable.fromWeb(dl.body), createWriteStream(ZIP));
st.downloaded = true; st.doi = info.doi; await save(st);
console.log(`Wrote ${ZIP}. DOI ${info.doi || "(pending)"}. Next: node --max-old-space-size=32768 scripts/parse-gbif-range.mjs`);
