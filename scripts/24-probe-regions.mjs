// Estimates the size of a "regional pack" for every country. For each country:
//   * species count (per GBIF observations, with the same min-10-obs threshold
//     we use for the country filter UI)
//   * on-disk image bytes for that country's species (uses what's actually
//     downloaded in data/images/)
//   * metadata bytes for that country's species (filtered subset of tree.json)
//
// Useful for deciding pack granularity (per-country, per-region, etc.).

import { readFile, stat, readdir } from "node:fs/promises";

const tree = JSON.parse(await readFile("web/tree.json", "utf8"));
const countriesGeo = JSON.parse(await readFile("web/countries.geojson", "utf8"));
const countryName = new Map(countriesGeo.features.map((f) => [f.properties.iso, f.properties.name]));

const speciesNodes = Object.values(tree.nodes).filter((n) => n.type === "species");

// Map ISO → species[] for every country present in our data.
const byCountry = new Map();
for (const sp of speciesNodes) {
  for (const iso of sp.countries || []) {
    if (!byCountry.has(iso)) byCountry.set(iso, []);
    byCountry.get(iso).push(sp);
  }
}

// Index of which image files exist on disk so we can sum bytes per region.
const imageBytes = new Map();
try {
  const entries = await readdir("data/images");
  await Promise.all(entries.map(async (f) => {
    const m = f.match(/^(s-.+)\.(jpg|jpeg|png|webp|gif)$/i);
    if (!m) return;
    const sz = (await stat(`data/images/${f}`)).size;
    imageBytes.set(m[1], sz);
  }));
} catch (err) {
  console.warn(`Couldn't index data/images: ${err.message}`);
}

// Metadata bytes per species: serialize the node to JSON, measure.
// This is the cost we'd pay to put this species in a regional pack.
const metadataBytes = new Map();
for (const sp of speciesNodes) {
  metadataBytes.set(sp.id, Buffer.byteLength(JSON.stringify(sp), "utf8"));
}

const fmt = (b) => (b / 1e6).toFixed(1) + " MB";

const rows = [];
for (const [iso, list] of byCountry) {
  let img = 0, meta = 0, withImg = 0;
  for (const sp of list) {
    const ib = imageBytes.get(sp.id) || 0;
    if (ib > 0) withImg++;
    img += ib;
    meta += metadataBytes.get(sp.id) || 0;
  }
  rows.push({ iso, name: countryName.get(iso) || iso, species: list.length, withImg, img, meta });
}
rows.sort((a, b) => b.species - a.species);

// Print as a fixed-width table.
console.log(`Total species in tree:        ${speciesNodes.length}`);
console.log(`Species with country data:    ${speciesNodes.filter(s => s.countries?.length).length}`);
console.log(`Image files on disk:          ${imageBytes.size}`);
console.log(`Sum of all metadata (no images): ${fmt([...metadataBytes.values()].reduce((a, b) => a + b, 0))}`);
console.log("");
console.log("Top 25 countries by species count:");
console.log("ISO  Country                          Species   ImgCov   Img       Meta       Total");
console.log("---  -------                          -------   ------   -------   --------   --------");
for (const r of rows.slice(0, 25)) {
  const imgCov = r.species ? ((r.withImg / r.species) * 100).toFixed(0) + "%" : "0%";
  console.log(
    `${r.iso.padEnd(5)}${r.name.padEnd(32)} ${String(r.species).padStart(7)}   ${imgCov.padStart(6)}   ${fmt(r.img).padStart(8)}  ${fmt(r.meta).padStart(8)}   ${fmt(r.img + r.meta).padStart(8)}`,
  );
}

// State/province packs (only meaningful where GBIF stateProvince data exists —
// the 9 federal countries we mapped earlier). We use the species'
// observations.stateProvince field to know which states each is in.
const byState = new Map(); // state name → species[]
for (const sp of speciesNodes) {
  for (const s of sp.observations?.stateProvince || []) {
    if (s.count < 10) continue; // skip vagrants
    if (!byState.has(s.name)) byState.set(s.name, []);
    byState.get(s.name).push(sp);
  }
}

const stateRows = [];
for (const [name, list] of byState) {
  let img = 0, meta = 0, withImg = 0;
  for (const sp of list) {
    const ib = imageBytes.get(sp.id) || 0;
    if (ib > 0) withImg++;
    img += ib;
    meta += metadataBytes.get(sp.id) || 0;
  }
  stateRows.push({ name, species: list.length, withImg, img, meta });
}
stateRows.sort((a, b) => b.species - a.species);

console.log("");
console.log("Top 25 states/provinces by species count:");
console.log("State                          Species   ImgCov   Img       Meta       Total");
console.log("-----                          -------   ------   -------   --------   --------");
for (const r of stateRows.slice(0, 25)) {
  const imgCov = r.species ? ((r.withImg / r.species) * 100).toFixed(0) + "%" : "0%";
  console.log(
    `${r.name.padEnd(30)} ${String(r.species).padStart(7)}   ${imgCov.padStart(6)}   ${fmt(r.img).padStart(8)}  ${fmt(r.meta).padStart(8)}   ${fmt(r.img + r.meta).padStart(8)}`,
  );
}

// Continent-style aggregates: union of country species. Useful "what about
// Europe / Africa" packs.
const REGIONS = {
  "North America": ["US", "CA", "MX"],
  "South America": ["BR", "AR", "CO", "PE", "CL", "VE", "EC", "BO", "UY", "PY", "GY", "SR", "GF"],
  "Western Europe": ["GB", "FR", "DE", "ES", "IT", "NL", "BE", "PT", "AT", "CH", "IE", "DK", "NO", "SE", "FI"],
  "Eastern Europe + Russia": ["RU", "UA", "PL", "RO", "HU", "CZ", "SK", "BG", "RS", "HR", "EE", "LV", "LT"],
  "Sub-Saharan Africa": ["ZA", "KE", "NG", "ET", "TZ", "UG", "GH", "CM", "AO", "SN", "ZM", "ZW", "MG", "BW", "NA"],
  "South Asia": ["IN", "PK", "BD", "LK", "NP"],
  "East Asia": ["CN", "JP", "KR", "TW", "MN"],
  "SE Asia + Oceania": ["TH", "VN", "ID", "MY", "PH", "MM", "KH", "AU", "NZ", "PG"],
};
console.log("");
console.log("Region aggregates (union of country species):");
for (const [region, isos] of Object.entries(REGIONS)) {
  const sp = new Set();
  for (const iso of isos) for (const s of byCountry.get(iso) || []) sp.add(s.id);
  let img = 0, meta = 0;
  for (const id of sp) {
    img += imageBytes.get(id) || 0;
    meta += metadataBytes.get(id) || 0;
  }
  console.log(`  ${region.padEnd(28)} ${String(sp.size).padStart(5)} species  ${fmt(img).padStart(8)} img  ${fmt(meta).padStart(8)} meta`);
}
