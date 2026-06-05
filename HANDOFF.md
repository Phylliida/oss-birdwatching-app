# Handoff

What this project is, what's been built, what's left, and how to keep going.

## What it is

A static, offline-friendly, non-commercial **tree-of-life browser**. Vanilla
HTML/JS/CSS, no framework. Landing page at `/` shows kingdoms → groups, and from
there you traverse into two deep species browsers that share one SPA shell:

- **`/birds/`** — all ~11,227 birds (the original, most feature-dense app).
- **`/plantae/`** — a single unified, lazily-loaded tree of **every plant in
  GBIF's backbone (~436,707 species)**: Kingdom → phylum → class → order →
  family → genus → species. This is the headline thing; it replaced the older
  idea of ~16 separate curated clade apps.

The 16 clade apps (`/oaks/`, `/palms/`, …) still build and exist but are now
**superseded/orphaned** — the landing's Plantae card goes to `/plantae/`, not to
them. They're kept because their per-clade iNat run produced curated photos that
were merged into the unified tree.

## Feature surface

**Species page** (a card is a child of the tree; click to go deeper):
- Photo with attribution + licence (Commons via Wikidata P18, or iNaturalist).
  When there's no Commons photo, the first iNat photo becomes the card thumbnail.
- **Edibility & uses** (plants) — Kew WCUPS category flags (Human food / Poison /
  Medicine / …) + Plants For A Future detail (1–5 rating, how-to-eat, **Known
  hazards**). Framed as documented uses, *not* a foraging guide; toxicity shown
  as prominently as edibility; absence shows nothing (never implies "safe").
- **Growing & cultivation** (plants, PFAF) — decoded conditions grid (light,
  moisture, soil, pH, hardiness, habit, growth rate), tolerance tags, plus
  habitat / native range / cultivation / propagation prose.
