#!/usr/bin/env bash
# Run the full pipeline (species list → Wikidata → Wikipedia → GBIF range →
# OToL sisters → build) for one or more taxa, in series.
#
# Usage:  bash scripts/run-taxon-pipeline.sh taxon1 taxon2 ...
# Example: bash scripts/run-taxon-pipeline.sh cycads ginkgo gnetales
set -euo pipefail

for TAXON in "$@"; do
  echo "================================================================"
  echo "  $TAXON"
  echo "================================================================"
  echo
  TAXON=$TAXON node scripts/taxon/01-species-list.mjs
  echo
  TAXON=$TAXON node scripts/taxon/02-fetch-wikidata.mjs
  echo
  TAXON=$TAXON node scripts/taxon/03-fetch-wikipedia.mjs
  echo
  TAXON=$TAXON node scripts/taxon/04-fetch-gbif.mjs
  echo
  TAXON=$TAXON node scripts/taxon/06-otol-sisters.mjs || echo "  (OToL failed — skipping)"
  echo
  TAXON=$TAXON node scripts/taxon/07-build-tree.mjs
  echo
  echo "Done with $TAXON"
  echo
done
echo "All taxa processed."
