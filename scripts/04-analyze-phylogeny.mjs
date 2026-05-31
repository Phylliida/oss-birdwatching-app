// Cross-references BirdTree tip labels against IOC species names.
// BirdTree (2012) uses older BLIOC taxonomy; IOC has had many splits since,
// so we expect imperfect overlap. This script quantifies it.

import { readFile, writeFile } from "node:fs/promises";

const newick = await readFile("data/phylogeny.nwk", "utf8");
const ioc = JSON.parse(await readFile("data/ioc-species.json", "utf8"));

const tips = [...newick.matchAll(/[(,]\s*([A-Za-z][A-Za-z0-9_]+)\s*:/g)]
  .map((m) => m[1].replace(/_/g, " "));
const tipSet = new Set(tips);
const iocSet = new Set(ioc.map((s) => s.scientificName));

const tipsInIoc = tips.filter((t) => iocSet.has(t));
const tipsNotInIoc = tips.filter((t) => !iocSet.has(t));
const iocInTree = ioc.filter((s) => tipSet.has(s.scientificName));
const iocNotInTree = ioc.filter((s) => !tipSet.has(s.scientificName));

// For unmatched IOC species, check whether the genus exists in the tree —
// helps distinguish "newly split species" (genus present) from "genus moved/
// renamed" (genus absent).
const tipGenera = new Set(tips.map((t) => t.split(" ")[0]));
const iocNotInTreeButGenusIs = iocNotInTree.filter((s) => tipGenera.has(s.genus));
const iocNotInTreeOrGenus = iocNotInTree.filter((s) => !tipGenera.has(s.genus));

const report = {
  birdtreeTips: tips.length,
  iocSpecies: ioc.length,
  matched: tipsInIoc.length,
  tipsMissingFromIoc: tipsNotInIoc.length,
  iocMissingFromTree: iocNotInTree.length,
  iocMissingButGenusInTree: iocNotInTreeButGenusIs.length,
  iocMissingAndGenusNotInTree: iocNotInTreeOrGenus.length,
  matchedPct: +((tipsInIoc.length / tips.length) * 100).toFixed(1),
  iocCoveredPct: +((iocInTree.length / ioc.length) * 100).toFixed(1),
  sampleTipsNotInIoc: tipsNotInIoc.slice(0, 10),
  sampleIocNotInTree: iocNotInTree.slice(0, 10).map((s) => s.scientificName),
};

await writeFile("data/phylo-coverage.json", JSON.stringify(report, null, 2));

console.log("=== BirdTree x IOC cross-reference ===");
console.log(`BirdTree tips:                 ${report.birdtreeTips}`);
console.log(`IOC species:                   ${report.iocSpecies}`);
console.log(`Tips that match IOC exactly:   ${report.matched} (${report.matchedPct}% of tips)`);
console.log(`IOC species in tree:           ${ioc.length - iocNotInTree.length} (${report.iocCoveredPct}% of IOC)`);
console.log(``);
console.log(`IOC species NOT in tree:       ${report.iocMissingFromTree}`);
console.log(`  ...but genus IS in tree:     ${report.iocMissingButGenusInTree}  (likely post-2012 splits/renames)`);
console.log(`  ...genus also not in tree:   ${report.iocMissingAndGenusNotInTree}  (full taxonomic restructure)`);
console.log(``);
console.log(`Tree tips NOT in IOC:          ${report.tipsMissingFromIoc}  (lumps, old names, BLIOC-only species)`);
console.log(``);
console.log("Sample tips not in IOC:", report.sampleTipsNotInIoc);
console.log("Sample IOC not in tree:", report.sampleIocNotInTree);