- **First described** — year + full discoverer name ("First described 1758 ·
  Carl Linnaeus"), from the GBIF backbone + a Wikidata author-name lookup.
- Wikipedia summary (CC-BY-SA credit + link).
- GBIF "Where & When" with a world heatmap; IUCN badge (Wikipedia-style scale,
  muted colours); multilingual names; "closest relatives"; iNaturalist link.
- Birds also: AVONET traits, xeno-canto audio + sonogram, IOC subspecies,
  eBird code, labeled photo strip (Male/Female/Juvenile/Adult), cross-taxonomy
  synonyms.

**Clade page** (order/class/family/…): Wikipedia summary at the top + the
taxon's own lead photo + child cards.

**App-wide:** in-app search, "Near me" offline point-in-polygon filter (birds;
plants stream/empty), About page, and a **dark-mode toggle** (☾/☀ in the nav,
persisted in localStorage, respects `prefers-color-scheme`).

## Architecture

### Birds: skeleton + chunks
`web/birds/tree.json` is a full light skeleton of every node; heavy per-species
data lives in `web/birds/chunks/<chunkId>.json` (chunk root = first node with
`speciesCount ≤ 1000`). ~8.5 MB skeleton; chunks load on demand.

### Plantae: lazy trunk + genus chunks (the big one)
436K species is too big for one skeleton, so `scripts/build-plantae-tree.mjs`
emits:
- **`web/plantae/tree.json`** — a "trunk" with `lazy: true` holding every node
  **down to genus** (~21.7K nodes, ~5 MB), loaded up front. Genus nodes are
  stubs carrying `chunkId` + `lazyChildren: true`.
- **`web/plantae/chunks/<genusId>.json`** — one chunk per genus (~20.3K files,
  avg ~20 KB) with that genus's full species (light + heavy merged).

The shared shell (`web/_shell/app.js`) understands `lazy`: opening a genus
fetches its chunk and merges the species into `tree.nodes`; a deep link to a
species resolves its genus from the `s-Genus-epithet` id. Higher-rank clade
pages (order/family) carry their Wikipedia summary in the trunk; genus pages are
link-only (their summary would bloat the up-front load — see Pending).

### Shared shell
`web/_shell/{index.html,app.js,style.css}` is the canonical SPA. Each build
copies it into the app dir. `ROOT_ID` is resolved from the `parent == null`
node, so one shell serves birds, plantae, and the clade apps. Edit `_shell/`
then rebuild (or `cp` it into the app dirs) to propagate.

### Server mounts (`scripts/serve.mjs`, localhost:8000)
`/audio/`→`data/audio/`, `/images/`→`data/images/`, `/sonograms/`→`data/sonograms/`,
plus root `/countries.geojson` + `/states.geojson` for the heatmap.

## Data sources & how to obtain them

`data/` is gitignored, so the dumps below are local. **Big lesson: bulk dumps
beat per-species API crawls.** Three datasets we pull as bulk files:

| Layer | Source (bulk) | Notes |
|---|---|---|
| Discovery years | GBIF backbone `simple.txt.gz` (~488 MB, CC BY) | `scripts/parse-gbif-years.mjs`. Year from authorship (animals) / publication string (plants); prefer the **basionym** year so recombinations report the original. |
| Author full names | Wikidata P428 (botanical) + P835 (zoological) | `scripts/fetch-author-names.mjs` → `data/author-names.json`. "L." and "Linnaeus" both → "Carl Linnaeus". |
| Plant photos | iNaturalist Open Data (`taxa`/`observations`/`photos` CSVs, ~30 GB, CC) | `scripts/parse-inat-opendata.mjs` (needs `--max-old-space-size=12288`). Research-grade + observer's primary photo + accepted CC licence. ~16% → ~35% coverage. |
| Edibility flags | Kew WCUPS PDF (689 pp, CC BY) | `scripts/parse-wcups.py` (pypdf) → `data/edibility/wcups.json`. |
| Edibility detail | Plants For A Future CSV (donation, CC BY-NC-SA) | `scripts/parse-pfaf.mjs`. Keep the prominent PFAF link in the UI. |
| Higher-taxon photos + summaries | Wikidata P225 + Wikipedia REST | `scripts/fetch-higher-taxa-images.mjs`. P225 (not title guessing) avoids wrong articles (e.g. "Lesbia" the genus, not the poet); kingdom-namespaced cache for homonyms. |

README.md documents the exact download commands for each.

## The plant pipeline (how `/plantae/` is built)

1. `scripts/enumerate-plantae.mjs` — per-order GBIF enumeration under kingdom
   key 6, capturing full lineage → `data/plantae/species.json` (436,707).
2. Generic fetchers run with `TAXON=plantae` against `data/plantae/`:
   `02-fetch-wikidata` (P18/IUCN/names), `03-fetch-wikipedia` (summaries),
   `04-fetch-gbif` (range facets). `scripts/run-plantae-data.sh` orchestrates
   them in parallel (different hosts).
3. Bulk layers above (years, edibility, iNat photos, higher-taxa).
4. `scripts/build-plantae-tree.mjs` → trunk + chunks; prefers locally-downloaded
   iNat photos (`data/images/inat-<id>.<ext>`) when present, else streams.
5. `scripts/aggregate-landing.mjs` → `web/landing.json` for the landing cards.

## Key lessons learned

- **Bulk dumps > per-species API crawls.** GBIF backbone (years) and iNat Open
  Data (photos) each replaced a multi-day/multi-week API crawl with a ~hours
  download + offline join. Always check for a bulk dump first.
- **`pkill -f <pattern>` self-matches your own shell** when the pattern is in the
  command line — it killed my launcher mid-script several times (exit 144) and
  once spawned a *second* downloader that corrupted a 12 GB file via concurrent
  writes. Use file-based scripts (pattern lives in the file, not the cmdline),
  or kill by exact PID, and verify downloads with `gunzip -t`.
- **Big joins OOM at the default heap.** The iNat open-data join needs
  `node --max-old-space-size=12288`.
- **Watch dump column offsets.** GBIF backbone `simple.txt.gz` is header-less and
  I was off by one; the year also lives in the *basionym* columns for
  recombinations. Always dump a known row and index every field first.
- **Resolve higher taxa via Wikidata P225, not Wikipedia titles.** Titles return
  wrong primary topics for ambiguous genus names. For ranks with no P225 match,
  a title fallback is safe only for unambiguous suffixes (-aceae/-ales/-phyta…).
- **One iNat downloader at a time** (rate budget). Saved as a feedback memory.
- **License-filter at build, not fetch** (legacy caches may hold ARR/ND);
  `OK_LICENSES` = cc0/pd/cc-by/cc-by-sa/cc-by-nc/cc-by-nc-sa.
- Wikidata SPARQL flakes (502s) → retry + backoff + resume; deep `OFFSET`
  pagination times out → use keyset pagination on the value.

## What's running right now (at handoff)

- **GBIF range-map crawl** (`TAXON=plantae 04-fetch-gbif`) — the only remaining
  fetcher, ~weeks (deliberately slow at concurrency 1; faceted occurrence
  queries are heavy). Resumable. Rebuild `/plantae/` periodically to surface new
  heatmaps.
- **Local iNat photo download** (`scripts/download-inat-photos.mjs`) — fetching
  ~525K medium plant photos to `data/images/inat-<id>.<ext>` (~67 GB) so plants
  are fully offline like birds. Resumable (skips existing). Once done, rebuild
  `/plantae/` so it points at the local files (the build already prefers them).

## Pending / nice-to-have

- **Final `/plantae/` rebuild** once the local photo download + GBIF crawl wrap.
- **Genus-page Wikipedia summaries** for plants — skipped (would bloat the trunk).
  Tuck each genus's summary into its on-demand chunk instead.
- **Merge Birds into the unified tree** so it's one seamless "Living things" tree
  rather than the landing linking out to `/birds/`.
- Display bird elevation (`data/gbif-elevation.json`, already fetched); plant
  establishment-means (native/introduced); cross-app search; colour-extraction
  "yellow flower" filter.

## How to rebuild from scratch

`data/` and generated `web/<app>/` are gitignored. `npm install`, then:
- Birds: `npm run fetch-taxonomy` + scripts 02–32 (see `package.json`),
  `npm run build-tree`.
- Plants: `scripts/enumerate-plantae.mjs` → `scripts/run-plantae-data.sh` →
  the bulk layers (see "Data sources" + README) → `scripts/build-plantae-tree.mjs`.
- `node scripts/aggregate-landing.mjs`, then `npm run serve` → localhost:8000.

## Source layout (selected)

```
scripts/
  enumerate-plantae.mjs        # GBIF enumeration of all Plantae (full lineage)
  build-plantae-tree.mjs       # lazy trunk + genus chunks for /plantae/
  run-plantae-data.sh          # orchestrate wikidata+wikipedia+gbif for plantae
  parse-gbif-years.mjs         # discovery years from GBIF backbone dump
  fetch-author-names.mjs       # Wikidata P428/P835 -> full author names
  parse-inat-opendata.mjs      # plant photos from iNat Open Data dump
  download-inat-photos.mjs     # download those photos locally (offline)
  parse-wcups.py / parse-pfaf.mjs   # edibility (Kew WCUPS / PFAF)
  fetch-higher-taxa-images.mjs # higher-taxon photos + summaries (Wikidata P225)
  aggregate-landing.mjs        # web/landing.json
  taxa.mjs, taxon/01..07, run-taxon-pipeline.sh   # the (now-superseded) clade pipeline
  07-build-tree.mjs, 01-32 ...                    # bird-specific pipeline
web/
  _shell/                      # canonical SPA (HTML+JS+CSS); dark mode lives here
  index.html, landing.json     # landing page + generated manifest
  birds/, plantae/, oaks/ ...  # generated app outputs (gitignored)
data/                          # all fetched data + media (gitignored)
  images/ audio/ sonograms/    # local media (incl. data/images/inat-<id>.<ext>)
  plantae/                     # species.json + per-source caches for the unified tree
  inat-opendata/ gbif-backbone/ edibility/   # bulk dumps
```
