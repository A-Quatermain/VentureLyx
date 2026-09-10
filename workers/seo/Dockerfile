# Pinned to bookworm (Debian 12), not the floating `slim` tag: Playwright's
# dependency installer (playwright install --with-deps) only recognizes
# specific distros, and `slim` now resolves to trixie (Debian 13), which it
# doesn't know — it silently falls back to an Ubuntu 20.04 package list whose
# font packages (ttf-ubuntu-font-family, ttf-unifont) don't exist in trixie's
# repos, and the build fails. bookworm is a release Playwright 1.49.0 actually
# supports.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Lands Chromium under /app so the chown below (which runs after this) covers
# it — the default path lives under /root, unreachable for the non-root user
# this image switches to at the end.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Root here (Docker build default, before USER below) — playwright install
# --with-deps needs apt-get, which the container's non-root runtime user
# cannot do. Chromium only (not firefox/webkit) to bound the size increase.
RUN playwright install --with-deps chromium

COPY *.py ./

# Never run as root. The crawler parses hostile HTML from the open internet.
RUN useradd -m -u 10001 crawler && chown -R crawler:crawler /app
USER crawler

CMD ["python", "worker.py"]
