// Shared per-taxon config. Each taxon pipeline reads its config and uses
// the same script bodies — just different IDs + paths.
//
// Adding a new taxon: add an entry here + an entry in web/index.html's
// landing-page card grid.

export const TAXA = {
  conifers: {
    rootName: "Pinopsida",          // scientific name of the root taxon
    commonName: "Conifers",          // display name
    rootKey: 194,                    // GBIF backbone taxonKey for enumeration
    rootId: "pinopsida",             // slug used as tree.json root node id
    dataDir: "data/conifers",
    webDir: "web/trees",
    // OToL prunes Pinopsida class — fall back to per-family subtrees.
    otolFamilyMode: true,
    // Drop fossil-only families (kept only if individual species have wiki+img).
    extinctFamilies: [
      "Cordaitaceae", "Cheirolepidiaceae", "Czekanowskiaceae", "Palissyaceae",
      "Taxodiaceae", "Vojnovskyaceae", "Utrechtiaceae", "Voltziaceae",
      "Buriadiaceae", "Ferugliocladaceae", "Majonicaceae", "Rufloriaceae",
      "Ullmanniaceae",
    ],
  },
  oaks: {
    rootName: "Quercus",
    commonName: "Oaks",
    rootKey: 2877951,
    rootId: "quercus",
    dataDir: "data/oaks",
    webDir: "web/oaks",
    otolOttId: 791121,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  palms: {
    rootName: "Arecaceae",
    commonName: "Palms",
    rootKey: 7681,
    rootId: "arecaceae",
    dataDir: "data/palms",
    webDir: "web/palms",
    otolOttId: 526437,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  maples: {
    rootName: "Acer",
    commonName: "Maples",
    rootKey: 3189834,
    rootId: "acer",
    dataDir: "data/maples",
    webDir: "web/maples",
    otolOttId: 948922,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  eucalypts: {
    rootName: "Eucalyptus",
    commonName: "Eucalypts",
    rootKey: 7493935,
    rootId: "eucalyptus",
    dataDir: "data/eucalypts",
    webDir: "web/eucalypts",
    otolOttId: 1015498,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  cycads: {
    rootName: "Cycadopsida",
    commonName: "Cycads",
    rootKey: 228,
    rootId: "cycadopsida",
    dataDir: "data/cycads",
    webDir: "web/cycads",
    otolOttId: 7579470,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  ginkgo: {
    rootName: "Ginkgoopsida",
    commonName: "Ginkgo & relatives",
    rootKey: 244,
    rootId: "ginkgoopsida",
    dataDir: "data/ginkgo",
    webDir: "web/ginkgo",
    otolOttId: 259598,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  gnetales: {
    rootName: "Gnetopsida",
    commonName: "Gnetales",
    rootKey: 282,
    rootId: "gnetopsida",
    dataDir: "data/gnetales",
    webDir: "web/gnetales",
    otolOttId: 47951,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  magnolias: {
    rootName: "Magnoliaceae",
    commonName: "Magnolias",
    rootKey: 4690,
    rootId: "magnoliaceae",
    dataDir: "data/magnolias",
    webDir: "web/magnolias",
    otolOttId: 288464,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  birches: {
    rootName: "Betulaceae",
    commonName: "Birches & relatives",
    rootKey: 4688,
    rootId: "betulaceae",
    dataDir: "data/birches",
    webDir: "web/birches",
    otolOttId: 791138,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  willows: {
    rootName: "Salicaceae",
    commonName: "Willows & poplars",
    rootKey: 6664,
    rootId: "salicaceae",
    dataDir: "data/willows",
    webDir: "web/willows",
    otolOttId: 530183,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  figs: {
    rootName: "Ficus",
    commonName: "Figs",
    rootKey: 2984588,
    rootId: "ficus",
    dataDir: "data/figs",
    webDir: "web/figs",
    otolOttId: 658513,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  laurels: {
    rootName: "Lauraceae",
    commonName: "Laurels",
    rootKey: 6688,
    rootId: "lauraceae",
    dataDir: "data/laurels",
    webDir: "web/laurels",
    otolOttId: 913246,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  acacias: {
    rootName: "Acacia",
    commonName: "Acacias",
    rootKey: 2978223,
    rootId: "acacia",
    dataDir: "data/acacias",
    webDir: "web/acacias",
    otolOttId: 560307,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  rosaceae: {
    rootName: "Rosaceae",
    commonName: "Rose family",
    rootKey: 5015,
    rootId: "rosaceae",
    dataDir: "data/rosaceae",
    webDir: "web/rosaceae",
    otolOttId: 208036,
    otolFamilyMode: false,
    extinctFamilies: [],
  },
  myrtaceae: {
    rootName: "Myrtaceae",
    commonName: "Myrtle family",
    rootKey: 5014,
    rootId: "myrtaceae",
    dataDir: "data/myrtaceae",
    webDir: "web/myrtaceae",
    otolOttId: 1015492,
    otolFamilyMode: false,
    extinctFamilies: [],
    // Eucalyptus is already its own app at /eucalypts/; exclude it here so
    // we don't duplicate that genus.
    excludeGenera: ["Eucalyptus"],
  },
};

export function getTaxon(name) {
  const t = TAXA[name];
  if (!t) throw new Error(`Unknown taxon: ${name}. Available: ${Object.keys(TAXA).join(", ")}`);
  return t;
}
