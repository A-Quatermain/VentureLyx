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

# -Fc = custom format: compressed, and pg_restore can do selective restores
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl \
  > "$OUT"

# A dump that cannot be listed is not a backup.
if ! docker exec -i "$CONTAINER" pg_restore --list /dev/stdin < "$OUT" >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] FATAL: dump failed verification, removing"
  rm -f "$OUT"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256"
echo "[$(date -u +%FT%TZ)] ok — $SIZE, verified"

# retention
DELETED=$(find "$BACKUP_DIR" -name 'venturelyx_*.dump*' -mtime "+$RETAIN" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "[$(date -u +%FT%TZ)] pruned $DELETED file(s) older than ${RETAIN}d"

# disk guard — a full disk stops Postgres accepting writes
AVAIL=$(df --output=pcent /opt/venturelyx | tail -1 | tr -dc '0-9')
[ "$AVAIL" -gt 85 ] && echo "[$(date -u +%FT%TZ)] WARNING: disk ${AVAIL}% full"

ls -1t "$BACKUP_DIR"/venturelyx_*.dump 2>/dev/null | head -5 | sed 's/^/  /'
exit 0
