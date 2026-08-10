# Venturelyx :: Block 1 deployment — data tier

Target: **acxnet07 / 192.168.1.158**. Brings up Postgres 17, Redis, MinIO and
applies the schema. No application services yet.

---

## 1. Transfer

WinSCP the `venturelyx/` folder to `/opt/venturelyx` on acxnet07, preserving
this structure:

```
/opt/venturelyx/
├── docs/ARCHITECTURE.md
├── infra/
│   ├── docker-compose.data.yml
│   └── .env.example
├── db/
│   ├── migrations/001_platform_core.sql
│   ├── migrations/002_business_graph.sql
│   └── test/isolation_test.sql
└── scripts/
    ├── deploy.sh
    ├── migrate.sh
    └── backup-postgres.sh
```

Then:

```bash
cd /opt/venturelyx
chmod +x scripts/*.sh
```

## 2. Secrets

```bash
cp infra/.env.example infra/.env
chmod 600 infra/.env

# generate six values, one per placeholder
for i in 1 2 3 4 5 6; do openssl rand -hex 32; done

nano infra/.env
```

Paste one generated value into each `GENERATE_ME`. `deploy.sh` refuses to run
while any placeholder remains, and checks that `VAULT_KEY` is exactly 64 hex
characters.

> **POSTGRES_PASSWORD is permanent.** Postgres bakes it into the data directory
> during `initdb`. Changing it in `.env` later does not change the database and
> the stack will fail to connect. Same rule as CampusPath.
>
> **VAULT_KEY is not recoverable.** It decrypts every stored OAuth token in
> `integrations`. Back it up somewhere other than this server.

## 3. Deploy

```bash
cd /opt/venturelyx
./scripts/deploy.sh
```

Expect three containers healthy: `vx-postgres`, `vx-redis`, `vx-minio`.

## 4. Migrate and verify

```bash
./scripts/migrate.sh
./scripts/migrate.sh --verify
```

`--verify` must print **two empty result sets** (no unprotected tables, no
overlapping policies) and `30 tables, 30 policies`. Anything else means stop.

## 5. Prove isolation on the real box

The migrations were verified against PostgreSQL 16 in a scratch environment.
Confirm the same holds on your Postgres 17 instance:

```bash
docker exec -i -e PGPASSWORD="$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)" \
  vx-postgres psql -U venturelyx -d venturelyx -f - < db/test/isolation_test.sql
```

Tests 1–7 must behave as annotated in the file — notably T3, where a missing org
context returns **zero rows rather than all rows**.

## 6. Backups

```bash
./scripts/backup-postgres.sh          # verify it works before trusting cron
sudo crontab -e
```

```
15 3 * * * /opt/venturelyx/scripts/backup-postgres.sh >> /var/log/vx-backup.log 2>&1
```

The script rejects any dump that `pg_restore --list` cannot read, so a silently
corrupt backup does not accumulate.

## 7. MinIO buckets

Console at `http://192.168.1.158:9001`, credentials from `.env`. Create:

| Bucket | Contents | Access |
|---|---|---|
| `vx-reports` | Generated PDFs, scan reports | private |
| `vx-artifacts` | Crawl screenshots, raw HTML | private |
| `vx-uploads` | Client documents, signatures | private |
| `vx-public` | Logos, public assets | read-only public |

---

## Notes

**Port exposure.** Postgres and the MinIO S3 API bind to `127.0.0.1` only. The
MinIO console binds to the LAN IP for setup convenience — close it once
credentials are stored elsewhere. `ufw` already denies inbound except SSH from
`192.168.1.0/24`.

**Sizing.** Postgres is tuned for the current 7 GB. After the Hyper-V resize to
16 GB, edit `docker-compose.data.yml`: `shared_buffers=4GB`,
`effective_cache_size=10GB`, `maintenance_work_mem=1GB`, `mem_limit: 6g`, then
`./scripts/deploy.sh` to recreate. Data survives — it lives in the named volume.

**ICU collation** is set at init deliberately. glibc collation changes across OS
upgrades silently corrupt text indexes; ICU is versioned and stable.

**`oom_score_adj: -500`** protects Postgres from the OOM killer per-container,
which is why `vm.overcommit_memory` stays at `0` globally where Chromium and V8
need it.
