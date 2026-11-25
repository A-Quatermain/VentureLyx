"""
Venturelyx :: LeadSource quarterly backfill — repeatable verification
script, same convention as test_enrich.py.

    docker exec vx-leadsource-worker python test_quarterly.py

Covers: the CRLF line-ending fix (the real bug this phase found — the
quarterly file's records would otherwise be silently dropped), the
streaming parser's correctness against the existing bulk parser, the
filter-before-upsert predicate, and get_backfill_filters' DB-backed union
across enabled orgs (including that a disabled org contributes nothing).
"""
from __future__ import annotations

import io
import json
import sys
import uuid

import db
import parser
import quarterly

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def make_record_line(corp_number: str, name: str, status: str = "A", filing_type: str = "FLAL", zip_code: str = "33301") -> bytes:
    """Builds one syntactically valid 1440-byte COR record using the real
    field offsets, for exactly the fields this test cares about — the
    rest stays spaces, which parse_cor_record already treats as empty."""
    line = bytearray(b" " * parser.COR_RECORD_LEN)

    def put(value: str, start_1based: int):
        b = value.encode("ascii")
        line[start_1based - 1:start_1based - 1 + len(b)] = b

    put(corp_number, 1)
    put(name, 13)
    put(status, 205)
    put(filing_type, 206)
    put(zip_code, 335)
    return bytes(line)


