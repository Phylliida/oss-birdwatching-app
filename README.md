# oss-birdwatching-app

An open-source, offline-friendly, **non-commercial** tree-of-life browser. It
started as a bird-watching app and grew into a general species browser: birds
(all ~11,000 species) plus a unified, lazily-loaded tree of every plant in
GBIF's backbone (~437,000 species). Browse by taxonomy — a card is a child of
the tree, click to go deeper — with photos, multilingual names, IUCN status,
range maps, Wikipedia summaries, and (for plants) edibility & uses.

Vanilla HTML/JS/CSS, no framework. See `HANDOFF.md` for architecture and the
full data pipeline.

## Quick start

```bash
npm install
npm run serve     # → http://localhost:8000
```

`data/` and the generated `web/<app>/` directories are gitignored — they're
rebuilt from the fetch + build scripts in `scripts/`.

## Plant edibility & uses data

Plant species pages can show an **Edibility & uses** section — *is it food, is
it poisonous, how do you prepare it, what are the hazards*. This is built from
two third-party datasets that you download yourself (neither is redistributed in
this repo). It is **documented uses, not a foraging or safety guide** — never
eat a wild plant without confident, expert identification.

### 1. Kew WCUPS — broad use flags (free)

The *World Checklist of Useful Plant Species* (Royal Botanic Gardens, Kew) tags
~40,000 plants with use categories (Human food, Poisons, Medicines, …).
**CC BY 4.0**, free to download.

- Download the PDF (≈11 MB) from
  <https://knb.ecoinformatics.org/view/doi:10.5063/F1CV4G34>
- Save it to `data/edibility/WCUPS_publication.pdf`
- Run `python3 scripts/parse-wcups.py` (needs `pypdf`)

### 2. Plants For A Future — the rich "how to eat" + hazards (donation)

PFAF provides edible-parts, a 1–5 edibility rating, preparation notes, and a
**Known Hazards** field for ~7,400 plants. PFAF is a small charity that funds
itself by selling this database — so to use this layer you should **make a
donation and download their database** (please don't scrape their site):

- **Get the database (supports the charity):**
  <https://pfaf.org/user/cmspage.aspx?pageid=126> · donate: <https://pfaf.org>
- Save the CSV to `data/plantsforafuture/Database_Temperate.csv`
- Run `node scripts/parse-pfaf.mjs`

PFAF data is **CC BY-NC-SA**: non-commercial use only, share-alike, and a
prominent link back to Plants For A Future must be kept wherever it's shown (the
UI does this automatically).

### Then rebuild

```bash
node scripts/build-plantae-tree.mjs   # picks up data/edibility/*.json
```

Both layers are optional — if a file is missing, that part of the section simply
doesn't appear (a plant with no data shows no section, rather than implying it's
safe to eat).

## Species discovery years

Each species page shows the year it was first described, from the **GBIF
backbone taxonomy** bulk dump (CC BY) — ~96% of plants, ~100% of birds. The year
comes from the author citation for animals (e.g. *Corvus corax* Linnaeus, 1758)
and the publication string for plants, preferring the basionym year so
recombinations still report the original description.

The describer is shown by full name where possible ("Carl Linnaeus", not "L." /
"Linnaeus") via a Wikidata author-abbreviation lookup (CC0).

```bash
mkdir -p data/gbif-backbone
curl -L https://hosted-datasets.gbif.org/datasets/backbone/current/simple.txt.gz \
  -o data/gbif-backbone/simple.txt.gz      # ≈488 MB
node scripts/fetch-author-names.mjs        # -> data/author-names.json (full names)
node scripts/parse-gbif-years.mjs          # -> data/described-years.json
# then rebuild (build-plantae-tree.mjs / 07-build-tree.mjs) to pick it up
```

## Plant photos (iNaturalist Open Data)

