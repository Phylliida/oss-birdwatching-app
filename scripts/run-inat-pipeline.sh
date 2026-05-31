#!/usr/bin/env bash
# Runs the iNat photo fetcher for one taxon at a time, respecting the
# "one iNat downloader at a time" rule. Resumes from cached data, so it's
# safe to re-run.
#
# Usage:  bash scripts/run-inat-pipeline.sh [taxon ...]
# Example: bash scripts/run-inat-pipeline.sh conifers oaks palms ...
#
# After all taxa finish, rebuild each app so tree.json picks up the new
# extraPhotos + inatId fields.
set -euo pipefail

for TAXON in "$@"; do
  echo "================================================================"
  echo "  iNat: $TAXON"
  echo "================================================================"
  TAXON=$TAXON node scripts/taxon/05-fetch-inat.mjs
  echo
  TAXON=$TAXON node scripts/taxon/07-build-tree.mjs
  echo "Done with $TAXON"
  echo
done

# Refresh the landing manifest in case any reprImg changed.
node scripts/aggregate-landing.mjs
echo "All taxa processed."
