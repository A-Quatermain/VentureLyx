"""
Venturelyx :: zip -> county lookup for Broward/Palm Beach, for the
corporate file (which has a City/Zip but NO County field — the
fictitious name file does carry a literal County field, so it never
needs this). Draft list built in Phase 1 from the Census 2020
ZCTA-to-county relationship file:
https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
(cited per the brief). 108 zips total; 5 of them also sit in Martin or
Hendry county (33438, 33440, 33458, 33469, 33478) — kept in this list
since they DO touch Broward/Palm Beach, not excluded.
"""
from __future__ import annotations

import json
from pathlib import Path

_DATA_PATH = Path(__file__).parent / "zip_county_data.json"
ZIP_TO_COUNTIES: dict[str, list[str]] = json.loads(_DATA_PATH.read_text())


def counties_for_zip(zip_code: str) -> list[str]:
    return ZIP_TO_COUNTIES.get((zip_code or "")[:5], [])


def zip_matches_counties(zip_code: str, wanted_counties: list[str]) -> bool:
    wanted = {c.upper() for c in wanted_counties}
    return bool(set(counties_for_zip(zip_code)) & wanted)
