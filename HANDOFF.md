# Handoff

What this project is, what's been built, what's left, and how to keep going.

## What it is

A static, offline-friendly, non-commercial tree-of-life browser. Top-level
landing at `/` shows kingdoms → groups → apps. Each "app" is a hierarchical
species browser for a specific clade (Birds, Conifers, Oaks, etc.) and shares
a single SPA shell.

## Apps shipped

17 in total, all sharing `web/_shell/`:

| Path | Clade | Notes |
|---|---|---|
| `/birds/` | Aves | 11,227 species — the most feature-complete app |
| `/trees/` | Pinopsida (Conifers) | 9 families, 1,160 taxa |
| `/cycads/` | Cycadopsida | ~340 living, includes fossils |
| `/ginkgo/` | Ginkgoopsida | 1 living species + fossils |
| `/gnetales/` | Gnetopsida | Welwitschia, Gnetum, Ephedra |
| `/magnolias/` | Magnoliaceae | |
| `/laurels/` | Lauraceae | Avocado, cinnamon, bay |
| `/palms/` | Arecaceae | |
| `/oaks/` | Quercus | |
| `/birches/` | Betulaceae | |
| `/maples/` | Acer | |
| `/willows/` | Salicaceae | |
| `/figs/` | Ficus | |
| `/acacias/` | Acacia | |
| `/rosaceae/` | Rose family | Apples, cherries, plums |
| `/myrtaceae/` | Myrtle family | Excludes Eucalyptus (its own app) |
| `/eucalypts/` | Eucalyptus | |

## Feature surface (sub-apps)

Per species page:
- Photo with attribution (Wikimedia Commons + iNat, license-filtered)
- Audio + sonogram (birds only — xeno-canto)
- Wikipedia summary with CC-BY-SA credit + link
- AVONET traits (birds only) and Wikidata wingspan
- GBIF observation summary (Where & When) with **world heatmap**
- Sister species (BirdTree for birds, OToL for plants)
- Subspecies (birds, from IOC)
- Multilingual common names (Wikidata)
- IUCN Red List badge with Wikipedia-style 7-step ladder + bracket labels
- eBird code (birds) + iNat species page link
- Cross-taxonomy synonyms (BirdLife / eBird / BirdTree disagreements)
- "Closest relatives" with Mya divergence (birds) or edge distance (plants)
- Labeled photo strip: Male / Female / Juvenile / Adult variants (birds)

Per app:
- Browseable tree (Order → Family → Genus → Species or clade equivalent)
- Search box across all clades in the app
- "Near me" filter using offline point-in-polygon on Natural Earth
- About page with per-source citations (dynamic per taxon root)

## Architecture

### Skeleton + chunks

Initial `tree.json` is a lightweight skeleton: every node with `id`, `name`,
`commonName`, `parent`, `children`, plus `image` URL and the iNat-friendly
fields (`countries[]`, `states[]`, `chunkId`).

Per-species heavy data (wiki, traits, observations facets, sisters, audio,
labeledPhotos, subspecies, etc.) lives in `web/<app>/chunks/<chunkId>.json`.
The chunker walks the tree top-down; the first node whose `speciesCount` is
≤ 1000 becomes a chunk root and owns all its descendant species.

Result: initial load is small (e.g. birds = 7 MB skeleton vs the old 60 MB).
Species pages fetch one chunk on demand and cache it.

### Shared shell

`web/_shell/` holds the canonical `index.html`, `app.js`, `style.css`. Each
build script (`scripts/07-build-tree.mjs` for birds,
`scripts/taxon/07-build-tree.mjs` for everything else) copies these into the
app's directory at the end of a build. Changes only need to be made in
`_shell/`; every rebuild re-syncs.

`ROOT_ID` is detected from `tree.json` at app init (the node with
`parent == null`), so the same shell works for any taxon.

### Sub-app routing

- `/` — landing (kingdoms → groups → apps)
- `/birds/`, `/trees/`, etc. — each app is its own static directory
- Inside each app: hash routing (`#/<nodeId>`, `#/nearby`, `#/about`)

### Server mounts

`scripts/serve.mjs` serves `web/` at `localhost:8000` with three extra
mounts under absolute paths (so all sub-apps share them):
- `/audio/` → `data/audio/`
- `/images/` → `data/images/`
- `/sonograms/` → `data/sonograms/`

