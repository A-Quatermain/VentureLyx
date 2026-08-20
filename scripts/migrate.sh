#!/usr/bin/env bash
# =============================================================================
# Venturelyx :: migration runner
#
#   ./scripts/migrate.sh            apply all pending migrations
#   ./scripts/migrate.sh --status   show what is applied / pending
#   ./scripts/migrate.sh --verify   run the tenant isolation assertions
#
# Migrations are applied in filename order, once, inside a transaction, and
# recorded with a checksum. A previously-applied file whose contents changed
# aborts the run rather than silently drifting.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/docker-compose.data.yml"
ENVFILE="$ROOT/infra/.env"
MIGDIR="$ROOT/db/migrations"
CONTAINER="vx-postgres"

[ -f "$ENVFILE" ] || { echo "FATAL: $ENVFILE not found. Copy .env.example first."; exit 1; }
set -a; . "$ENVFILE"; set +a

if [ "$(hostname)" != "acxnet07" ]; then
  echo "FATAL: expected acxnet07, running on $(hostname). Aborting."
  exit 1
fi

psql_run() {
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "FATAL: $CONTAINER is not running. Start it with ./scripts/deploy.sh"; exit 1; }

# --- tracking table -----------------------------------------------------------
psql_run -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms int
);
SQL

case "${1:-}" in
  --status)
    echo "=== applied ==="
    psql_run -tA -c "SELECT filename||'  '||applied_at FROM schema_migrations ORDER BY filename;"
    echo "=== pending ==="
    for f in "$MIGDIR"/*.sql; do
      b="$(basename "$f")"
      n=$(psql_run -tA -c "SELECT count(*) FROM schema_migrations WHERE filename='$b';")
      [ "$n" = "0" ] && echo "$b"
    done
    exit 0
    ;;
  --verify)
    echo "=== structural checks ==="
    psql_run -c "
      SELECT c.relname AS unprotected_table
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='org_id'
      WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;"
    psql_run -c "
      SELECT tablename, count(*) AS overlapping_policies
      FROM pg_policies WHERE schemaname='public'
      GROUP BY tablename HAVING count(*) > 1;"
    psql_run -tA -c "
      SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relkind='r')||' tables, '||
             (SELECT count(*) FROM pg_policies WHERE schemaname='public')||' policies';"
    echo "Both result sets above must be EMPTY."
    exit 0
    ;;
esac

# --- apply --------------------------------------------------------------------
applied=0
for f in "$MIGDIR"/*.sql; do
  b="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  prev="$(psql_run -tA -c "SELECT checksum FROM schema_migrations WHERE filename='$b';")"

  if [ -n "$prev" ]; then
    if [ "$prev" != "$sum" ]; then
      echo "FATAL: $b was already applied but its contents changed."
      echo "       Applied migrations are immutable. Write a new migration instead."
      exit 1
    fi
    echo "  skip   $b"
    continue
  fi

  echo "  apply  $b"
  # %s%3N (seconds + millis truncated from nanoseconds) assumes GNU date's
  # truncation behavior for the digit-count prefix; this box's `date` is
  # uutils coreutils, which doesn't truncate it and returns the full
  # nanosecond value instead — silently inflating duration_ms past
  # Postgres's int4 range on any migration slow enough to notice. Using
  # %s%N (always full nanoseconds, portable) and dividing down avoids
  # depending on that truncation behavior at all.
  start=$(date +%s%N)
  if ! docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
        psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$f"; then
    echo "FATAL: $b failed. Nothing recorded; fix and re-run."
    exit 1
  fi
  dur=$(( ($(date +%s%N) - start) / 1000000 ))
  psql_run -q -c "INSERT INTO schema_migrations (filename,checksum,duration_ms)
                  VALUES ('$b','$sum',$dur);"
  echo "         ok (${dur}ms)"
  applied=$((applied+1))
done

# --- sync the app role password from .env (safe to repeat) --------------------
if [ -n "${APP_DB_PASSWORD:-}" ] && [ "$APP_DB_PASSWORD" != "GENERATE_ME" ]; then
  psql_run -q -c "ALTER ROLE ${APP_DB_USER} PASSWORD '${APP_DB_PASSWORD}';"
  echo "  app role password synced from .env"
fi

echo
echo "$applied migration(s) applied. Run './scripts/migrate.sh --verify' next."
