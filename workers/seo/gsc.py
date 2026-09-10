"""
Venturelyx :: Google Search Console sync.

    claim (staff mode)  ->  refresh token -> pull search analytics  ->  persist (tenant mode)

Same shape as crawler.py/worker.py's crawl path, and the same tenant-context
discipline from db.py: claiming is cross-tenant, everything that touches
`seo_gsc_daily` or `integrations` runs inside db.tenant_tx(conn, org_id).

GSC's Search Analytics API lags 2-3 days before data is final, and rows for
already-reported days can still be revised for a few more — so every run
re-pulls a rolling 5-day window ending 2 days back and upserts, rather than
pulling only "yesterday."
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta
from urllib.parse import quote

import httpx

import db
import vault

log = logging.getLogger("vx.gsc")

TOKEN_URL = "https://oauth2.googleapis.com/token"
SITES_URL = "https://www.googleapis.com/webmasters/v3/sites"
LAG_DAYS = 2
WINDOW_DAYS = 5


def load_integration(conn, org_id: str) -> dict | None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """SELECT id, external_id, credential_enc, credential_iv, credential_tag, status
                 FROM integrations
                WHERE org_id = %s AND provider = 'google_search_console'""",
            (org_id,),
        )
        return cur.fetchone()


def load_primary_site(conn, org_id: str) -> dict | None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            "SELECT id, url FROM seo_sites WHERE org_id = %s AND is_primary LIMIT 1",
            (org_id,),
        )
        return cur.fetchone()


def refresh_access_token(refresh_token: str) -> str:
    resp = httpx.post(
        TOKEN_URL,
        data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_search_analytics(access_token: str, property_url: str, start: str, end: str) -> list[dict]:
    rows: list[dict] = []
    start_row = 0
    row_limit = 25000
    url = f"{SITES_URL}/{quote(property_url, safe='')}/searchAnalytics/query"
    while True:
        resp = httpx.post(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "startDate": start,
                "endDate": end,
                "dimensions": ["query", "page", "date"],
                "rowLimit": row_limit,
                "startRow": start_row,
            },
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json().get("rows", [])
        rows.extend(batch)
        if len(batch) < row_limit:
            break
        start_row += row_limit
    return rows


def persist(conn, org_id: str, site_id: str, integration_id: str, rows: list[dict]) -> int:
    with db.tenant_tx(conn, org_id) as cur:
        row_tuples = []
        for r in rows:
            keys = r.get("keys") or []
            if len(keys) != 3:
                continue
            query, page, checked_date = keys
            row_tuples.append((
                org_id, site_id, checked_date, query[:500], page[:2000],
                r.get("clicks", 0), r.get("impressions", 0), r.get("ctr"), r.get("position"),
            ))
        if row_tuples:
            cur.executemany(
                """INSERT INTO seo_gsc_daily (org_id, site_id, date, query, page, clicks, impressions, ctr, position)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (site_id, date, query, page) DO UPDATE
                     SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
                         ctr = EXCLUDED.ctr, position = EXCLUDED.position""",
                row_tuples,
            )
        cur.execute(
            "UPDATE integrations SET last_sync_at = now(), last_error = NULL WHERE id = %s",
            (integration_id,),
        )
    return len(row_tuples)


def mark_error(conn, org_id: str, integration_id: str, message: str, *, disconnect: bool = False) -> None:
    with db.tenant_tx(conn, org_id) as cur:
        if disconnect:
            cur.execute(
                "UPDATE integrations SET status = 'error', last_error = %s WHERE id = %s",
                (message[:2000], integration_id),
            )
        else:
            cur.execute(
                "UPDATE integrations SET last_error = %s WHERE id = %s",
                (message[:2000], integration_id),
            )


def run(conn, job: dict) -> None:
    org_id = str(job["org_id"])

    integration = load_integration(conn, org_id)
    if not integration or integration["status"] != "connected":
        log.info("gsc sync skipped org=%s: not connected", org_id)
        return

    site = load_primary_site(conn, org_id)
    if not site:
        log.warning("gsc sync skipped org=%s: no primary seo_sites row", org_id)
        return

    refresh_token = vault.decrypt_secret(
        bytes(integration["credential_enc"]), bytes(integration["credential_iv"]), bytes(integration["credential_tag"]),
    )

    try:
        access_token = refresh_access_token(refresh_token)
    except httpx.HTTPStatusError as e:
        # A rejected refresh token means the grant was revoked (or the
        # client secret rotated) — no amount of retrying fixes that; the
        # owner has to reconnect. Anything else transient stays 'connected'
        # so tomorrow's run just tries again.
        disconnect = e.response.status_code in (400, 401)
        mark_error(conn, org_id, integration["id"],
                   f"Could not refresh the Google token ({e.response.status_code}).", disconnect=disconnect)
        raise

    end = date.today() - timedelta(days=LAG_DAYS)
    start = end - timedelta(days=WINDOW_DAYS - 1)

    try:
        rows = fetch_search_analytics(access_token, integration["external_id"], start.isoformat(), end.isoformat())
    except httpx.HTTPStatusError as e:
        mark_error(conn, org_id, integration["id"], f"Search Analytics query failed ({e.response.status_code}).")
        raise

    n = persist(conn, org_id, site["id"], integration["id"], rows)
    log.info("gsc sync done org=%s property=%s rows=%d window=%s..%s",
              org_id, integration["external_id"], n, start, end)
