// Submit + poll + fetch a GBIF occurrence DOWNLOAD (Darwin Core Archive) of the
// microscopic animal phyla's CC-licensed still images, for OFFLINE parsing —
// the bulk equivalent of per-species API calls. GBIF assembles the archive
// asynchronously (minutes–hours); this script is resumable: it stores the
// download key, so re-running just polls status and downloads when ready.
//
// The DWCA format includes a `multimedia.txt` extension with the actual image
// URLs + licence + creator, which scripts/parse-gbif-media-dwca.mjs joins to our
// species by taxonKey. (SIMPLE_CSV would omit the media URLs.)
//
// Needs a FREE GBIF.org account (the download API is authenticated):
//   GBIF_USER=you GBIF_PWD=secret node scripts/gbif-media-download.mjs
//
// The download gets a citable DOI; we cite GBIF + the underlying datasets.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API = "https://api.gbif.org/v1/occurrence/download";
const STATE = "data/animalia/gbif-media-download.json";
const ZIP = "data/animalia/gbif-media-dwca.zip";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";

// Backbone taxonKeys of the microscopic / meiofaunal phyla (taxonKey matches the
// taxon and all its descendants in a download predicate).
const MICRO_KEYS = [
  "5967481", // Nematoda
  "108",     // Platyhelminthes
  "91",      // Rotifera
  "14",      // Tardigrada
  "22",      // Gastrotricha
  "64",      // Nematomorpha
  "5959089", // Kinorhyncha
  "5967457", // Loricifera
  "77",      // Gnathostomulida
  "67",      // Acanthocephala
  "7663989", // Dicyemida
  "5967456", // Orthonectida
  "5967454", // Micrognathozoa
  "8173593", // Entoprocta
  "45",      // Cycliophora
  "7190138", // Xenacoelomorpha
];

const predicate = {
  type: "and",
  predicates: [
    { type: "in", key: "TAXON_KEY", values: MICRO_KEYS },
    { type: "equals", key: "MEDIA_TYPE", value: "StillImage" },
    { type: "in", key: "LICENSE", values: ["CC0_1_0", "CC_BY_4_0", "CC_BY_NC_4_0"] },
  ],
};

await mkdir("data/animalia", { recursive: true });

function auth() {
  const user = process.env.GBIF_USER, pwd = process.env.GBIF_PWD;
  if (!user || !pwd) {
    console.error("Set GBIF_USER and GBIF_PWD (a free GBIF.org account) and re-run.");
    process.exit(1);
  }
  return "Basic " + Buffer.from(`${user}:${pwd}`).toString("base64");
}

async function loadState() { return existsSync(STATE) ? JSON.parse(await readFile(STATE, "utf8")) : {}; }
async function saveState(s) { await writeFile(STATE, JSON.stringify(s, null, 2)); }

async function submit() {
  const body = {
    creator: process.env.GBIF_USER,
    sendNotification: false,
    format: "DWCA",
    predicate,
  };
  const res = await fetch(`${API}/request`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.error(`Submit failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const key = (await res.text()).trim();
  console.log(`Submitted. Download key: ${key}`);
  return key;
}

async function status(key) {
  const res = await fetch(`${API}/${key}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state = await loadState();
if (!state.key) { state.key = await submit(); state.status = "PREPARING"; await saveState(state); }
else console.log(`Resuming download ${state.key} (last status ${state.status || "?"})`);

// Poll until the archive is ready (or killed). GBIF statuses: PREPARING,
// RUNNING, SUCCEEDED, FAILED, KILLED, SUSPENDED.
let info;
for (;;) {
  info = await status(state.key);
  state.status = info.status; await saveState(state);
  const done = info.totalRecords != null ? ` | ${info.totalRecords.toLocaleString()} records` : "";
  console.log(`  status: ${info.status}${done}`);
  if (["SUCCEEDED", "FAILED", "KILLED"].includes(info.status)) break;
  await sleep(30000);
}
if (info.status !== "SUCCEEDED") { console.error(`Download ${info.status}. See https://www.gbif.org/occurrence/download/${state.key}`); process.exit(1); }

console.log(`Ready: ${info.totalRecords.toLocaleString()} records, ${(info.size / 1e6).toFixed(0)} MB. Fetching ${info.downloadLink} ...`);
const dl = await fetch(info.downloadLink, { headers: { "User-Agent": UA } });
if (!dl.ok) { console.error(`Fetch failed: HTTP ${dl.status}`); process.exit(1); }
await pipeline(Readable.fromWeb(dl.body), createWriteStream(ZIP));
state.downloaded = true; state.doi = info.doi; await saveState(state);
console.log(`Wrote ${ZIP}. DOI ${info.doi || "(pending)"}. Next: node scripts/parse-gbif-media-dwca.mjs`);
