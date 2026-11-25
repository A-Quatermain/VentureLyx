"""
Venturelyx :: LeadSource quarterly backfill (Phase 4).

The quarterly Sunbiz file (sunbiz.QUARTERLY_DIR) is a full historical
snapshot — ~13M records, active and inactive, back decades — not that
quarter's new filings (confirmed by hand in Phase 4: the first record
sampled was a 2016 filing marked inactive). At ~1,412 bytes/row average
once in leadsource_raw_records, ingesting it unfiltered would add roughly
18-20GB to Postgres against the ~37GB this host had free when measured —
half the headroom on a single-host box, for data most of it would never
be used. So unlike the daily file (upsert everything, filter at fan-out),
this filters BEFORE upsert: only status='A' records whose filing_type and
county are something at least one currently-enabled org has actually
asked for (leadsource_settings, unioned across orgs — see
get_backfill_filters). No file_date filter — recovering history the daily
ingest never saw is the entire point.

Each ~1.87GB member is extracted, streamed, filtered, and deleted before
the next one starts (sunbiz.extract_quarterly_member /
parser.iter_cor_records) — at most one member's worth of disk in use at
any time, and the memory footprint stays flat (a chunked read, never the
whole file in a list) regardless of file size.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time

import db
import ingest
import parser
import sunbiz
import zips

log = logging.getLogger("vx.leadsource.quarterly")

WORK_DIR = "/tmp/leadsource_quarterly"
ZIP_PATH = f"{WORK_DIR}/cordata.zip"
UPSERT_BATCH_SIZE = 2000


def get_backfill_filters(conn) -> dict:
    """Union of filing_types/counties across every org with LeadSource
    enabled — the same settings the daily ingest already reads per org
    (ingest.get_enabled_orgs), just aggregated into one filter set here
    since this file is shared, not fanned out per org at ingest time."""
    with db.staff_tx(conn) as cur:
        cur.execute(
            """SELECT COALESCE(s.filing_types, ARRAY['DOMP','FLAL','FORP','FORL']) AS filing_types,
                      COALESCE(s.counties, ARRAY['BROWARD','PALM BEACH']) AS counties
                 FROM organizations o
            LEFT JOIN leadsource_settings s ON s.org_id = o.id
                WHERE o.modules->>'leadsource' = 'true' AND o.deleted_at IS NULL"""
        )
        rows = cur.fetchall()
    filing_types: set[str] = set()
    counties: set[str] = set()
    for row in rows:
        filing_types.update(row["filing_types"])
        counties.update(c.upper() for c in row["counties"])
    return {"filing_types": filing_types, "counties": counties}


def cor_matches_backfill(rec: dict, filing_types: set[str], counties: set[str]) -> bool:
    if rec.get("status") != "A":
        return False
    if rec.get("filing_type") not in filing_types:
        return False
    return zips.zip_matches_counties(rec.get("zip", ""), list(counties))


def upsert_batch(raw_conn, batch: list[dict]) -> None:
    if not batch:
        return
    with raw_conn.transaction():
        cur = raw_conn.cursor()
        for rec in batch:
            cur.execute(
                """INSERT INTO leadsource_raw_records (source, source_id, raw, last_seen_at)
                   VALUES ('fl_sunbiz_cor', %s, %s, now())
                   ON CONFLICT (source, source_id) DO UPDATE SET raw = EXCLUDED.raw, last_seen_at = now()""",
                (rec["corp_number"], json.dumps(rec)),
            )


def fan_out_backfill_for_org(conn, org: dict) -> dict:
    """The per-org half of the fan-out — pulled out of
    fan_out_backfill_matches() so a test can exercise it against one
    synthetic org without also re-running it against every real
    LeadSource-enabled org in this database (a 680k-row SQL scan plus a
    row-by-row fan-out loop against real production orgs is not something
    a unit test should ever trigger as a side effect — confirmed the hard
    way once already in Phase 4).

    Filters in SQL on the JSONB columns rather than pulling the full `raw`
    blob for every row into Python — the global-matched set alone is
    ~680k rows; loading all of them as parsed dicts would multiply that by
    a wide margin and risk the worker's own memory limit. No date-window
    filter: recovering history outside any daily window is the whole
    point of this backfill existing."""
    org_id = str(org["id"])
    with db.staff_tx(conn) as cur:
        cur.execute(
            """SELECT source_id, raw->>'zip' AS zip FROM leadsource_raw_records
                WHERE source = 'fl_sunbiz_cor' AND raw->>'status' = 'A' AND raw->>'filing_type' = ANY(%s)""",
            (list(org["filing_types"]),),
        )
        rows = cur.fetchall()
    matched_ids = [r["source_id"] for r in rows if zips.zip_matches_counties(r["zip"] or "", list(org["counties"]))]
    inserted = ingest.fan_out(conn, org_id, "fl_sunbiz_cor", [{"corp_number": sid} for sid in matched_ids], "corp_number")
    return {"matched": len(matched_ids), "new_leads": inserted}


def fan_out_backfill_matches(conn) -> dict:
    """One-off fan-out over everything now sitting in leadsource_raw_records
    (not just what this run added — also self-heals any daily-ingested
    record an org's settings would match but somehow missed) — each org
    gets records matching ITS OWN filing_types/counties, not the global
    union used to decide what the backfill stored."""
    per_org: dict[str, dict] = {}
    for org in ingest.get_enabled_orgs(conn):
        result = fan_out_backfill_for_org(conn, org)
        per_org[org["name"]] = result
        log.info("quarterly fan-out org=%s matched=%d new_leads=%d", org["name"], result["matched"], result["new_leads"])
    return per_org


def run_quarterly_backfill(conn, raw_conn, job_id: int | None = None) -> dict:
    started = time.time()
    os.makedirs(WORK_DIR, exist_ok=True)

    filters = get_backfill_filters(conn)
    if not filters["filing_types"] or not filters["counties"]:
        log.info("quarterly backfill: no org has leadsource enabled with any filters — nothing to do")
        return {"status": "no_enabled_orgs"}
    log.info("quarterly backfill filters: filing_types=%s counties=%s", sorted(filters["filing_types"]), sorted(filters["counties"]))

    def heartbeat(*_args):
        if job_id is not None:
            db.touch_heartbeat(conn, job_id)

    # The downloaded zip is deliberately NOT cleaned up on failure — a
    # download can take the better part of an hour (Phase 4: 48.7 minutes
    # for the full file), and sunbiz.download_quarterly_file resumes from
    # whatever bytes are already on disk. A job retry (job_queue's own
    # exponential backoff) should pick up where a transient failure left
    # off, not restart a multi-gigabyte transfer from zero. Only a clean
    # run clears it, in the "ok" branch below.
    size = sunbiz.download_quarterly_file(ZIP_PATH, on_progress=heartbeat)
    log.info("quarterly zip ready: %d bytes", size)
    heartbeat()

    members = sunbiz.list_quarterly_members(ZIP_PATH)
    log.info("quarterly members: %s", members)

    total_scanned = 0
    total_matched = 0
    total_upserted = 0
    per_member: dict[str, int] = {}

    for member in members:
        member_path = sunbiz.extract_quarterly_member(ZIP_PATH, member, WORK_DIR)
        try:
            scanned = 0
            matched = 0
            batch: list[dict] = []
            with open(member_path, "rb") as f:
                for rec in parser.iter_cor_records(f):
                    scanned += 1
                    if cor_matches_backfill(rec, filters["filing_types"], filters["counties"]):
                        matched += 1
                        batch.append(rec)
                        if len(batch) >= UPSERT_BATCH_SIZE:
                            upsert_batch(raw_conn, batch)
                            total_upserted += len(batch)
                            batch = []
                upsert_batch(raw_conn, batch)
                total_upserted += len(batch)
            per_member[member] = matched
            total_scanned += scanned
            total_matched += matched
            log.info("quarterly member=%s scanned=%d matched=%d", member, scanned, matched)
        finally:
            os.remove(member_path)  # one member's disk at a time — never all 10 extracted together
        heartbeat()  # each member takes a few minutes, well under the 30-min stale threshold, but cheap insurance

    # Every member processed without error — the zip's job is done; a
    # fresh run next quarter re-downloads from scratch anyway (it's a
    # full-replace snapshot, not an incremental one).
    if os.path.exists(ZIP_PATH):
        os.remove(ZIP_PATH)
    shutil.rmtree(WORK_DIR, ignore_errors=True)

    per_org = fan_out_backfill_matches(conn)
    elapsed = time.time() - started

    return {
        "status": "ok", "total_scanned": total_scanned, "total_matched": total_matched,
        "total_upserted": total_upserted, "per_member": per_member, "per_org": per_org,
        "filters": {"filing_types": sorted(filters["filing_types"]), "counties": sorted(filters["counties"])},
        "elapsed_s": round(elapsed, 1),
    }


def run_quarterly_backfill_job(conn, job: dict) -> dict:
    raw_conn = db.connect_raw()
    try:
        return run_quarterly_backfill(conn, raw_conn, job_id=job["id"])
    finally:
        raw_conn.close()
