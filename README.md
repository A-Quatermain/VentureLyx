# Venturelyx

Business Launch & Growth Operating System. Multi-tenant platform for SMBs.

Modules: Build · Source · Operate · ScaleSEO · Grow · AI Team → Command Center

## Layout
cd /opt/venturelyx

cat > .gitignore <<'EOF'
# secrets — never commit
infra/.env
infra/*.env
secrets/
*.pem
*.key

# data
backups/
artifacts/
*.dump
*.dump.sha256
*.log

# build
node_modules/
dist/
.next/
__pycache__/
*.pyc
.venv/

.DS_Store
