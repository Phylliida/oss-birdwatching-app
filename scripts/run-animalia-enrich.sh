#!/usr/bin/env bash
# Layer Wikidata + Wikipedia onto the animal tree (data/animalia/), the same way
# run-plantae-data.sh does for plants. Both hit Wikidata / Wikipedia — different
# hosts from iNaturalist, so they coexist with the one-iNat-downloader-at-a-time
# rule and with the local iNat photo download.
#
#   02 Wikidata : image (P18, boosts photo coverage past the iNat-only baseline),
#                 IUCN status (P141), multilingual names. Batched 60/query.
#   03 Wikipedia: article summary + lead image. Per-species REST, concurrency 4.
#
# Both resume from their own cache (data/animalia/{wikidata,wiki}.json), so this
# is safe to re-run; a crash or restart just continues from the gaps. Rebuild
# the tree (build-animalia-tree.mjs) periodically to surface what's landed.
#
# This is a long run (~1.82M species): Wikidata ~hours, Wikipedia ~most of a day.
set -uo pipefail
cd "$(dirname "$0")/.."

COUNT=$(node -e 'try{console.log(require("./data/animalia/species.json").length)}catch(e){console.log(0)}')
echo "Animalia species: ${COUNT}"
if [ "${COUNT}" -lt 1000000 ]; then
  echo "ABORT: only ${COUNT} species (<1,000,000). Run scripts/enumerate-animalia.mjs first."
  exit 1
fi

echo "Launching Wikidata + Wikipedia fetchers (TAXON=animalia)..."
TAXON=animalia nohup node --max-old-space-size=12288 scripts/taxon/02-fetch-wikidata.mjs > /tmp/animalia-wikidata.log 2>&1 &
TAXON=animalia nohup node scripts/taxon/03-fetch-wikipedia.mjs > /tmp/animalia-wikipedia.log 2>&1 &

sleep 4
echo "Launched. Running fetchers:"
pgrep -af 'scripts/taxon/0[23]-fetch' | grep -v pgrep || true
echo "Logs: /tmp/animalia-wikidata.log  /tmp/animalia-wikipedia.log"
