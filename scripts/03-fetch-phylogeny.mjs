// Fetches the Jetz et al. BirdTree global bird phylogeny and its taxonomy CSV.
//
// The full distribution is 10x ~194 MB zip archives of 1,000 trees each. For
// app visualization we only need one tree, so we grab the first archive,
// extract a single Newick, and discard the rest.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DATA_DIR = "data";
const TAX_URL = "https://data.vertlife.org/birdtree/BLIOCPhyloMasterTax.csv";
const ZIP_URL = "https://data.vertlife.org/birdtree/Stage2/HackettStage2_0001_1000.zip";
const TAX_PATH = `${DATA_DIR}/birdtree-taxonomy.csv`;
const ZIP_PATH = `${DATA_DIR}/HackettStage2_0001_1000.zip`;
const TREE_PATH = `${DATA_DIR}/phylogeny.nwk`;

await mkdir(DATA_DIR, { recursive: true });

async function download(url, path) {
  if (existsSync(path)) {
    const s = await stat(path);
    console.log(`Cached ${path} (${(s.size / 1e6).toFixed(1)} MB)`);
    return;
  }
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  // Stream straight to disk so we don't hold ~200 MB in memory.
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  const s = await stat(path);
  console.log(`Saved ${(s.size / 1e6).toFixed(1)} MB to ${path}`);
}

await download(TAX_URL, TAX_PATH);
await download(ZIP_URL, ZIP_PATH);

// List archive contents to learn its layout.
const list = spawnSync("unzip", ["-l", ZIP_PATH], { encoding: "utf8" });
const entries = list.stdout
  .split("\n")
  .map((l) => l.trim().split(/\s+/).slice(-1)[0])
  .filter((n) => n && /\.(tre|nwk|nex|newick)$/i.test(n));
console.log(`Zip contains ${entries.length} tree files. First few:`, entries.slice(0, 3));

const firstEntry = entries[0];
if (!firstEntry) {
  console.log("No standard tree extension found. Full listing:");
  console.log(list.stdout);
  process.exit(1);
}

// The archive turned out to hold a single concatenated file of 1,000 trees,
// each terminated by ';'. We only need the first tree, so we extract to disk
// then read just up to the first semicolon.
const ALL_TREES_PATH = `${DATA_DIR}/all-trees-001.nwk`;
if (!existsSync(ALL_TREES_PATH)) {
  console.log(`Extracting ${firstEntry} to ${ALL_TREES_PATH} ...`);
  const ex = spawnSync("sh", ["-c", `unzip -p '${ZIP_PATH}' '${firstEntry}' > '${ALL_TREES_PATH}'`]);
  if (ex.status !== 0) throw new Error(`unzip failed: ${ex.stderr?.toString()}`);
  console.log(`Extracted ${(await stat(ALL_TREES_PATH)).size / 1e6} MB`);
}

const all = await readFile(ALL_TREES_PATH, "utf8");
const head = all.slice(0, 200);
console.log(`File starts with:\n${head}\n`);

// Detect format: NEXUS files start with "#NEXUS" and embed Newick after
// "tree TREE_NAME = ...;" lines; raw Newick is just "(...);".
let firstTree;
if (/^#NEXUS/i.test(all)) {
  const m = all.match(/tree\s+\S+\s*=\s*(?:\[[^\]]*\]\s*)?(\([^;]+;)/i);
  if (!m) throw new Error("NEXUS file but no tree line matched");
  firstTree = m[1];
  console.log("Detected NEXUS, extracted first tree statement.");
} else {
  const semi = all.indexOf(";");
  if (semi < 0) throw new Error("No ';' found — file may not be Newick");
  firstTree = all.slice(0, semi + 1);
  console.log("Detected raw Newick, took first tree.");
}

await writeFile(TREE_PATH, firstTree);
console.log(`Wrote ${TREE_PATH} (${firstTree.length} chars)`);

const tips = [...firstTree.matchAll(/[(,]\s*([A-Za-z][A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]);
console.log(`Approx tip count: ${tips.length}`);
console.log(`First 5 tip labels: ${tips.slice(0, 5).join(", ")}`);
console.log(`Last 5 tip labels:  ${tips.slice(-5).join(", ")}`);
