#!/usr/bin/env bash
# =============================================================================
# Venturelyx :: PostgreSQL backup
#   ./scripts/backup-postgres.sh
#
# Writes a verified custom-format dump to /opt/venturelyx/backups.
# Cron:  15 3 * * *  /opt/venturelyx/scripts/backup-postgres.sh >> /var/log/vx-backup.log 2>&1
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/infra/.env"
BACKUP_DIR="/opt/venturelyx/backups"
CONTAINER="vx-postgres"

[ -f "$ENVFILE" ] || { echo "FATAL: $ENVFILE not found"; exit 1; }
set -a; . "$ENVFILE"; set +a
RETAIN="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/venturelyx_${STAMP}.dump"

echo "[$(date -u +%FT%TZ)] backup starting -> $(basename "$OUT")"

# Cron runs at 03:15, which collides with unattended-upgrades and Docker
# restarts. Wait for Postgres to accept connections rather than producing an
# empty dump that verification then throws away.
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  [ "$i" = "1" ] && echo "[$(date -u +%FT%TZ)] waiting for postgres..."
  [ "$i" = "30" ] && { echo "[$(date -u +%FT%TZ)] FATAL: postgres not ready after 5 minutes"; exit 1; }
  sleep 10
done

# -Fc = custom format: compressed, and pg_restore can do selective restores
# Dump and verify INSIDE the container via the /backups bind mount.
# Piping through /dev/stdin fails: pg_restore needs a seekable file for
# custom-format archives, and a pipe is not seekable.
NAME="$(basename "$OUT")"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl \
  -f "/backups/$NAME"

if ! docker exec "$CONTAINER" pg_restore --list "/backups/$NAME" >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] FATAL: dump failed verification:"
  docker exec "$CONTAINER" pg_restore --list "/backups/$NAME" 2>&1 | head -5
  docker exec "$CONTAINER" rm -f "/backups/$NAME"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
sha256sum "$OUT" > "$OUT.sha256"
# pg_dump writes as the postgres uid inside the container, so the dump lands
# owned by 999:999 on the host and an unprivileged user cannot chmod it.
# Set its mode from inside the container; the sha256 file is ours already.
docker exec "$CONTAINER" chmod 600 "/backups/$NAME" 2>/dev/null || true
chmod 600 "$OUT.sha256" 2>/dev/null || true
echo "[$(date -u +%FT%TZ)] ok — $SIZE, verified"

# retention
DELETED=$(find "$BACKUP_DIR" -name 'venturelyx_*.dump*' -mtime "+$RETAIN" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "[$(date -u +%FT%TZ)] pruned $DELETED file(s) older than ${RETAIN}d"

# disk guard — a full disk stops Postgres accepting writes
AVAIL=$(df --output=pcent /opt/venturelyx | tail -1 | tr -dc '0-9')
[ "$AVAIL" -gt 85 ] && echo "[$(date -u +%FT%TZ)] WARNING: disk ${AVAIL}% full"

ls -1t "$BACKUP_DIR"/venturelyx_*.dump 2>/dev/null | head -5 | sed 's/^/  /'
exit 0
