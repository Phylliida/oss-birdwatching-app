// Fill photo gaps for the microscopic animal phyla (rotifers, tardigrades,
// nematodes, flatworms, gastrotrichs, …) from GBIF's aggregated media. GBIF
// pulls in museum & specialist collections — the Bohart Museum, the Ramazzotti
// tardigrade collection, Smithsonian NMNH — that publish CC-licensed micrographs
// and specimen photos that iNaturalist's field photographers never capture.
//
// We already store a gbifKey per species, so this is a direct per-species
// occurrence-media query, filtered SERVER-SIDE to the CC licences GBIF tracks
// (CC0 / CC-BY / CC-BY-NC). Output keyed by scientificName:
//   data/animalia/gbif-media.json -> { "<name>": { photos: [{url,license,attribution}] } }
//   (a null value = queried, nothing usable — so resume skips it next run)
// build-animalia-tree.mjs uses it as a photo source below Commons + iNat.
//
// Resumable. Modest concurrency so it coexists with the GBIF range crawl.
// Usage: node scripts/fetch-gbif-media.mjs   (LIMIT=300 to sample)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SPECIES = "data/animalia/species.json";
const INAT = "data/animalia/inat.json";
const OUT = "data/animalia/gbif-media.json";
const API = "https://api.gbif.org/v1/occurrence/search";
const UA = "oss-birdwatching-app/0.0 (https://github.com/Phylliida/oss-birdwatching-app; offline non-commercial)";
const CONCURRENCY = 4;
const DELAY_MS = 150;
const MAX_PHOTOS = 4;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

// The clearly microscopic / meiofaunal phyla — the ones iNat barely covers.
const MICRO = new Set(["Nematoda", "Platyhelminthes", "Rotifera", "Tardigrada",
  "Gastrotricha", "Nematomorpha", "Kinorhyncha", "Loricifera", "Gnathostomulida",
  "Acanthocephala", "Dicyemida", "Orthonectida", "Micrognathozoa", "Entoprocta",
  "Cycliophora", "Xenacoelomorpha"]);

// GBIF takes enum licence values as query params, but returns the licence as a
// URL string in results — normalise both forms (order matters: -nc-sa before
// -nc before plain -by).
function normLicense(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.includes("publicdomain/zero") || s === "cc0_1_0") return "cc0";
  if (s.includes("/by-nc-sa/") || s === "cc_by_nc_sa_4_0") return "cc-by-nc-sa";
  if (s.includes("/by-sa/") || s === "cc_by_sa_4_0") return "cc-by-sa";
  if (s.includes("/by-nc/") || s === "cc_by_nc_4_0") return "cc-by-nc";
  if (s.includes("/by/") || s === "cc_by_4_0") return "cc-by";
  return null;
}
const LIC_LABEL = { "cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA", "cc-by-nc": "CC BY-NC", "cc-by-nc-sa": "CC BY-NC-SA" };
const licenseParams = ["CC0_1_0", "CC_BY_4_0", "CC_BY_NC_4_0"].map((l) => `license=${l}`).join("&");

const species = JSON.parse(await readFile(SPECIES, "utf8"));
const inat = JSON.parse(await readFile(INAT, "utf8"));
const hasInat = (n) => { const r = inat[n]; return r && r.photos && r.photos.length; };

let out = {};
if (existsSync(OUT)) { try { out = JSON.parse(await readFile(OUT, "utf8")); } catch { /* fresh */ } }

const targets = species.filter((s) => MICRO.has(s.phylum) && !hasInat(s.scientificName) && !(s.scientificName in out));
console.log(`${targets.length.toLocaleString()} photoless micro-phyla species to query (${Object.keys(out).length.toLocaleString()} already cached)`);

async function fetchOne(s) {
  const url = `${API}?taxonKey=${s.gbifKey}&mediaType=StillImage&${licenseParams}&limit=20`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** a); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const photos = [];
      const seen = new Set();
      for (const o of j.results || []) {
        const code = LIC[o.license];
        if (!code) continue;
        for (const m of o.media || []) {
          if (m.type !== "StillImage" || !m.identifier || seen.has(m.identifier)) continue;
          seen.add(m.identifier);
          const who = m.creator || m.rightsHolder || o.recordedBy || o.rightsHolder || "an unnamed contributor";
          photos.push({ url: m.identifier, license: code, attribution: `(c) ${who}, ${LIC_LABEL[code]}` });
          if (photos.length >= MAX_PHOTOS) break;
        }
        if (photos.length >= MAX_PHOTOS) break;
      }
      return photos.length ? { photos } : null;
    } catch { if (a === 3) return null; await sleep(1000 * 2 ** a); }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idx = 0, done = 0, withImg = 0, newPhotos = 0;
const list = LIMIT === Infinity ? targets : targets.slice(0, LIMIT);
const start = Date.now();
async function worker() {
  while (idx < list.length) {
    const s = list[idx++];
    const r = await fetchOne(s);
    out[s.scientificName] = r; // null cached too, so resume skips
    if (r) { withImg++; newPhotos += r.photos.length; }
    if (++done % 200 === 0) {
      await writeFile(OUT, JSON.stringify(out));
      const rate = done / ((Date.now() - start) / 1000);
      process.stdout.write(`  ${done}/${list.length} | ${withImg} got images (${(withImg / done * 100).toFixed(1)}%) | ${rate.toFixed(1)}/s | ETA ${((list.length - done) / rate / 60).toFixed(0)}min\n`);
    }
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(OUT, JSON.stringify(out));
console.log(`\nDone. ${withImg.toLocaleString()}/${list.length.toLocaleString()} species got ≥1 CC image (${(withImg / list.length * 100).toFixed(1)}%), ${newPhotos.toLocaleString()} photos total.`);
