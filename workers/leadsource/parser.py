"""
Venturelyx :: Florida Sunbiz fixed-width file parser.

Byte offsets verified against real data in Phase 1 (docs/specs — see that
investigation's own report: line length, encoding, every Filing Type/
Status/RA Type value observed fell inside the expected code sets, and
reading real zips -> real FL city names back out through Census data
cross-checked the whole left-to-right layout independently). 1-based
start positions below, exactly as given; converted to 0-based slices here.
"""
from __future__ import annotations

from datetime import date
from typing import BinaryIO, Iterator

COR_RECORD_LEN = 1440

# (name, start_1based, length)
COR_FIELDS = [
    ("corp_number", 1, 12),
    ("corp_name", 13, 192),
    ("status", 205, 1),
    ("filing_type", 206, 15),
    ("addr1", 221, 42),
    ("addr2", 263, 42),
    ("city", 305, 28),
    ("state", 333, 2),
    ("zip", 335, 10),
    ("country", 345, 2),
    ("mail_addr1", 347, 42),
    ("mail_addr2", 389, 42),
    ("mail_city", 431, 28),
    ("mail_state", 459, 2),
    ("mail_zip", 461, 10),
    ("mail_country", 471, 2),
    ("file_date", 473, 8),
    ("fei_number", 481, 14),
    ("gt6_officers_flag", 495, 1),
    ("last_trans_date", 496, 8),
    ("state_country", 504, 2),
    ("ra_name", 545, 42),
    ("ra_type", 587, 1),
    ("ra_address", 588, 42),
    ("ra_city", 630, 28),
    ("ra_state", 658, 2),
    ("ra_zip4", 660, 9),
]

OFFICER_STARTS = [669, 797, 925, 1053, 1181, 1309]
OFFICER_SUBFIELDS = [
    ("title", 0, 4), ("type", 4, 1), ("name", 5, 42),
    ("address", 47, 42), ("city", 89, 28), ("state", 117, 2), ("zip4", 119, 9),
]

# Fictitious name (DBA) file — empirically derived (no structure doc was
# available for this one; confirmed against real data in Phase 1: the raw
# bytes at 205 read as a clean, space-padded, plausible county name —
# "BROWARD", "MIAMI-DADE", "MULTIPLE" — every time, for a 12-byte field).
FIC_COUNTY_START, FIC_COUNTY_LEN = 205, 12
FIC_FIELDS = [
    ("doc_number", 1, 12),
    ("name", 13, 192),
    ("county", FIC_COUNTY_START, FIC_COUNTY_LEN),
]


def _slice(line: str, start_1based: int, length: int) -> str:
    start = start_1based - 1
    return line[start:start + length].rstrip()


def parse_cor_record(line: str) -> dict:
    rec = {name: _slice(line, start, length) for name, start, length in COR_FIELDS}
    for i, ostart in enumerate(OFFICER_STARTS, start=1):
        rec[f"officer{i}"] = {name: _slice(line, ostart + rel, length) for name, rel, length in OFFICER_SUBFIELDS}
    return rec


def parse_fic_record(line: str) -> dict:
    return {name: _slice(line, start, length) for name, start, length in FIC_FIELDS}


def parse_file_date(raw: str) -> date | None:
    """MMDDYYYY, confirmed against real data in Phase 1 — not stated on
    the Sunbiz file-structure page itself."""
    if not raw or len(raw) != 8 or not raw.isdigit():
        return None
    mm, dd, yyyy = int(raw[0:2]), int(raw[2:4]), int(raw[4:8])
    try:
        return date(yyyy, mm, dd)
    except ValueError:
        return None


def parse_cor_lines(raw_bytes: bytes) -> list[dict]:
    # rstrip a trailing \r unconditionally: the daily file is LF-only (a
    # no-op here) but the quarterly snapshot is CRLF (confirmed in Phase
    # 4) — without this, every quarterly line would be 1441 bytes and
    # silently fail the length check below, dropping every record.
    lines = [l.rstrip(b"\r") for l in raw_bytes.split(b"\n") if l]
    return [parse_cor_record(l.decode("ascii", errors="replace")) for l in lines if len(l) == COR_RECORD_LEN]


def iter_cor_records(fileobj: BinaryIO, chunk_size: int = 8 * 1024 * 1024) -> Iterator[dict]:
    """Streaming counterpart to parse_cor_lines, for the quarterly
    snapshot's ~1.87GB member files — never holds more than one read
    chunk plus the current line buffer in memory (the worker container's
    own memory limit is real; loading a whole member file the way the
    daily file's few-hundred-KB files do would blow well past it)."""
    buf = b""
    while True:
        chunk = fileobj.read(chunk_size)
        if not chunk:
            break
        buf += chunk
        parts = buf.split(b"\n")
        buf = parts.pop()  # last part may be incomplete — carried to the next read
        for line in parts:
            line = line.rstrip(b"\r")
            if len(line) == COR_RECORD_LEN:
                yield parse_cor_record(line.decode("ascii", errors="replace"))
    tail = buf.rstrip(b"\r")
    if len(tail) == COR_RECORD_LEN:
        yield parse_cor_record(tail.decode("ascii", errors="replace"))


def parse_fic_lines(raw_bytes: bytes) -> list[dict]:
    lines = [l for l in raw_bytes.split(b"\n") if l]
    # Confirmed in Phase 1: this file isn't pure ASCII (a handful of
    # accented characters in business names) — decodes cleanly as latin-1.
    return [parse_fic_record(l.decode("latin-1")) for l in lines]
