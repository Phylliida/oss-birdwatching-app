#!/usr/bin/env python3
# Parse Kew's "World Checklist of Useful Plant Species" (2020) into a
# binomial -> [use-category codes] map.
#
# WCUPS is published only as a 689-page PDF (no public CSV), licensed CC BY 4.0.
# Download it first (≈11 MB) from either:
#   https://knb.ecoinformatics.org/view/doi:10.5063/F1CV4G34
#   https://kew.iro.bl.uk/concern/datasets/7243d727-e28d-419d-a8f7-9ebef5b9e03e
# and save it to data/edibility/WCUPS_publication.pdf
#
# Each species entry in the PDF looks like:
#     Themeda triandra Forssk.
#      424213-1 | AF EU GS HF MA ME PO | [3, 4, 5, 8, 9, 11]
# i.e. a name line, then "<IPNI-id> | <CODES> [| [refs]]". The 2-letter codes:
#   AF Animal food   EU Environmental   FU Fuels      GS Gene sources
#   HF Human food    IF Invertebrate    MA Materials  ME Medicines
#   PO Poisons       SU Social uses
#
# Requires pypdf (already present). Output: data/edibility/wcups.json
#
# Attribution (CC BY 4.0): Royal Botanic Gardens, Kew — World Checklist of
# Useful Plant Species (2020). https://doi.org/10.5063/F1CV4G34

import re, json, sys, os
from pypdf import PdfReader

SRC = "data/edibility/WCUPS_publication.pdf"
OUT = "data/edibility/wcups.json"

CODE_LINE = re.compile(r'^\s*\d+-\d+\s*\|\s*([A-Z]{2}(?:\s+[A-Z]{2})*)\s*(?:\|.*)?$')
BINOMIAL  = re.compile(r'([A-Z][a-zëïöüáéíóúñâ-]+)\s+([a-zëïöüáéíóúñâ-]{2,})')
SKIP = ('World Checklist of Useful', 'diazgranados', 'Database developed by RBG Kew')

if not os.path.exists(SRC):
    sys.exit(f"Missing {SRC} — download the WCUPS PDF first (see header).")

reader = PdfReader(SRC)
out, buf = {}, []
for page in reader.pages:
    for raw in (page.extract_text() or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if any(s in line for s in SKIP) or re.match(r'^Page \d+ of \d+', line):
            buf = []
            continue
        m = CODE_LINE.match(line)
        if m:
            bm = BINOMIAL.search(" ".join(buf))
            if bm:
                out.setdefault(f"{bm.group(1)} {bm.group(2)}", set()).update(m.group(1).split())
            buf = []
        else:
            buf.append(line)

out = {k: sorted(v) for k, v in out.items()}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w"))
print(f"Wrote {OUT} — {len(out):,} species with use categories")
