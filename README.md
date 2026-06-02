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

## Licence

App code: MIT. Bundled/displayed data follows each source's licence with
attribution preserved on every page (Wikipedia CC BY-SA, Wikidata CC0, Kew WCUPS
CC BY, Plants For A Future CC BY-NC-SA, iNaturalist/Wikimedia per-photo licences).
