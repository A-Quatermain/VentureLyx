#!/usr/bin/env bash
# Venturelyx :: move WinSCP uploads from /home/asaranga into the repo tree.
#   Upload flat to /home/asaranga, then:  ./scripts/place-uploads.sh
# Idempotent. Routes by filename, strips CRLF, syntax-checks, leaves originals.
set -uo pipefail
[ "$(hostname)" = "acxnet07" ] || { echo "WRONG HOST: $(hostname)"; exit 1; }

SRC="${1:-/home/asaranga}"
DST="/opt/venturelyx"
mkdir -p "$DST"/{docs,infra,db/migrations,db/test,scripts,workers/seo,mockups,api,web}

echo "=== scanning $SRC ==="
found=0

route() {  # route <destdir> <newname> <glob...>
  local sub="$1" name="$2"; shift 2
  local f
  for pat in "$@"; do
    f=$(find "$SRC" -maxdepth 1 -type f -iname "$pat" 2>/dev/null | head -1)
    [ -n "$f" ] && break
  done
  [ -z "$f" ] && return 1
  cp -f "$f" "$DST/$sub/$name"
  echo "  -> $sub/$name   (from $(basename "$f"))"
  found=$((found+1))
}

# --- SQL migrations: keep their own numbering ---
for f in "$SRC"/[0-9][0-9][0-9]_*.sql "$SRC"/*[0-9][0-9][0-9]_*.sql; do
  [ -e "$f" ] || continue
  base=$(basename "$f" | sed -E 's/.*([0-9]{3}_[a-z_]+)\.sql.*/\1.sql/')
  cp -f "$f" "$DST/db/migrations/$base"
  echo "  -> db/migrations/$base   (from $(basename "$f"))"
  found=$((found+1))
done

route db/test    isolation_test.sql          'isolation_test*.sql'
route workers/seo db.py                      'db.py' 'db (*).py'
route workers/seo crawler.py                 'crawler.py' 'crawler (*).py'
route workers/seo scoring.py                 'scoring.py' 'scoring (*).py'
route workers/seo worker.py                  'worker.py' 'worker (*).py'
route workers/seo requirements.txt           'requirements*.txt'
route workers/seo Dockerfile                 'Dockerfile' 'Dockerfile.*' 'Dockerfile*'
route scripts    seed_sites.py               'seed_sites*.py' 'seed sites*.py'
route scripts    crawl.py                    'crawl.py' 'crawl (*).py'
route scripts    deploy.sh                   'deploy*.sh'
route scripts    migrate.sh                  'migrate*.sh'
route scripts    backup-postgres.sh          'backup-postgres*.sh'
route infra      docker-compose.data.yml     'docker-compose.data*.y*ml'
route infra      docker-compose.workers.yml  'docker-compose.workers*.y*ml'
route infra      .env.example                '.env.example' 'env.example'
route mockups    command-center.html         'command-center*.html'
route docs       ARCHITECTURE.md             'ARCHITECTURE*.md'
route docs       DESIGN.md                   'DESIGN*.md'
route docs       DEPLOY-BLOCK1.md            'DEPLOY-BLOCK1*.md'
route docs       DEPLOY-SEO-WORKER.md        'DEPLOY-SEO-WORKER*.md'
route docs       README.md                   'README*.md'

command -v dos2unix >/dev/null || sudo apt-get install -y dos2unix >/dev/null 2>&1
find "$DST" -path "$DST/.git" -prune -o -type f \
  \( -name '*.sh' -o -name '*.py' -o -name '*.sql' -o -name '*.yml' -o -name '*.md' \) \
  -exec dos2unix -q {} \; 2>/dev/null
chmod +x "$DST"/scripts/*.sh "$DST"/scripts/*.py 2>/dev/null

echo; echo "=== $found file(s) placed. verifying ==="
rc=0
for f in $(find "$DST/workers" "$DST/scripts" -name '*.py' 2>/dev/null); do
  ( cd "$(dirname "$f")" && python3 -m py_compile "$(basename "$f")" ) 2>/dev/null \
    && echo "  ok      ${f#$DST/}" || { echo "  BROKEN  ${f#$DST/}"; rc=1; }
done
for y in "$DST"/infra/*.yml; do
  [ -e "$y" ] || continue
  python3 -c "import yaml,sys;yaml.safe_load(open('$y'))" 2>/dev/null \
    && echo "  ok      ${y#$DST/}" || { echo "  BAD YAML ${y#$DST/}"; rc=1; }
done
find "$DST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null

echo
[ "$rc" = "0" ] && echo ">>> ALL PLACED FILES VALID" || echo ">>> SOMETHING FAILED VERIFICATION"
echo ">>> originals left in $SRC — delete when you're satisfied"
