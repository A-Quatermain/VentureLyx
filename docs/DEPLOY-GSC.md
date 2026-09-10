# Venturelyx :: Google Search Console — deploy & operate

OAuth connect lives in the API (`api/src/routes/integrations.ts`); the daily
pull reuses the exact `job_queue` pattern `seo.crawl` already uses, dispatched
from the same `seo-worker` container (`workers/seo/gsc.py`).

---

## 1. Google Cloud setup

1. In an existing (or new) Google Cloud project, enable the **Search Console
   API**.
2. Create an **OAuth 2.0 Client ID** (Web application) under APIs & Services →
   Credentials.
3. Authorized redirect URI — must match exactly:
   ```
   https://api.venturelyx.com/v1/integrations/gsc/oauth/callback
   ```
4. Copy the client ID and secret into `infra/.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
5. Rebuild/restart the `api` and `seo-worker` containers so both pick up the
   new env vars (the worker needs them too — it refreshes the access token
   itself rather than going through the API on every sync).
   ```bash
   docker compose -f infra/docker-compose.data.yml -f infra/docker-compose.workers.yml \
                  -f infra/docker-compose.app.yml --env-file infra/.env up -d --build api seo-worker
   ```

## 2. Connect a property

In Settings, an org **admin** clicks "Connect Google Search Console" — this
navigates (not fetches) to `GET /v1/integrations/gsc/oauth/start`, which
redirects into Google's consent screen, then back to
`/v1/integrations/gsc/oauth/callback`.

The callback fetches the Google account's verified Search Console properties
and picks the one matching the org's primary `seo_sites` URL. If the account
has exactly one property, it's used regardless of URL. If there are several
and none match, the first one the account owns is used — there's no property
picker yet, so a wrong pick here means reconnecting after removing app access
in the Google Account's [connected apps](https://myaccount.google.com/permissions)
page and connecting again.

An immediate `seo.gsc_sync` job is queued on connect so the first data shows
up within a poll interval, not a full day later.

## 3. Schedule the daily pull

GSC's Search Analytics data lags 2-3 days and can still be revised for a few
more, so `workers/seo/gsc.py` always re-pulls a rolling 5-day window and
upserts — running it more than once a day buys nothing.

```bash
(sudo crontab -l 2>/dev/null; echo "0 5 * * * cd /opt/venturelyx && DB_DSN=\"postgresql://venturelyx:\$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)@127.0.0.1:5432/venturelyx\" /usr/bin/python3 scripts/gsc_sync.py --all-due >> /var/log/vx-gsc-sync.log 2>&1") | sudo crontab -
```

Check what's connected and when it last synced:

```bash
python3 scripts/gsc_sync.py --status
```

## 4. Confirm what landed

```bash
docker exec -e PGPASSWORD="$(grep ^POSTGRES_PASSWORD infra/.env | cut -d= -f2)" \
  vx-postgres psql -U venturelyx -d venturelyx -c "
SELECT o.name, count(*) AS rows, min(g.date), max(g.date)
  FROM seo_gsc_daily g JOIN organizations o ON o.id = g.org_id
 GROUP BY o.name;"
```

The Keywords tab (`GET /v1/seo/gsc-queries/:siteId`) reads straight from
`seo_gsc_daily` aggregated over the trailing 28 days. An org with no
`integrations` row in `connected` status gets `{ connected: false }` and the
frontend shows a connect prompt — never fabricated rows.

---

## Design notes

**The refresh token is encrypted at rest** — `integrations.credential_enc` /
`credential_iv` / `credential_tag`, AES-256-GCM under `VAULT_KEY`. The API
encrypts it once at OAuth-callback time; the worker decrypts it every sync
(`workers/seo/vault.py`, a Python port of `api/src/lib/auth.ts`'s
encrypt/decryptSecret — same key, same wire format).

**A rejected refresh token flips the integration to `status = 'error'`**
rather than retrying forever — Google returns 400/401 when a grant has been
revoked, and no amount of retrying fixes that. Transient failures (rate
limits, a bad response from the Search Analytics endpoint) leave `status`
alone so the next day's run just tries again.

**No property picker, no geocoding, no invented data anywhere in this
feature.** Where an ambiguous or missing input would otherwise require
guessing (which GSC property, which nearby cities for a radius-based service
area), the code either makes the single best real inference and says so in
this doc, or — per the Keywords/Competitors tabs — shows nothing rather than
a plausible-looking number nobody generated.
