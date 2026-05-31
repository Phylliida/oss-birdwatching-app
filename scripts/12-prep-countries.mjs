// Trims Natural Earth countries GeoJSON down to the minimum we need for
// offline point-in-polygon lookups: ISO alpha-2 code + display name + geometry.

import { readFile, writeFile } from "node:fs/promises";

const SRC = "/tmp/ne_countries_raw.geojson";
const OUT = "web/countries.geojson";

const raw = JSON.parse(await readFile(SRC, "utf8"));

const minimized = {
  type: "FeatureCollection",
  features: raw.features.map((f) => {
    const p = f.properties;
    // ISO_A2_EH falls back to a usable code for disputed territories where
    // ISO_A2 is "-99"; if even that's missing we drop the feature.
    const iso = p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : p.ISO_A2;
    return {
      type: "Feature",
      properties: { iso, name: p.NAME || p.ADMIN || iso },
      geometry: f.geometry,
    };
  }).filter((f) => f.properties.iso && f.properties.iso !== "-99"),
};

await writeFile(OUT, JSON.stringify(minimized));
const { stat } = await import("node:fs/promises");
const sz = (await stat(OUT)).size;
console.log(`Wrote ${OUT} — ${minimized.features.length} countries, ${(sz / 1024).toFixed(0)} KB`);
console.log("Sample:", minimized.features.slice(0, 5).map((f) => `${f.properties.iso}: ${f.properties.name}`).join(", "));