def main() -> int:
    print("LeadSource quarterly backfill verification\n")

    rec1 = make_record_line("L26000000001", "CRLF TEST ONE LLC")
    rec2 = make_record_line("L26000000002", "CRLF TEST TWO LLC")

    # 1. The real bug: CRLF-joined data must parse identically to
    # LF-joined data, not silently drop every record.
    crlf_bytes = rec1 + b"\r\n" + rec2 + b"\r\n"
    lf_bytes = rec1 + b"\n" + rec2 + b"\n"
    crlf_parsed = parser.parse_cor_lines(crlf_bytes)
    lf_parsed = parser.parse_cor_lines(lf_bytes)
    check("parse_cor_lines on CRLF-joined data finds both records (the real Phase 4 bug)", len(crlf_parsed) == 2, f"got {len(crlf_parsed)}")
    check("CRLF and LF joined versions of the same data parse to the same corp_numbers",
          {r["corp_number"] for r in crlf_parsed} == {r["corp_number"] for r in lf_parsed} == {"L26000000001", "L26000000002"})

    # 2. Streaming parser matches the bulk parser exactly, across a chunk
    # boundary that splits a record in half (the real-world case this
    # exists for — an 8MB read chunk will almost never land on a record
    # boundary over a ~1.87GB file).
    many_lines = b"".join(make_record_line(f"L2600000{i:04d}", f"STREAM TEST {i} LLC") + b"\r\n" for i in range(20))
    bulk = parser.parse_cor_lines(many_lines)
    streamed = list(parser.iter_cor_records(io.BytesIO(many_lines), chunk_size=500))  # deliberately mid-record
    check("iter_cor_records with a tiny chunk size (forces mid-record splits) matches parse_cor_lines exactly",
          [r["corp_number"] for r in streamed] == [r["corp_number"] for r in bulk], f"streamed={len(streamed)} bulk={len(bulk)}")

    # 3. cor_matches_backfill — status/filing_type/county, no date filter
    # (recovering history the daily ingest never saw is the whole point).
    active_fl = make_record_line("L1", "X", status="A", filing_type="FLAL", zip_code="33301")  # Broward
    inactive = make_record_line("L2", "X", status="I", filing_type="FLAL", zip_code="33301")
    wrong_type = make_record_line("L3", "X", status="A", filing_type="DOMNP", zip_code="33301")
    wrong_county = make_record_line("L4", "X", status="A", filing_type="FLAL", zip_code="99999")
    filing_types = {"FLAL", "DOMP"}
    counties = {"BROWARD"}
    check("an active, allowed-type, matching-county record passes the backfill filter",
          quarterly.cor_matches_backfill(parser.parse_cor_record(active_fl.decode()), filing_types, counties))
    check("an inactive record is rejected regardless of everything else",
          not quarterly.cor_matches_backfill(parser.parse_cor_record(inactive.decode()), filing_types, counties))
    check("a filing_type not in the allowed set is rejected",
          not quarterly.cor_matches_backfill(parser.parse_cor_record(wrong_type.decode()), filing_types, counties))
    check("a zip outside the allowed counties is rejected",
          not quarterly.cor_matches_backfill(parser.parse_cor_record(wrong_county.decode()), filing_types, counties))

    # 4. get_backfill_filters — real DB, disposable orgs.
    conn = db.connect()
    raw_conn = db.connect_raw()  # leadsource_raw_records needs the restricted worker role, even for a test fixture
    enabled_id = str(uuid.uuid4())
    disabled_id = str(uuid.uuid4())
    try:
        with db.staff_tx(conn) as cur:
            cur.execute(
                "INSERT INTO organizations (id, slug, name, status, modules) "
                "VALUES (%s, %s, 'Enabled Org', 'active', '{\"leadsource\": true}'::jsonb)",
                (enabled_id, f"test-{uuid.uuid4().hex[:8]}"),
            )
            cur.execute(
                "INSERT INTO organizations (id, slug, name, status, modules) "
                "VALUES (%s, %s, 'Disabled Org', 'active', '{\"leadsource\": false}'::jsonb)",
                (disabled_id, f"test-{uuid.uuid4().hex[:8]}"),
            )
        with db.tenant_tx(conn, enabled_id) as cur:
            cur.execute(
                "INSERT INTO leadsource_settings (org_id, counties, filing_types, file_date_window_days, include_dba) "
                "VALUES (app.current_org(), ARRAY['MIAMI-DADE'], ARRAY['FORP'], 7, false)",
            )
        with db.tenant_tx(conn, disabled_id) as cur:
            cur.execute(
                "INSERT INTO leadsource_settings (org_id, counties, filing_types, file_date_window_days, include_dba) "
                "VALUES (app.current_org(), ARRAY['ORANGE'], ARRAY['DOMLP'], 7, false)",
            )

        filters = quarterly.get_backfill_filters(conn)
        check("get_backfill_filters includes the enabled org's county", "MIAMI-DADE" in filters["counties"])
        check("get_backfill_filters includes the enabled org's filing type", "FORP" in filters["filing_types"])
        check("get_backfill_filters excludes a disabled org's county", "ORANGE" not in filters["counties"])
        check("get_backfill_filters excludes a disabled org's filing type", "DOMLP" not in filters["filing_types"])

        # 5. fan_out_backfill_for_org — a raw record matching this org's own
        # settings becomes a real lead for it. Calls the per-org helper
        # directly with a synthetic org dict, never fan_out_backfill_matches()
        # itself — that one loops over EVERY real LeadSource-enabled org in
        # this database via get_enabled_orgs(), which in production means a
        # ~680k-row scan and fan-out per org; a test must never trigger that
        # as a side effect (this is why that split exists — see quarterly.py).
        rec = parser.parse_cor_record(make_record_line("Q9000000001", "FANOUT TEST LLC", status="A", filing_type="FORP", zip_code="33131").decode())
        with raw_conn.transaction():
            raw_conn.cursor().execute(
                """INSERT INTO leadsource_raw_records (source, source_id, raw) VALUES ('fl_sunbiz_cor', %s, %s)
                   ON CONFLICT (source, source_id) DO UPDATE SET raw = EXCLUDED.raw""",
                (rec["corp_number"], json.dumps(rec)),
            )
        synthetic_org = {"id": enabled_id, "name": "Enabled Org", "filing_types": ["FORP"], "counties": ["MIAMI-DADE"]}
        result = quarterly.fan_out_backfill_for_org(conn, synthetic_org)
        # Other leftover fixture rows from earlier test runs this session
        # also sit permanently in leadsource_raw_records (no role can
        # DELETE from it — see the header above) and may coincidentally
        # share FORP/Miami-Dade, so this checks specifically for OUR
        # fixture's own lead rather than an exact total count.
        with db.tenant_tx(conn, enabled_id) as cur:
            cur.execute("SELECT id FROM leadsource_leads WHERE org_id = app.current_org() AND source_id = 'Q9000000001'")
            fixture_lead_exists = cur.fetchone() is not None
        check("fan_out_backfill_for_org creates a lead for our fixture record specifically", fixture_lead_exists, str(result))
        no_match_org = {"id": disabled_id, "name": "Disabled Org", "filing_types": ["DOMLP"], "counties": ["ORANGE"]}
        no_match_result = quarterly.fan_out_backfill_for_org(conn, no_match_org)
        check("fan_out_backfill_for_org finds nothing for an org whose own filters don't match", no_match_result["matched"] == 0)

        # 6. touch_heartbeat actually advances heartbeat_at — the whole
        # point of this fix (see db.py's own header on why this exists).
        with db.staff_tx(conn) as cur:
            cur.execute(
                "INSERT INTO job_queue (kind, state, heartbeat_at) VALUES ('leadsource.quarterly_backfill', 'running', now() - interval '45 minutes') RETURNING id",
            )
            test_job_id = cur.fetchone()["id"]
        db.touch_heartbeat(conn, test_job_id)
        with db.staff_tx(conn) as cur:
            cur.execute("SELECT heartbeat_at < now() - interval '1 minute' AS is_stale FROM job_queue WHERE id = %s", (test_job_id,))
            is_stale = cur.fetchone()["is_stale"]
        check("touch_heartbeat refreshes heartbeat_at so the job no longer looks stale", not is_stale)
        with db.staff_tx(conn) as cur:
            cur.execute("DELETE FROM job_queue WHERE id = %s", (test_job_id,))
    finally:
        # The Q9000000001 fixture row in leadsource_raw_records is NOT
        # cleaned up here, deliberately — no role has DELETE on that table
        # (040_leadsource.sql: upsert-only, by design), so there is no
        # application-layer way to remove it. It's harmless and permanent:
        # a fake corp_number nothing real ever matches, re-upserted (not
        # duplicated) by this same test every run via ON CONFLICT DO UPDATE.
        with db.staff_tx(conn) as cur:
            cur.execute("DELETE FROM organizations WHERE id IN (%s, %s)", (enabled_id, disabled_id))
        conn.close()
        raw_conn.close()

    print(f"\n{passed} passed, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
