"""
Venturelyx :: coverage-gap detection.

Runs inside the same tenant transaction as a crawl's persist() — the whole
point is comparing the service x location matrix (market_targets, itself
catalog_items x locations — see api/src/lib/marketTargets.ts) against pages
this crawl actually found. "Covered" is never estimated or fetched from an
external source: a market_target counts as covered only when some page from
THIS crawl has a URL or title containing both the service name and the
location name — the same literal signal a person scanning the sitemap by eye
would use.

Emits signal rows in the exact shape scoring.signal_rows() already produces,
so persist() writes both kinds through the one INSERT ... ON CONFLICT block —
same dedupe-by-key, same "a fixed problem resolves itself" behavior, just
keyed by market_target instead of issue code.
"""
from __future__ import annotations

import re
from collections import Counter

from crawler import PageResult

# Individual, actionable signals — but Next Best Action is a shared queue
# across the whole business, not a dumping ground for every gap a growing
# catalog x service-area matrix can produce. Capped to the ones ranked
# highest (see sync()); the rest are still visible in ScaleSEO's Coverage tab.
MAX_GAP_SIGNALS = 15


def _normalize(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _match(pages: list[PageResult], service_name: str, location_name: str) -> str | None:
    needle_service = _normalize(service_name)
    needle_location = _normalize(location_name)
    if not needle_service or not needle_location:
        return None
    for p in pages:
        haystack = _normalize(p.url) + " " + _normalize(p.title)
        if needle_service in haystack and needle_location in haystack:
            return p.url
    return None


def sync(cur, pages: list[PageResult]) -> list[dict]:
    """Recompute market_targets.status/target_url from this crawl's pages,
    resolve signals for gaps that closed, and return signal rows for the
    highest-ranked gaps still open. Caller (worker.py's persist()) is already
    inside db.tenant_tx — this does no transaction management of its own."""
    live_pages = [p for p in pages if p.status_code == 200]

    cur.execute(
        """SELECT mt.id, mt.status, ci.id AS catalog_item_id, ci.name AS service_name,
                  l.id AS location_id, l.name AS location_name
             FROM market_targets mt
             JOIN catalog_items ci ON ci.id = mt.catalog_item_id
             JOIN locations l ON l.id = mt.location_id
            WHERE mt.is_served AND ci.is_active AND ci.kind = 'service' AND l.is_active"""
    )
    targets = cur.fetchall()

    matched_url: dict[str, str | None] = {
        t["id"]: _match(live_pages, t["service_name"], t["location_name"]) for t in targets
    }
    gap_count_by_location: Counter = Counter(
        t["location_id"] for t in targets if not matched_url[t["id"]]
    )

    gaps: list[dict] = []
    for t in targets:
        url = matched_url[t["id"]]
        if url:
            if t["status"] in ("identified", "published"):
                cur.execute(
                    "UPDATE market_targets SET status = 'published', target_url = %s WHERE id = %s",
                    (url, t["id"]),
                )
        else:
            if t["status"] == "published":
                cur.execute(
                    "UPDATE market_targets SET status = 'identified', target_url = NULL WHERE id = %s",
                    (t["id"],),
                )
            gaps.append({**t, "uncovered_in_location": gap_count_by_location[t["location_id"]]})

    # A gap signal resolves the moment its target is covered or stops being
    # served — regardless of whether it's still one of the top N below, so a
    # signal never lingers just because a bigger gap elsewhere outranked it.
    cur.execute(
        """UPDATE signals s SET resolved_at = now()
             FROM market_targets mt
            WHERE s.module = 'scaleseo' AND s.signal_type = 'seo.coverage_gap'
              AND s.resolved_at IS NULL AND s.entity_id = mt.id
              AND (mt.status = 'published' OR NOT mt.is_served)"""
    )
    cur.execute(
        """UPDATE signals s SET resolved_at = now()
            WHERE s.module = 'scaleseo' AND s.signal_type = 'seo.coverage_gap'
              AND s.resolved_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM market_targets mt WHERE mt.id = s.entity_id)"""
    )

    # Ranked by how many other services are missing in the same area — a
    # location missing several services is the more urgent pattern to act on.
    gaps.sort(key=lambda g: g["uncovered_in_location"], reverse=True)

    rows = []
    for g in gaps[:MAX_GAP_SIGNALS]:
        n = g["uncovered_in_location"]
        rows.append({
            "module": "scaleseo",
            "signal_type": "seo.coverage_gap",
            "severity": 2 if n >= 3 else 3,
            "entity_type": "market_targets",
            "entity_id": g["id"],
            "summary": (
                f"You offer {g['service_name']} and serve {g['location_name']}, "
                "but have no page targeting it."
            ),
            "detail": {
                # str() the uuid.UUID values psycopg hands back — json.dumps
                # (persist()'s INSERT) can't serialize them as-is.
                "catalog_item_id": str(g["catalog_item_id"]),
                "location_id": str(g["location_id"]),
                "service_name": g["service_name"],
                "location_name": g["location_name"],
                "uncovered_in_location": n,
            },
            "dedupe_key": f"scaleseo:coverage_gap:{g['id']}",
        })
    return rows
