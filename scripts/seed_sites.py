#!/usr/bin/env python3
"""
Venturelyx :: seed orgs + seo_sites from the acxnet02 sites.yaml.

    python3 scripts/seed_sites.py --dry-run
    python3 scripts/seed_sites.py

Idempotent: re-running updates existing rows rather than duplicating them.
Each site becomes its own org, because in production these are separate
businesses even though today they are all yours.
"""
from __future__ import annotations

import argparse
import os
import sys

import psycopg
from psycopg.rows import dict_row

# Ported from ~/seo-platform/sites.yaml on acxnet02.
# 'enabled' preserved exactly as configured there.
SITES = [
    dict(slug="nppools", org="N&P Pools", vertical="pool_service",
         key="nppools", name="N&P Pools", url="https://nppools.com",
         enabled=True, render=False, max_pages=200,
         notes="Static marketing site. Primary ScaleSEO reference account."),

    dict(slug="geodyn", org="GeoDyn Parking", vertical="parking_technology",
         key="geodynparking", name="GeoDyn Parking", url="https://geodynparking.com",
         enabled=True, render=True, max_pages=500,
         notes="React marketing site; app.* is behind auth and not crawled."),

    dict(slug="atletico", org="Atletico South Florida FC", vertical="sports_club",
         key="atleticosoflo", name="Atletico South Florida FC",
         url="https://atleticosoflo.com",
         enabled=True, render=True, max_pages=500,
         notes="Vite+React, driven by site-content.json."),

    dict(slug="geodyn-us", org="GeoDyn Parking", vertical="parking_technology",
         key="geodyn-us", name="GeoDyn (admin portal)", url="https://geodyn.us",
         enabled=False, render=True, max_pages=500,
         notes="ADMIN PORTAL - not a marketing site. Do not crawl."),

    dict(slug="testguard", org="TestGuard", vertical="edtech",
         key="testguard", name="TestGuard", url="https://testguard.org",
         enabled=False, render=False, max_pages=500,
         notes="Disabled pending launch."),

    dict(slug="campuspath", org="CampusPath", vertical="edtech",
         key="campuspath", name="CampusPath", url="https://campuspath.com",
         enabled=False, render=False, max_pages=500,
         notes="Disabled pending marketing site."),
]

EXCLUDES = ["/admin", "/login", "/dashboard", "/portal"]
UA = "VenturelyxBot/1.0 (+https://venturelyx.com/bot)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dsn = os.environ.get("DB_DSN")
    if not dsn:
        print("FATAL: DB_DSN not set.", file=sys.stderr)
        print("  export DB_DSN=\"postgresql://venturelyx:$(grep ^POSTGRES_PASSWORD "
              "/opt/venturelyx/infra/.env | cut -d= -f2)@127.0.0.1:5432/venturelyx\"",
              file=sys.stderr)
        return 1

    conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=False)
    created_orgs = created_sites = updated_sites = 0

    with conn.transaction():
        cur = conn.cursor()
        # Seeding runs as superuser/owner, so RLS is bypassed by design here.
        for s in SITES:
            cur.execute("SELECT id, name FROM organizations WHERE slug = %s", (s["slug"],))
            org = cur.fetchone()
            if not org:
                cur.execute(
                    """INSERT INTO organizations (slug, name, vertical, website_url,
                                                  status, timezone, modules)
                       VALUES (%s,%s,%s,%s,'active','America/New_York',
                               '{"scaleseo": true, "operate": false}'::jsonb)
                       RETURNING id, name""",
                    (s["slug"], s["org"], s["vertical"], s["url"]),
                )
                org = cur.fetchone()
                created_orgs += 1
                print(f"  + org   {s['org']}")
            org_id = org["id"]

            cur.execute(
                "SELECT id FROM seo_sites WHERE org_id = %s AND key = %s",
                (org_id, s["key"]),
            )
            existing = cur.fetchone()

            if existing:
                cur.execute(
                    """UPDATE seo_sites
                          SET name=%s, url=%s, enabled=%s, render=%s, max_pages=%s,
                              notes=%s, user_agent=%s, exclude_paths=%s
                        WHERE id=%s""",
                    (s["name"], s["url"], s["enabled"], s["render"], s["max_pages"],
                     s["notes"], UA, EXCLUDES, existing["id"]),
                )
                updated_sites += 1
                print(f"  ~ site  {s['key']:16s} enabled={s['enabled']}")
            else:
                cur.execute(
                    """INSERT INTO seo_sites
                       (org_id, key, name, url, enabled, render, max_pages, notes,
                        user_agent, exclude_paths, is_primary, crawl_schedule,
                        next_crawl_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true,'weekly',
                               CASE WHEN %s THEN now() ELSE NULL END)""",
                    (org_id, s["key"], s["name"], s["url"], s["enabled"], s["render"],
                     s["max_pages"], s["notes"], UA, EXCLUDES, s["enabled"]),
                )
                created_sites += 1
                print(f"  + site  {s['key']:16s} enabled={s['enabled']}")

        if args.dry_run:
            print("\nDRY RUN — rolling back")
            raise psycopg.Rollback

    print(f"\norgs created: {created_orgs}   sites created: {created_sites}   updated: {updated_sites}")

    with conn.cursor() as cur:
        cur.execute(
            """SELECT o.name AS org, s.key, s.url, s.enabled, s.render, s.max_pages
                 FROM seo_sites s JOIN organizations o ON o.id = s.org_id
             ORDER BY s.enabled DESC, o.name"""
        )
        print("\ncurrent seo_sites:")
        for r in cur.fetchall():
            flag = "on " if r["enabled"] else "off"
            print(f"  [{flag}] {r['key']:16s} {r['url']:38s} render={r['render']} max={r['max_pages']}")

    conn.commit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
