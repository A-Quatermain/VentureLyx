# Venturelyx :: ScaleSEO worker — deploy & operate

Ports the acxnet02 crawler into the multi-tenant platform. Work arrives from
`job_queue`; results land in the `seo_*` tables under tenant context; findings
emit into `signals` for the Command Center.

---

## 1. Files

```
workers/seo/
├── db.py             tenant context + job queue claiming
├── crawler.py        fetch/parse engine (no database access)
├── scoring.py        issue detection, health score, signal rows
├── worker.py         claim -> crawl -> persist loop
├── requirements.txt
└── Dockerfile
scripts/
├── seed_sites.py     sites.yaml -> orgs + seo_sites
└── crawl.py          queue a crawl, check status
infra/
└── docker-compose.workers.yml
```

WinSCP to `/opt/venturelyx`, preserving structure, then:

```bash
cd /opt/venturelyx
find workers scripts -type f \( -name '*.py' -o -name '*.txt' -o -name 'Dockerfile' \) -exec dos2unix -q {} \;
chmod +x scripts/*.py
```

## 2. Seed the sites

```bash
cd /opt/venturelyx
export DB_DSN="postgresql://venturelyx:$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)@127.0.0.1:5432/venturelyx"

sudo apt-get install -y python3-psycopg2 2>/dev/null || pip3 install --break-system-packages 'psycopg[binary]'

python3 scripts/seed_sites.py --dry-run    # inspect
python3 scripts/seed_sites.py              # commit
```

Creates six orgs and six `seo_sites` rows. `enabled` matches the acxnet02
config exactly: nppools, geodynparking and atleticosoflo on; geodyn.us,
testguard and campuspath off.

Seeding connects as the superuser deliberately — it creates orgs, which no
tenant context exists for yet. Every other operation uses `venturelyx_app`.

## 3. Build and start the worker

```bash
cd /opt/venturelyx
docker compose -f infra/docker-compose.data.yml -f infra/docker-compose.workers.yml \
               --env-file infra/.env up -d --build seo-worker
docker logs -f vx-seo-worker
```

Expect `worker seo-worker-1 ready, kinds=['seo.crawl']`.

## 4. First crawl

```bash
python3 scripts/crawl.py --site nppools
docker logs -f vx-seo-worker
```

Then:

```bash
python3 scripts/crawl.py --status
```

## 5. Confirm what landed

```bash
docker exec -e PGPASSWORD="$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)" \
  vx-postgres psql -U venturelyx -d venturelyx -c "
SELECT s.key, sc.health, sc.technical, sc.content, sc.performance,
       sc.pages, sc.broken_links, sc.critical_issues, sc.high_issues
  FROM seo_scores sc JOIN seo_sites s ON s.id = sc.site_id
 ORDER BY sc.computed_at DESC LIMIT 5;"

docker exec -e PGPASSWORD="..." vx-postgres psql -U venturelyx -d venturelyx -c "
SELECT severity, code, count(*), min(url) AS example
  FROM seo_issues GROUP BY severity, code ORDER BY severity, count(*) DESC;"

-- the intelligence layer, which is the point
docker exec -e PGPASSWORD="..." vx-postgres psql -U venturelyx -d venturelyx -c "
SELECT severity, summary, detail->>'count' AS pages, detail->>'auto_fixable' AS fixable
  FROM signals WHERE module='scaleseo' AND resolved_at IS NULL
 ORDER BY severity;"
```

## 6. Schedule

```bash
(sudo crontab -l 2>/dev/null; echo "0 4 * * * cd /opt/venturelyx && DB_DSN=\"postgresql://venturelyx:\$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)@127.0.0.1:5432/venturelyx\" /usr/bin/python3 scripts/crawl.py --all-due >> /var/log/vx-crawl.log 2>&1") | sudo crontab -
```

---

## Design notes

**Tenant context is the whole safety model.** Claiming runs in staff mode
because the queue spans tenants. Everything after the claim runs with
`app.current_org` set and staff mode off — so a bug in crawl code cannot write
into another tenant. Verified by `db/test/isolation_test.sql`.

**A crawl is one transaction.** Pages, links, issues, signals and the score all
commit together. A partial crawl would make the health trend lie, and the trend
is what clients are shown.

**Signals are grouped by issue code, not URL.** Twenty pages missing meta
descriptions is one thing to do, not twenty items in the owner's list. Signals
whose code disappears from the next crawl are auto-resolved, so a fixed problem
leaves the list without anyone clicking anything.

**Retries back off exponentially** (3^attempts minutes) and exhausted jobs go
`dead`, not `failed`, so a genuinely stuck site is visible rather than retrying
forever. A worker that dies mid-crawl stops heartbeating and its job is reaped
back to `queued` after 30 minutes.

**The crawler never runs as root** — it parses hostile HTML from the open
internet. Container user is uid 10001.

## Known limits

- **`render: true` is not yet implemented.** GeoDyn and Atlético are React sites
  and will crawl as near-empty shells until Playwright is added. Their seeded
  config is correct; the capability is not there yet. nppools is static and
  crawls fully today.
- Non-crawled link targets are HEAD-checked to a cap of 400 per crawl.
- Rank tracking tables exist but nothing populates them yet — that needs a SERP
  data source, which is a cost decision, not a code one.
- `seo_gsc_daily` / `seo_ga4_daily` await Google OAuth in the credential vault.

## Parallel running

Leave the acxnet02 stack running. Crawl nppools.com on both and compare page
counts and issue lists. Divergence is a bug in the port, and having a reference
implementation to diff against is worth more than the RAM it costs.
