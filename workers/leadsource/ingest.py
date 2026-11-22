"""
Venturelyx :: LeadSource daily ingest.

One run = one corporate file (+ the fictitious-name file, downloaded and
upserted into the raw table unconditionally so it's already there the
day an org later turns "include DBA" on — but only fanned out to an
org's own leadsource_leads when that org's settings actually ask for it).

Filters, per org settings:
  - status: hardcoded 'A' (active) — not a per-org setting, the design
    brief fixed this.
  - filing_type: org's configured list, checked against the corporate
    record's own filing_type.
  - file_date within file_date_window_days of the file's own date (not
    today — a daily file can contain records filed days earlier, per
    Phase 1's own finding).
  - county: the corporate file has no County field (only the fictitious
    name file does) — matched via zips.py's zip->county table instead.
    The fictitious name file's literal county field is used directly for
    DBA records, with 'MULTIPLE' always matching (it means the filing
    legitimately touches more than one county, which could include a
    wanted one).
"""
from __future__ import annotations

import json
import logging
from datetime import date

import db
import parser
import sunbiz
import zips

log = logging.getLogger("vx.leadsource.ingest")


def upsert_raw(raw_conn, source: str, records: list[dict], key_field: str) -> int:
    with raw_conn.transaction():
        cur = raw_conn.cursor()
        n = 0
        for rec in records:
            source_id = rec.get(key_field)
            if not source_id:
                continue
            cur.execute(
                """INSERT INTO leadsource_raw_records (source, source_id, raw, last_seen_at)
                   VALUES (%s, %s, %s, now())
                   ON CONFLICT (source, source_id) DO UPDATE SET raw = EXCLUDED.raw, last_seen_at = now()""",
                (source, source_id, json.dumps(rec)),
            )
            n += 1
    return n


def cor_matches(rec: dict, settings: dict, file_date_ref: date) -> bool:
    if rec.get("status") != "A":
        return False
    if rec.get("filing_type") not in settings["filing_types"]:
        return False
    fd = parser.parse_file_date(rec.get("file_date", ""))
    if fd is None or (file_date_ref - fd).days > settings["file_date_window_days"]:
        return False
    return zips.zip_matches_counties(rec.get("zip", ""), settings["counties"])


def fic_matches(rec: dict, settings: dict) -> bool:
    county = (rec.get("county") or "").upper()
    if county == "MULTIPLE":
        return True
    return county in {c.upper() for c in settings["counties"]}


def get_enabled_orgs(conn) -> list[dict]:
    with db.staff_tx(conn) as cur:
        cur.execute(
            """SELECT o.id, o.name,
                      COALESCE(s.counties, ARRAY['BROWARD','PALM BEACH']) AS counties,
                      COALESCE(s.filing_types, ARRAY['DOMP','FLAL','FORP','FORL']) AS filing_types,
                      COALESCE(s.file_date_window_days, 7) AS file_date_window_days,
                      COALESCE(s.include_dba, false) AS include_dba
                 FROM organizations o
            LEFT JOIN leadsource_settings s ON s.org_id = o.id
                WHERE o.modules->>'leadsource' = 'true' AND o.deleted_at IS NULL"""
        )
        return cur.fetchall()


def fan_out(conn, org_id: str, source: str, records: list[dict], key_field: str) -> int:
    inserted = 0
    with db.tenant_tx(conn, org_id) as cur:
        for rec in records:
            source_id = rec.get(key_field)
            if not source_id:
                continue
            cur.execute(
                """INSERT INTO leadsource_leads (org_id, source, source_id)
                   VALUES (%s, %s, %s) ON CONFLICT (org_id, source, source_id) DO NOTHING
                   RETURNING id""",
                (org_id, source, source_id),
            )
            if cur.fetchone():
                inserted += 1
    return inserted


def run_ingest(conn, raw_conn, target_date: date | None = None) -> dict:
    target_date = target_date or sunbiz.most_recent_workday(date.today())
    log.info("leadsource ingest start, target_date=%s", target_date)

    cor_bytes = sunbiz.download_daily_file(sunbiz.COR_DIR, "c", target_date)
    if cor_bytes is None:
        return {"status": "no_file", "target_date": str(target_date)}
    cor_records = parser.parse_cor_lines(cor_bytes)
    cor_upserted = upsert_raw(raw_conn, "fl_sunbiz_cor", cor_records, "corp_number")

    fic_records: list[dict] = []
    fic_upserted = 0
    fic_bytes = sunbiz.download_daily_file(sunbiz.FIC_DIR, "f", target_date)
    if fic_bytes is not None:
        fic_records = parser.parse_fic_lines(fic_bytes)
        fic_upserted = upsert_raw(raw_conn, "fl_sunbiz_fic", fic_records, "doc_number")

    per_org: dict[str, dict] = {}
    for org in get_enabled_orgs(conn):
        org_id, settings = str(org["id"]), org
        matched_cor = [r for r in cor_records if cor_matches(r, settings, target_date)]
        cor_inserted = fan_out(conn, org_id, "fl_sunbiz_cor", matched_cor, "corp_number")

        fic_inserted = 0
        matched_fic_count = 0
        if settings["include_dba"] and fic_records:
            matched_fic = [r for r in fic_records if fic_matches(r, settings)]
            matched_fic_count = len(matched_fic)
            fic_inserted = fan_out(conn, org_id, "fl_sunbiz_fic", matched_fic, "doc_number")

        per_org[org_id] = {
            "org_name": org["name"],
            "cor_matched": len(matched_cor), "cor_new_leads": cor_inserted,
            "fic_matched": matched_fic_count, "fic_new_leads": fic_inserted,
        }
        log.info("leadsource org=%s cor_new=%d fic_new=%d", org["name"], cor_inserted, fic_inserted)

    return {
        "status": "ok", "target_date": str(target_date),
        "cor_total": len(cor_records), "cor_upserted": cor_upserted,
        "fic_total": len(fic_records), "fic_upserted": fic_upserted,
        "orgs": per_org,
    }