Most plants have no Wikidata/Commons photo, so we fill in from the **iNaturalist
Open Data** bulk dump (CC-licensed observation photos) rather than the slow
per-species API. We pick research-grade observations + the observer's primary
photo + an accepted CC licence. This roughly doubles plant photo coverage
(~16% → ~35%).

```bash
mkdir -p data/inat-opendata
for f in taxa observers observations photos; do            # ~30 GB total
  curl -L "https://inaturalist-open-data.s3.amazonaws.com/$f.csv.gz" \
    -o "data/inat-opendata/$f.csv.gz"
done
node --max-old-space-size=12288 scripts/parse-inat-opendata.mjs   # needs a big heap
node scripts/build-plantae-tree.mjs                               # surface the photos
```

(The open data has no curated "taxon photos", only observation photos; we keep
any curated API-sourced photos already in `data/plantae/inat.json` and fill the
rest from the dump.)

## Microscopic animal photos (GBIF media download)

iNaturalist barely covers the microscopic phyla (rotifers, tardigrades,
nematodes, flatworms…) — you can't field-photograph a tardigrade. GBIF, though,
aggregates **museum and specialist collections** (the Bohart Museum, the
Ramazzotti Tardigrade Collection, Smithsonian NMNH) that publish CC-licensed
micrographs. We pull those via a bulk GBIF **occurrence download** (Darwin Core
Archive, includes a `multimedia.txt` with image URLs), parsed offline — no
per-species API calls.

Needs a **free [GBIF.org](https://www.gbif.org/) account** (the download API is
authenticated). The download is filtered to the 16 microscopic phyla +
`StillImage` + CC licences, so it's small.

```bash
# 1. Submit + wait + fetch the archive (resumable; ~minutes-hours to assemble)
GBIF_USER=you GBIF_PWD=secret node scripts/gbif-media-download.mjs
# 2. Parse the DwC-A -> data/animalia/gbif-media.json (needs `unzip`)
node scripts/parse-gbif-media-dwca.mjs
# 3. Rebuild — gbif-media is used as a photo source below Commons + iNat
node --max-old-space-size=24576 scripts/build-animalia-tree.mjs
```

The download gets a citable DOI (stored in `data/animalia/gbif-media-download.json`);
GBIF and the underlying datasets are credited per image (CC0 / CC BY / CC BY-NC).
A no-account fallback exists in `scripts/fetch-gbif-media.mjs` (slower per-species
API). 

## Plant range maps (GBIF occurrence download)

The "Where & When" heatmap needs per-species country/month/year counts. The
faceted API (`04-fetch-gbif`) gets these one species at a time, but GBIF
**deliberately rate-limits** faceted occurrence queries (HTTP 429 above
concurrency 1), so all ~437K plants would take *weeks*. The bulk download is far
faster — not because it moves less data (it moves much more), but because it's
one *allowed bandwidth-bound transfer* instead of hundreds of thousands of
*rate-limited calls*: ~60–120 GB in ~1–2 h, then a streaming aggregate.

Needs a **free GBIF.org account** (same as the media download).

```bash
# 1. Submit + wait + fetch all Plantae occurrences (~610M) as SIMPLE_CSV
GBIF_USER=you GBIF_PWD=secret node scripts/gbif-range-download.mjs
# 2. Aggregate offline -> data/plantae/gbif.json (per-species facets)
node --max-old-space-size=32768 scripts/parse-gbif-range.mjs   # needs `unzip`
# 3. Rebuild
node scripts/build-plantae-tree.mjs
```

SIMPLE_CSV carries countryCode / stateProvince / month / year /
establishmentMeans / speciesKey — every facet the range UI uses. The download
gets a citable DOI (`data/plantae/gbif-range-download.json`). The same approach
would work for animal ranges (taxonKey 1), though that's billions of records.

## Licence

App code: MIT. Bundled/displayed data follows each source's licence with
attribution preserved on every page (Wikipedia CC BY-SA, Wikidata CC0, Kew WCUPS
CC BY, Plants For A Future CC BY-NC-SA, iNaturalist/Wikimedia per-photo licences).
