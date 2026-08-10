#!/usr/bin/env bash
# =============================================================================
# Venturelyx :: deploy the data tier
#   ./scripts/deploy.sh
# Idempotent. Safe to re-run.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/docker-compose.data.yml"
ENVFILE="$ROOT/infra/.env"

if [ "$(hostname)" != "acxnet07" ]; then
  echo "FATAL: expected acxnet07, running on $(hostname). Aborting."
  exit 1
fi

echo "=== preflight ==="
[ -f "$ENVFILE" ] || { echo "FATAL: $ENVFILE missing. cp infra/.env.example infra/.env && nano it"; exit 1; }

if grep -q 'GENERATE_ME' "$ENVFILE"; then
  echo "FATAL: $ENVFILE still contains GENERATE_ME placeholders:"
  grep -n 'GENERATE_ME' "$ENVFILE" | sed 's/^/       /'
  echo
  echo "Generate each with:  openssl rand -hex 32"
  exit 1
fi
chmod 600 "$ENVFILE"

set -a; . "$ENVFILE"; set +a

# VAULT_KEY must be exactly 32 bytes for AES-256-GCM
if [ "${#VAULT_KEY}" -ne 64 ]; then
  echo "FATAL: VAULT_KEY must be 64 hex characters (32 bytes). Got ${#VAULT_KEY}."
  exit 1
fi

docker compose version >/dev/null || { echo "FATAL: docker compose unavailable"; exit 1; }
mkdir -p /opt/venturelyx/{backups,artifacts,secrets}
chmod 700 /opt/venturelyx/secrets

echo "  env ok, secrets present, vault key correct length"
echo
echo "=== pulling images ==="
docker compose -f "$COMPOSE" --env-file "$ENVFILE" pull --quiet

echo
echo "=== starting ==="
docker compose -f "$COMPOSE" --env-file "$ENVFILE" up -d

echo
echo "=== waiting for health ==="
for i in $(seq 1 60); do
  unhealthy=$(docker compose -f "$COMPOSE" --env-file "$ENVFILE" ps --format json 2>/dev/null \
    | python3 -c "
import sys,json
bad=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    h=d.get('Health','')
    if h and h!='healthy': bad.append(d.get('Name','?')+':'+h)
print(','.join(bad))" 2>/dev/null || echo "parse")
  [ -z "$unhealthy" ] && { echo "  all healthy"; break; }
  [ "$i" = "60" ] && { echo "  TIMEOUT — still unhealthy: $unhealthy"; }
  sleep 2
done

echo
docker compose -f "$COMPOSE" --env-file "$ENVFILE" ps

echo
echo "=== next ==="
echo "  ./scripts/migrate.sh          apply schema"
echo "  ./scripts/migrate.sh --verify confirm tenant isolation"
