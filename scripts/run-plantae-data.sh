#!/usr/bin/env bash
# Orchestrates the all-Plantae data fetch. Waits for the enumeration
# (scripts/enumerate-plantae.mjs) to finish, sanity-checks the species list,
# then launches the non-iNat data fetchers in parallel — they hit Wikidata /
# Wikipedia / GBIF, all different hosts from iNaturalist, so they coexist with
# the one-iNat-at-a-time rule. iNat for plants is launched separately, AFTER
# the current per-clade iNat run finishes.
#
# Each fetcher resumes from its own cache, so this is safe to re-run.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "Waiting for enumeration to finish..."
while pgrep -f 'node scripts/enumerate-plantae.mjs' >/dev/null; do sleep 10; done

COUNT=$(node -e 'try{console.log(require("./data/plantae/species.json").length)}catch(e){console.log(0)}')
echo "Enumeration done: ${COUNT} species"
if [ "${COUNT}" -lt 400000 ]; then
  echo "ABORT: only ${COUNT} species (<400000). Re-run scripts/enumerate-plantae.mjs to finish enumeration, then re-run this."
  exit 1
fi

echo "Launching Wikidata + Wikipedia + GBIF fetchers (TAXON=plantae)..."
TAXON=plantae nohup node scripts/taxon/02-fetch-wikidata.mjs  > /tmp/plantae-wikidata.log  2>&1 &
TAXON=plantae nohup node scripts/taxon/03-fetch-wikipedia.mjs > /tmp/plantae-wikipedia.log 2>&1 &
GBIF_CONCURRENCY=3 GBIF_DELAY_MS=150 TAXON=plantae nohup node scripts/taxon/04-fetch-gbif.mjs > /tmp/plantae-gbif.log 2>&1 &

sleep 4
echo "Launched. Running fetchers:"
pgrep -af 'scripts/taxon/0[234]-fetch' | grep -v pgrep || true
echo "Logs: /tmp/plantae-wikidata.log  /tmp/plantae-wikipedia.log  /tmp/plantae-gbif.log"
