# Handoff

What this project is, what's been built, what's left, and how to keep going.

## What it is

A static, offline-friendly, non-commercial **tree-of-life browser**. Vanilla
HTML/JS/CSS, no framework. Landing page at `/` shows kingdoms → groups, and from
there you traverse into three deep species browsers that share one SPA shell:

- **`/birds/`** — all ~11,227 birds (the original, most feature-dense app).
- **`/plantae/`** — a unified, lazily-loaded tree of **every plant in GBIF's
  backbone (~436,707 species)**: Kingdom → phylum → … → genus → species.
- **`/animalia/`** — a unified, lazily-loaded tree of **every animal in GBIF's
  backbone (~1,820,542 species)**. The newest and by far the biggest; Arthropoda
  alone is ~1.34M.

The 16 clade apps (`/oaks/`, `/palms/`, …) still build but are **superseded** —
the landing's Plantae card goes to `/plantae/`, Animalia to `/animalia/`. A card
is a child of the tree; click to go deeper. (Birds still link out to the rich
`/birds/` app even though all birds also appear inside `/animalia/`.)

## Feature surface

**Species page**:
- Photo with attribution + licence. Source priority: **Commons** (Wikidata P18) →
  **iNaturalist** (Open Data) → **GBIF museum media** (animals only; gap-fill for
  the microscopic phyla). `imageSource` records which.
- **Edibility & uses** (plants) — Kew WCUPS flags + Plants For A Future detail
  (1–5 rating, how-to-eat, **Known hazards**). Documented uses, *not* a foraging
  guide; toxicity shown as prominently as edibility; no data → no section.
- **Growing & cultivation** (plants, PFAF) — decoded conditions grid + prose.
- **First described** — year + full discoverer name (GBIF backbone + Wikidata
  author lookup).
- Wikipedia summary; GBIF "Where & When" heatmap; IUCN badge; multilingual names;
  closest relatives; iNaturalist link.
- Birds also: AVONET traits, xeno-canto audio + sonogram, IOC subspecies, eBird
  code, labeled photo strip (Male/Female/Juvenile/Adult), synonyms.

**Clade page** (phylum/class/order/family/…): Wikipedia summary + own lead photo
+ child cards. **App-wide:** search, "Near me" filter, About, **dark-mode toggle**.

## Architecture

One shared shell (`web/_shell/{index.html,app.js,style.css}`) serves all apps;
each build copies it into the app dir. `ROOT_ID` is resolved from the
`parent == null` node. Three tree shapes:

### Birds — skeleton + chunks
Full light skeleton (`tree.json`) + heavy per-species `chunks/<chunkId>.json`.

### Plantae — one-level lazy (trunk down to genus)
`tree.json` trunk (`lazy:true`, ~21.7K nodes to genus, ~5 MB) + one
`chunks/<genusId>.json` per genus (species). Genus nodes are lazy stubs.

### Animalia — TWO-level lazy (trunk down to family)
205K genera make a down-to-genus trunk ~50 MB, so the cut is higher:
- `tree.json` trunk down to **family** (~24.5K nodes, ~5 MB). Families are lazy.
- `chunks/f-*.json` — a family's **genus stubs** (each itself lazy).
- `chunks/g-*.json` — a genus's **species + a self-descriptor of the genus**.

The genus self-descriptor is the trick that makes deep links work with no index:
a cold link to `s-Genus-epithet` derives `g-Genus` (the chunk name), loads it
(getting the species *and* the genus node), and the genus's parent family is
already in the trunk — so the breadcrumb chain resolves all the way up.
Missing-phylum species (~0.4%, mostly BOLD-less fragments) are bucketed under an
**"Incertae sedis" pseudo-phylum** so the root stays tidy (35 phyla).

