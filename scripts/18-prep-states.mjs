// Trims Natural Earth Admin 1 (states/provinces) 50m down to the minimum we
// need: state name + country code + geometry. Saves to web/states.geojson.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SRC_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson";
const TMP = "/tmp/ne_admin1_50m.geojson";
const OUT = "web/states.geojson";

await mkdir("web", { recursive: true });

if (!existsSync(TMP)) {
  console.log(`Downloading admin1 50m (~2.3 MB)...`);
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(TMP));
  console.log(`Saved ${((await stat(TMP)).size / 1e6).toFixed(1)} MB`);
}

const raw = JSON.parse(await readFile(TMP, "utf8"));
const minimized = {
  type: "FeatureCollection",
  features: raw.features.map((f) => {
    const p = f.properties;
    return {
      type: "Feature",
      properties: {
        name: p.name || p.name_local || "",
        iso: p.iso_a2 || null,
      },
      geometry: f.geometry,
    };
  }).filter((f) => f.properties.name),
};

await writeFile(OUT, JSON.stringify(minimized));
const sz = (await stat(OUT)).size;
console.log(`Wrote ${OUT} — ${minimized.features.length} subdivisions, ${(sz / 1024).toFixed(0)} KB`);
const byCountry = {};
for (const f of minimized.features) byCountry[f.properties.iso] = (byCountry[f.properties.iso] || 0) + 1;
console.log("Countries covered:", Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).map(e => `${e[0]}:${e[1]}`).join(", "));