Plus root-level `/countries.geojson` and `/states.geojson` for the heatmap.

### Generic taxon pipeline

Adding a new plant clade is now a config-only change. Edit `scripts/taxa.mjs`
to add the GBIF backbone key + OToL ott_id + web/data dirs, then:

```bash
bash scripts/run-taxon-pipeline.sh <taxon_name>
```

This runs:
1. `01-species-list.mjs` — GBIF backbone enumeration
2. `02-fetch-wikidata.mjs` — SPARQL pass for image / IUCN / multilingual names
3. `03-fetch-wikipedia.mjs` — REST `/page/summary/` endpoint
4. `04-fetch-gbif.mjs` — country/state/month/year/establishmentMeans facets
5. (omitted from the pipeline by design) — iNat photos; run separately
6. `06-otol-sisters.mjs` — Open Tree subtree → per-species sister list
7. `07-build-tree.mjs` — skeleton + chunks under `web/<app>/`

iNat (step 5) is intentionally not in the pipeline because we hold the rule
"only one iNat downloader at a time" (see Lessons below).

## Key lessons learned

- **GBIF over-splits species.** "Accepted" lists at GBIF backbone include
  varieties, old synonyms, and fossil species. ~2× to 3× inflation is typical.
  We filter at build time: species with no data signal (no Wikipedia, no
  image, no IUCN, no real vernacular name, no GBIF observations, no iNat
  photo) get dropped. Cleanest coverage we got: Eucalypts at 89% Wikipedia,
  Conifers at 61%, Birds at 98.5%.

- **Wikidata is sparse for plants.** Plant taxa rarely have `P574` (year of
  taxon name publication), `P5208` (life form), or `P2052` (max age). We
  verified on Pinus sylvestris and Sequoiadendron giganteum — both empty.
  Don't bother fetching these without NLP from Wikipedia article bodies.

- **OToL synthesis prunes contested taxa.** Pinopsida, Quercus, Fagaceae —
  all return "broken / pruned_ott_id". Fall back to family-level subtrees or
  accept missing sister species. Documented in code as `otolFamilyMode`.

- **iNat photo size variants.** `default_photo.medium_url` is 500px and
  looks pixelated in a 1024px slot. `large.jpg` (1024px) is what we want.
  Worse — some `medium_url` fields are null and the fetcher fell back to
  `url`, which is the square 75px thumbnail. Fix is a single regex that
  upgrades `/square.` / `/small.` / `/medium.` → `/large.` (see `largeInat`
  in `scripts/07-build-tree.mjs` and the same regex in download scripts).

- **xeno-canto hot-link blocking.** Their CDN returns 200 to curl but
  effectively blocks browser hot-linking via Cloudflare. Download
  sonograms + audio locally and serve via the mount at `/sonograms/` and
  `/audio/`.

- **Per-photo CC attribution.** For Wikimedia Commons photos we hit the
  MediaWiki API once per file to pull `extmetadata.Artist` + license; this
  gets baked into `tree.json` so the credit line names the human author.
  iNat returns attribution in the photo object — we trust that string and
  display it verbatim.

- **License filtering happens at build, not fetch.** Some older fetcher
  runs stored ARR or ND photos in caches; the build-tree script applies a
  strict `OK_LICENSES` set so legacy data still gets cleaned up. We dropped
  328 species from the bird app this way.

- **One iNat downloader at a time.** Two concurrent iNat fetchers tank each
  other's rate budget; the labeled-photos and conifer-extras run we tried
  in parallel both slowed dramatically. Hard rule going forward — saved as
  feedback memory in `~/.claude/projects/...memory/feedback_inat_rate.md`.

- **Wikidata SPARQL flakes.** We see occasional HTTP 502 from
  `query.wikidata.org`. The Wikidata fetcher now retries 5× with exponential
  backoff (2s, 4s, 8s, 16s, 32s), saves progress every 600 species, and
  resumes from cache on re-run.

## What's running right now (when handed off)

- **Secondary photo downloader** (`scripts/33-download-secondary-photos.mjs`).
  ~18,765 photos queued (labeled + extras for birds). At ~2 concurrent +
  400 ms delay it's a multi-hour run. Files land in
  `data/images/<slug>-<variant>.jpg` and the build picks them up
  automatically the next time `npm run build-tree` is run.

## Pending work

### Immediate