The shell's **`ensureContainerLoaded(id)`** is one generalised loader for all
three: it fetches a node's chunk, merges children into `tree.nodes`, and children
may themselves be lazy (an animal family's genera). `commonsImg()` in the builds
rewrites Commons TIFF/SVG/PDF images to a `?width=` JPEG thumbnail (browsers
can't render those formats).

### Server mounts (`scripts/serve.mjs`, localhost:8000)
`/audio/`,`/images/`,`/sonograms/` → `data/…`; root `/countries.geojson` +
`/states.geojson` for the heatmap. All local media lives in `data/images/`.

## Data sources & how to obtain them

`data/` is gitignored. **Big lesson: bulk dumps beat per-species API crawls.**

| Layer | Source (bulk) | Notes |
|---|---|---|
| Taxonomy / discovery years | GBIF backbone `simple.txt.gz` (~488 MB, CC BY) | `parse-gbif-years.mjs` (years); `enumerate-animalia.mjs` enumerates ALL animals straight from this dump — no API crawl. Header-less; prefer the basionym year. |
| Author full names | Wikidata P428 + P835 | `fetch-author-names.mjs` → `author-names.json`. |
| Plant / animal photos | iNaturalist Open Data CSVs (~30 GB, CC) | `parse-inat-opendata.mjs` (`TAXON_DIR=data/animalia` for animals; needs `--max-old-space-size`). Research-grade + observer's primary CC photo. Animals: 233K species. |
| Microscopic-animal photos | GBIF occurrence **download**, DwC-A (free account) | `gbif-media-download.mjs` (submit/poll/fetch) + `parse-gbif-media-dwca.mjs`. Museum/specialist CC images (Smithsonian, Ramazzotti, Bohart) for the meiofaunal phyla iNat can't reach. `download-gbif-media.mjs` makes them local. |
| Edibility | Kew WCUPS PDF (CC BY) + PFAF CSV (donation, CC BY-NC-SA) | `parse-wcups.py` / `parse-pfaf.mjs`. |
| Higher-taxon photos + summaries | Wikidata P225 + Wikipedia REST | `fetch-higher-taxa-images.mjs` (animals + plants; P225, not title guessing; kingdom-namespaced cache). |

README.md documents the exact commands (incl. the GBIF download login flow).

## The pipelines

**Plants** (`/plantae/`): `enumerate-plantae.mjs` → `run-plantae-data.sh`
(02 Wikidata / 03 Wikipedia / 04 GBIF) → bulk layers → `build-plantae-tree.mjs`.

**Animals** (`/animalia/`):
1. `enumerate-animalia.mjs` — all 1.82M accepted species from the backbone dump
   (the 604K "unranked" are nameless BOLD barcode bins, dropped).
2. `run-animalia-enrich.sh` — 02 Wikidata + 03 Wikipedia (`TAXON=animalia`),
   resumable, detached.
3. iNat photos (`parse-inat-opendata.mjs` + `download-inat-photos.mjs` with
   `INAT_JSON=data/animalia/inat.json`); GBIF museum media for micro-phyla.
4. `build-animalia-tree.mjs` (`--max-old-space-size=24576`) → trunk + chunks;
   prefers local `data/images/` copies; photo priority Commons → iNat → GBIF.
5. `aggregate-landing.mjs` → `web/landing.json`.

## Key lessons learned

- **Bulk dumps > per-species API crawls.** Backbone (enumeration + years), iNat
  Open Data (photos), GBIF occurrence downloads (museum media) — each one bulk
  download + offline join instead of millions of API calls. Check for a dump first.
- **GBIF occurrence DOWNLOAD (DwC-A) carries the media URLs**; the AWS Parquet
  snapshot and SIMPLE_CSV do **not** (only a `mediatype` flag). Download API needs
  a free account; it's async (submit → poll → fetch) and gets a citable DOI.
- **Two-level lazy + a genus self-descriptor** lets a deep species link resolve
  with a complete breadcrumb and **no separate index** — the parent family is
  already in the trunk.
- **Unranked animals are all nameless BOLD BINs** (`BOLD:AAO4727`) — no name, no
  wiki, no photo, so they can't be included; species is the real leaf level.
- **Browsers can't render TIFF.** Drop GBIF TIFFs (also tens of MB each);
  Wikimedia Commons rasterises TIFF/SVG/PDF to JPEG via `?width=` — use it.
- **`pkill -f <pattern>` self-matches your own shell.** Use file-based scripts or
  the `[0]2-...` bracket trick; verify downloads (`gunzip -t`).
- **Big joins / builds OOM at the default heap** → `--max-old-space-size`.
- **Watch header-less dump column offsets** (dump a known row first).
- **Resolve higher taxa via Wikidata P225, not Wikipedia titles** (ambiguous names).
- **One iNat downloader at a time** (rate budget). License-filter at build.
- **Concurrent reads race writes:** rebuilding while a fetcher writes
  `wikidata.json`/`gbif.json` can hit a partial JSON — retry the build 2–3×.

## What's running right now (at handoff)

- **Animal Wikidata + Wikipedia enrichment** (`run-animalia-enrich.sh`, detached)
  — Wikidata ~hours (images/IUCN/names, lifts photo coverage past the ~14.5%
  iNat+GBIF baseline), Wikipedia summaries a few days. Resumable.
- **Auto-rebuild watcher** (a background task) — waits for the Wikidata pass to
  exit, then rebuilds `/animalia/` + landing once to surface it (also folds in
  GBIF media). Then run `fetch-higher-taxa-images.mjs` for animal clade pages.
- **GBIF range-map crawl** (`TAXON=plantae 04-fetch-gbif`) — ~weeks, concurrency
  1. Rebuild `/plantae/` periodically to surface heatmaps.

Photos are otherwise **fully local/offline**: ~525K plant + ~870K animal iNat +
~9.6K GBIF-museum images in `data/images/`.

## Pending / nice-to-have

- **Run `fetch-higher-taxa-images.mjs`** (animals) so the 14,105 animal clade
  pages get their own lead photo + summary (deferred to protect the Wikidata run).
- **"Explore birds in detail → /birds/"** link from the animal tree's Aves page,
  and ultimately **merge Birds into the unified tree**.
- Genus-page Wikipedia summaries (tuck into the on-demand chunk, not the trunk).
- Cap GBIF museum image dimensions on download if the ~5 GB feels heavy.
- Bird elevation display; plant establishment-means; cross-app search.

## How to rebuild from scratch

`data/` and generated `web/<app>/` are gitignored. `npm install`, then:
- **Birds:** `npm run fetch-taxonomy` + scripts 02–32, `npm run build-tree`.
- **Plants:** `enumerate-plantae.mjs` → `run-plantae-data.sh` → bulk layers →
  `build-plantae-tree.mjs`.
- **Animals:** `enumerate-animalia.mjs` → `run-animalia-enrich.sh` → iNat +
  GBIF-media layers (see README) → `build-animalia-tree.mjs`.
- `node scripts/aggregate-landing.mjs`, then `npm run serve` → localhost:8000.

## Source layout (selected)

```
scripts/
  enumerate-animalia.mjs       # all Animalia from the backbone dump (offline)
  build-animalia-tree.mjs      # two-level lazy tree for /animalia/
  run-animalia-enrich.sh       # wikidata + wikipedia for animals
  gbif-media-download.mjs      # submit/poll/fetch GBIF DwC-A media download
  parse-gbif-media-dwca.mjs    # join multimedia.txt -> gbif-media.json
  download-gbif-media.mjs      # museum images -> data/images/ (offline)
  fetch-gbif-media.mjs         # no-account per-species GBIF media fallback
  enumerate-plantae.mjs, build-plantae-tree.mjs, run-plantae-data.sh
  parse-inat-opendata.mjs      # iNat Open Data join (TAXON_DIR plantae|animalia)
  download-inat-photos.mjs     # iNat photos local (INAT_JSON plantae|animalia)
  parse-gbif-years.mjs, fetch-author-names.mjs   # discovery years + names
  parse-wcups.py, parse-pfaf.mjs                 # edibility
  fetch-higher-taxa-images.mjs, aggregate-landing.mjs
  taxa.mjs                     # taxon registry (incl. plantae, animalia)
  07-build-tree.mjs, 01-32 ...                   # bird-specific pipeline
web/
  _shell/                      # canonical SPA; lazy loader + commonsImg credits
  index.html, landing.json     # landing page + generated manifest
  birds/, plantae/, animalia/, oaks/ ...   # generated outputs (gitignored)
data/                          # all fetched data + media (gitignored)
  images/                      # local media: inat-<id>.*, gbifmedia-<hash>.*, s-*
  plantae/, animalia/          # species.json + per-source caches per kingdom
  inat-opendata/ gbif-backbone/ edibility/   # bulk dumps
```
