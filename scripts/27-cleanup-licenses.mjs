// Removes locally-downloaded image files whose source license isn't OK for
// our non-commercial app. Specifically: ARR (null license) and ND variants
// from iNat. Commons photos are always OK.

import { readFile, readdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const COVERAGE_PATH = "data/coverage-report.json";
const INAT_PATH = "data/inat-photos.json";
const IMG_DIR = "data/images";

const OK_LICENSES = new Set(["cc0", "pd", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"]);

const coverage = JSON.parse(await readFile(COVERAGE_PATH, "utf8"));
const inat = existsSync(INAT_PATH) ? JSON.parse(await readFile(INAT_PATH, "utf8")) : {};

// Per scientific name, decide: which source would build-tree currently pick?
// If the answer is "iNat with a bad license", that species' downloaded file
// (if any) needs to go.
const slugFor = (sci) => "s-" + sci.replace(/\s+/g, "-");
const toRemove = [];

for (const sp of coverage.species) {
  if (sp.commonsImage) continue; // Commons is always OK
  const i = inat[sp.scientificName];
  if (!i?.url) continue;
  const ok = typeof i.license === "string" && OK_LICENSES.has(i.license.toLowerCase());
  if (ok) continue;
  // Species would have its image dropped by build-tree. Check disk.
  toRemove.push({ name: sp.scientificName, slug: slugFor(sp.scientificName), license: i.license || "ARR" });
}

const files = existsSync(IMG_DIR) ? new Set(await readdir(IMG_DIR)) : new Set();

let removedCount = 0, removedBytes = 0;
const licenseHisto = {};
for (const r of toRemove) {
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    const fname = `${r.slug}.${ext}`;
    if (!files.has(fname)) continue;
    const fp = `${IMG_DIR}/${fname}`;
    const sz = (await stat(fp)).size;
    await unlink(fp);
    removedCount++;
    removedBytes += sz;
    licenseHisto[r.license] = (licenseHisto[r.license] || 0) + 1;
    break;
  }
}

console.log(`Affected species: ${toRemove.length}`);
console.log(`Files removed:    ${removedCount} (${(removedBytes / 1e6).toFixed(1)} MB)`);
console.log(`By license:`);
for (const [k, v] of Object.entries(licenseHisto).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(15)} ${v}`);
}