- **Rebuild birds tree after secondary photo download completes** to switch
  remote iNat thumb URLs to local `/images/` paths.

- **Resume conifer iNat photos** (Task #26 — paused at ~850 of 2014 species
  cached). The script lives at `scripts/conifers/06-fetch-inat.mjs` but the
  generic `scripts/taxon/05-fetch-inat.mjs` is the version to use going
  forward (set `TAXON=conifers`).

- **Run iNat for the other 15 plant clades** one at a time (per the
  one-iNat-at-a-time rule). At ~1 sec/req each clade is 10–30 min.

### Nice-to-have

- **Display bird elevation data.** Already fetched (`data/gbif-elevation.json`,
  8,058 species). Build-tree doesn't expose it yet — could surface as a
  "typical elevation: X m" stat in the morphology section.

- **Establishment means rendering** for plants. The GBIF facet is captured
  but the UI doesn't show native/introduced status per region. Easy
  addition in `renderObservations`.

- **Search across all sub-apps.** Each app has in-app search but the
  landing has no cross-app search. Would require a small index served from
  the landing.

- **Re-fetch iNat extras for plants.** Currently empty — `inat-extras.json`
  was only populated for birds. Plants would benefit from extra photos.

- **Color extraction** from downloaded photos to power a "yellow bird"
  filter. Local processing; documented as a future idea but not built.

## Things deliberately not done

- **Full Wikipedia article bodies.** Would double the text payload and
  requires HTML-to-plain-text parsing. Summary endpoint is enough for now.

- **All ~350K vascular plants.** Multi-day fetch, skeleton would blow past
  50 MB and require chunking the skeleton itself. The user opted for 16
  curated tree clades instead.

- **Bird audio re-encoded for smaller files.** Storage is fine on dev
  machine (~5 GB audio), but if packaging into a mobile bundle becomes a
  goal, Opus re-encoding could shrink ~5×.

- **eBird Status & Trends maps.** Per-week migration maps would be a huge
  visual upgrade for birds, but needs eBird API key + several GB of data.

## How to rebuild from scratch

`data/` and per-app `web/<app>/` are gitignored. To rebuild:

1. Install: `npm install`
2. Fetch bird data (many hours): `npm run fetch-taxonomy`, then chain through
   scripts 02–32 (see `package.json` for the named scripts).
3. Fetch plant data: `bash scripts/run-taxon-pipeline.sh <taxon>` per clade.
4. Build all: `npm run build-tree` (birds) and
   `TAXON=<name> node scripts/taxon/07-build-tree.mjs` per plant clade.
5. Aggregate landing: `node scripts/aggregate-landing.mjs`.
6. Serve: `npm run serve` → http://localhost:8000

For xeno-canto specifically you'll need an API key. Get one at
https://xeno-canto.org/account and pass via env:
`XC_API_KEY=... npm run fetch-xc`.

## Source layout

```
scripts/
  taxa.mjs                      # per-taxon config (rootKey, ottId, paths)
  taxon/                        # generic pipeline (TAXON=<name>)
    01-species-list.mjs         # GBIF backbone enumeration
    02-fetch-wikidata.mjs       # SPARQL: image/IUCN/multilingual names
    03-fetch-wikipedia.mjs      # REST /page/summary/
    04-fetch-gbif.mjs           # country/state/year/month facets
    05-fetch-inat.mjs           # taxonId + top CC photos (NOT in pipeline)
    06-otol-sisters.mjs         # Open Tree subtree → sister species
    07-build-tree.mjs           # skeleton + chunks → web/<app>/
  conifers/                     # superseded by scripts/taxon/ (kept for reference)
  01-32 ...                     # bird-specific pipeline (older, more elaborate)
  run-taxon-pipeline.sh         # runs 01→07 for one or more taxa, in series

web/
  _shell/                       # canonical SPA (HTML + JS + CSS)
  index.html                    # landing page (hash-routed kingdom tree)
  landing.json                  # generated by scripts/aggregate-landing.mjs
  countries.geojson             # Natural Earth 1:110m countries (trimmed)
  states.geojson                # Natural Earth 1:50m admin1 (trimmed)
  birds/, trees/, oaks/, ...    # generated app outputs (gitignored)

data/                           # all fetched data (gitignored)
  audio/, images/, sonograms/   # downloaded media
  *.json                        # per-source caches
```
