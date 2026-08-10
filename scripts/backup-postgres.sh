#!/usr/bin/env bash
# Venturelyx :: PostgreSQL backup — dumps and verifies inside the container
# via the /backups bind mount. No stdin/stdout piping.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/infra/.env"
BACKUP_DIR="/opt/venturelyx/backups"
CONTAINER="vx-postgres"

[ -f "$ENVFILE" ] || { echo "FATAL: $ENVFILE not found"; exit 1; }
set -a; . "$ENVFILE"; set +a
RETAIN="${BACKUP_RETENTION_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="venturelyx_${STAMP}.dump"

echo "[$(date -u +%FT%TZ)] backup starting -> $NAME"

# dump directly to the bind mount from inside the container
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl \
  -f "/backups/$NAME"

# verify against the real, seekable file
if ! docker exec "$CONTAINER" pg_restore --list "/backups/$NAME" >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] FATAL: dump failed verification:"
  docker exec "$CONTAINER" pg_restore --list "/backups/$NAME" 2>&1 | head -5
  docker exec "$CONTAINER" rm -f "/backups/$NAME"
  exit 1
fi

OUT="$BACKUP_DIR/$NAME"
SIZE=$(du -h "$OUT" | cut -f1)
ENTRIES=$(docker exec "$CONTAINER" pg_restore --list "/backups/$NAME" | grep -c '^[0-9]' || true)
sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256" 2>/dev/null || sudo chmod 600 "$OUT" "$OUT.sha256"
echo "[$(date -u +%FT%TZ)] ok — $SIZE, $ENTRIES archive entries, verified"

DELETED=$(find "$BACKUP_DIR" -name 'venturelyx_*.dump*' -mtime "+$RETAIN" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "[$(date -u +%FT%TZ)] pruned $DELETED file(s) older than ${RETAIN}d"

PCT=$(df --output=pcent /opt/venturelyx | tail -1 | tr -dc '0-9')
[ "$PCT" -gt 85 ] && echo "[$(date -u +%FT%TZ)] WARNING: disk ${PCT}% full"

ls -1t "$BACKUP_DIR"/venturelyx_*.dump 2>/dev/null | head -5 | sed 's/^/  /'
exit 0
