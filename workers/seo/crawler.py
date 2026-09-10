"""
Venturelyx :: crawl engine.

Parsing logic derives from the acxnet02 crawler (~/seo-platform/crawler.py).
What changed is where work comes from and where results go; the extraction
itself was already correct.

This module is deliberately I/O only — it returns data structures and never
touches the database. Scoring and persistence live elsewhere so the crawler can
be tested without Postgres.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse, urldefrag

import httpx
from selectolax.parser import HTMLParser

log = logging.getLogger("vx.crawl")

SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:", "#")
ASSET_SUFFIXES = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".css", ".js",
    ".pdf", ".zip", ".mp4", ".mp3", ".woff", ".woff2", ".ttf", ".eot", ".avif",
)


@dataclass
class PageResult:
    url: str
    status_code: int | None = None
    redirect_to: str | None = None
    redirect_hops: int = 0
    title: str | None = None
    meta_description: str | None = None
    h1: str | None = None
    h1_count: int = 0
    canonical: str | None = None
    meta_robots: str | None = None
    indexable: bool | None = None
    word_count: int = 0
    links_out_int: int = 0
    links_out_ext: int = 0
    images_total: int = 0
    images_no_alt: int = 0
    schema_types: list[str] = field(default_factory=list)
    content_hash: str | None = None
    response_ms: int | None = None
    depth: int = 0
    error: str | None = None


@dataclass
class LinkResult:
    from_url: str
    to_url: str
    anchor: str | None
    is_internal: bool
    status_code: int | None = None


@dataclass
class CrawlOutput:
    pages: list[PageResult] = field(default_factory=list)
    links: list[LinkResult] = field(default_factory=list)
    robots_blocked: int = 0
    rendered: bool = False


@dataclass
class SiteConfig:
    """Mirrors a seo_sites row. Was per-entry YAML on acxnet02."""
    url: str
    max_pages: int = 500
    concurrency: int = 4
    delay_ms: int = 250
    timeout_s: int = 20
    respect_robots: bool = True
    render: bool = False
    user_agent: str = "VenturelyxBot/1.0 (+https://venturelyx.com/bot)"
    exclude_paths: list[str] = field(default_factory=lambda: ["/admin", "/login", "/dashboard", "/portal"])


INDEX_FILES = ("index.html", "index.htm", "index.php", "default.html", "default.htm")


def _norm(url: str) -> str:
    """Canonicalise so one page is one row.

    Drops fragments, trailing slashes, and directory index filenames. Without
    the last one, / and /index.html crawl as two pages with identical content
    and the site gets flagged for duplicate titles, duplicate descriptions and
    duplicate content it does not actually have. Every server does this; a tool
    that cries wolf on it is untrustworthy on the first report.
    """
    url, _ = urldefrag(url)
    parts = urlparse(url)
    path = parts.path or "/"   # https://x.test and https://x.test/ are one page
    for idx in INDEX_FILES:
        if path.endswith("/" + idx):
            path = path[: -len(idx)]
            break
        if path == "/" + idx:
            path = "/"
            break
    return parts._replace(path=path, fragment="", query=parts.query).geturl()


def _dedupe_key(url: str) -> str:
    """Identity for de-duplication only -- NEVER for fetching.

    /x and /x/ are the same page for counting purposes, but they are NOT
    interchangeable in a request: many servers 301 the slashless form to add
    the slash, and a misconfigured origin can leak an internal port doing it.
    Stripping the slash before fetching turns a healthy site into 16 phantom
    broken pages. Normalise for identity; request exactly what was linked.
    """
    p = urlparse(_norm(url))
    path = p.path[:-1] if p.path.endswith("/") and len(p.path) > 1 else p.path
    return p._replace(path=path).geturl()


def _same_host(a: str, b: str) -> bool:
    ha, hb = urlparse(a).netloc.lower(), urlparse(b).netloc.lower()
    return ha.removeprefix("www.") == hb.removeprefix("www.")


def _is_asset(url: str) -> bool:
    return urlparse(url).path.lower().endswith(ASSET_SUFFIXES)


def _text_of(node) -> str:
    return " ".join(node.text(separator=" ", strip=True).split()) if node else ""


def extract_schema_types(tree) -> list[str]:
    """Collect every @type in the page's JSON-LD, including nested graphs.

    Parse the JSON rather than scanning for the string: real-world blocks nest
    (@graph, arrays, mixed types) and string-scanning silently captures the rest
    of the object as the type name.
    """
    types: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            t = node.get("@type")
            if isinstance(t, str):
                types.add(t)
            elif isinstance(t, list):
                types.update(x for x in t if isinstance(x, str))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    for s in tree.css('script[type="application/ld+json"]'):
        raw = (s.text() or "").strip()
        if not raw:
            continue
        try:
            walk(json.loads(raw))
        except (json.JSONDecodeError, ValueError, RecursionError):
            log.debug("unparseable JSON-LD block skipped")
    return sorted(types)


def parse_page(url: str, html: str, base_url: str, depth: int) -> tuple[PageResult, list[LinkResult]]:
    tree = HTMLParser(html)
    p = PageResult(url=url, depth=depth)

    t = tree.css_first("title")
    p.title = _text_of(t) or None

    md = tree.css_first('meta[name="description"]')
    if md:
        p.meta_description = (md.attributes.get("content") or "").strip() or None

    h1s = tree.css("h1")
    p.h1_count = len(h1s)
    p.h1 = _text_of(h1s[0]) if h1s else None

    can = tree.css_first('link[rel="canonical"]')
    if can:
        href = can.attributes.get("href")
        p.canonical = urljoin(url, href) if href else None

    mr = tree.css_first('meta[name="robots"]')
    p.meta_robots = (mr.attributes.get("content") or "").strip().lower() if mr else None
    p.indexable = not (p.meta_robots and "noindex" in p.meta_robots)

    body = tree.css_first("body")
    text = _text_of(body)
    p.word_count = len(text.split())
    p.content_hash = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]

    imgs = tree.css("img")
    p.images_total = len(imgs)
    p.images_no_alt = sum(1 for i in imgs if not (i.attributes.get("alt") or "").strip())

    p.schema_types = extract_schema_types(tree)

    links: list[LinkResult] = []
    seen: set[str] = set()
    for a in tree.css("a[href]"):
        href = (a.attributes.get("href") or "").strip()
        if not href or href.lower().startswith(SKIP_SCHEMES):
            continue
        target = _norm(urljoin(url, href))
        if target in seen:
            continue
        seen.add(target)
        internal = _same_host(target, base_url)
        links.append(LinkResult(url, target, _text_of(a)[:200] or None, internal))
        if internal:
            p.links_out_int += 1
        else:
            p.links_out_ext += 1

    return p, links


async def _fetch_robots(client: httpx.AsyncClient, base: str) -> list[str]:
    """Minimal robots.txt: Disallow rules under a matching User-agent block."""
    disallow: list[str] = []
    try:
        r = await client.get(urljoin(base, "/robots.txt"), timeout=10)
        if r.status_code != 200:
            return disallow
        applies = False
        for line in r.text.splitlines():
            line = line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            k, v = (x.strip() for x in line.split(":", 1))
            k = k.lower()
            if k == "user-agent":
                applies = v in ("*", "venturelyxbot")
            elif k == "disallow" and applies and v:
                disallow.append(v)
    except Exception as e:
        log.debug("robots.txt unavailable for %s: %s", base, e)
    return disallow


def _blocked(url: str, rules: list[str], excludes: list[str]) -> bool:
    path = urlparse(url).path or "/"
    return any(path.startswith(r) for r in rules) or any(path.startswith(e) for e in excludes)


async def _fetch_httpx(
    client: httpx.AsyncClient, url: str, base: str, depth: int,
) -> tuple[PageResult, list[LinkResult]]:
    t0 = time.perf_counter()
    try:
        r = await client.get(url)
    except Exception as e:
        return PageResult(url=url, depth=depth, error=str(e)[:300]), []
    elapsed = int((time.perf_counter() - t0) * 1000)

    ctype = r.headers.get("content-type", "")
    if "html" not in ctype.lower():
        return PageResult(url=url, status_code=r.status_code, depth=depth, response_ms=elapsed), []

    page, links = parse_page(str(r.url), r.text, base, depth)
    page.status_code = r.status_code
    page.response_ms = elapsed
    page.redirect_hops = len(r.history)
    if r.history:
        page.redirect_to = str(r.url)
        page.url = url  # record the requested URL, not the destination
    return page, links


# Render-path only (SiteConfig.render). Blocking these resource types cuts
# memory/bandwidth for a live JS bundle without touching content extraction —
# stylesheets and scripts stay on since some frameworks gate content visibility
# behind CSS, and script execution is the entire point of rendering.
BLOCKED_RESOURCE_TYPES = {"image", "media", "font"}


async def _route_filter(route):
    if route.request.resource_type in BLOCKED_RESOURCE_TYPES:
        await route.abort()
    else:
        await route.continue_()


async def _fetch_rendered(
    context, url: str, timeout_s: int, base: str, depth: int,
) -> tuple[PageResult, list[LinkResult]]:
    t0 = time.perf_counter()
    page = await context.new_page()
    try:
        await page.route("**/*", _route_filter)
        try:
            # networkidle (no in-flight requests for 500ms) rather than a
            # fixed settle after domcontentloaded — waits for the actual JS
            # bundle to finish fetching data instead of guessing a delay. A
            # site with truly persistent background traffic (a websocket,
            # recurring analytics polling) can make this never resolve; the
            # existing timeout_s still bounds it, so that page fails with a
            # per-page error rather than hanging the whole crawl.
            resp = await page.goto(url, wait_until="networkidle", timeout=timeout_s * 1000)
        except Exception as e:
            return PageResult(url=url, depth=depth, error=str(e)[:300]), []
        if resp is None:
            return PageResult(url=url, depth=depth, error="no response from goto"), []

        elapsed = int((time.perf_counter() - t0) * 1000)

        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype.lower():
            return PageResult(url=url, status_code=resp.status, depth=depth, response_ms=elapsed), []

        html = await page.content()
        final_url = resp.url

        # Playwright has no httpx-style .history list; walk the redirect chain
        # backwards via redirected_from to get the same hop-count semantics.
        hops = 0
        req = resp.request
        while req.redirected_from is not None:
            req = req.redirected_from
            hops += 1

        result, links = parse_page(final_url, html, base, depth)
        result.status_code = resp.status
        result.response_ms = elapsed
        result.redirect_hops = hops
        if hops:
            result.redirect_to = final_url
            result.url = url  # record the requested URL, not the destination
        return result, links
    finally:
        await page.close()


async def crawl_site(cfg: SiteConfig, on_progress=None) -> CrawlOutput:
    out = CrawlOutput(rendered=cfg.render)
    base = cfg.url.rstrip("/")
    start = _norm(base)

    headers = {"User-Agent": cfg.user_agent, "Accept": "text/html,application/xhtml+xml"}
    limits = httpx.Limits(max_connections=cfg.concurrency, max_keepalive_connections=cfg.concurrency)

    # Playwright only spins up for render=True sites — kept out of the import
    # graph and process footprint of every other crawl. One Browser + one
    # BrowserContext live for the whole crawl (cheap, and gives a real SPA
    # cookie/localStorage continuity across pages it might expect); only the
    # Page is per-URL. render_sem is deliberately capped independently of
    # cfg.concurrency: a live React/Vite tab can run 150-300MB+ under load,
    # so 2 concurrent tabs is the ceiling that keeps the worker container
    # inside its memory budget (see infra/docker-compose.workers.yml).
    pw = browser = browser_ctx = render_sem = None
    if cfg.render:
        from playwright.async_api import async_playwright
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        browser_ctx = await browser.new_context(
            user_agent=cfg.user_agent, viewport={"width": 1366, "height": 900},
        )
        render_sem = asyncio.Semaphore(max(1, min(cfg.concurrency, 2)))

    try:
        async with httpx.AsyncClient(
            headers=headers, timeout=cfg.timeout_s, follow_redirects=True,
            limits=limits, verify=True,
        ) as client:

            robots = await _fetch_robots(client, base) if cfg.respect_robots else []
            queue: asyncio.Queue = asyncio.Queue()
            await queue.put((start, 0))
            seen: set[str] = {_dedupe_key(start)}
            sem = asyncio.Semaphore(cfg.concurrency)
            done = 0

            async def fetch_one(url: str, depth: int):
                nonlocal done
                if cfg.render:
                    async with render_sem:
                        if cfg.delay_ms:
                            await asyncio.sleep(cfg.delay_ms / 1000)
                        page, links = await _fetch_rendered(browser_ctx, url, cfg.timeout_s, base, depth)
                else:
                    async with sem:
                        if cfg.delay_ms:
                            await asyncio.sleep(cfg.delay_ms / 1000)
                        page, links = await _fetch_httpx(client, url, base, depth)

                out.pages.append(page)
                out.links.extend(links)

                done += 1
                if on_progress and done % 10 == 0:
                    on_progress(done)

                if depth < 6:
                    for l in links:
                        if not l.is_internal or _is_asset(l.to_url):
                            continue
                        key = _dedupe_key(l.to_url)
                        if key in seen or len(seen) >= cfg.max_pages:
                            continue
                        if _blocked(l.to_url, robots, cfg.exclude_paths):
                            out.robots_blocked += 1
                            continue
                        seen.add(key)
                        await queue.put((l.to_url, depth + 1))

            while not queue.empty():
                batch = []
                while not queue.empty() and len(batch) < cfg.concurrency * 2:
                    url, depth = await queue.get()
                    batch.append(fetch_one(url, depth))
                await asyncio.gather(*batch, return_exceptions=True)

            # Resolve link targets we never crawled (external + excluded internal),
            # so broken-link detection covers the whole graph, not just the crawl
            # set. Status-code only, so this stays httpx even in render mode.
            crawled = {p.url: p.status_code for p in out.pages}
            targets = {l.to_url for l in out.links if l.to_url not in crawled}
            checked: dict[str, int | None] = {}

            async def head_one(u: str):
                async with sem:
                    try:
                        r = await client.head(u, timeout=10)
                        if r.status_code in (405, 501):  # HEAD unsupported
                            r = await client.get(u, timeout=10)
                        checked[u] = r.status_code
                    except Exception:
                        checked[u] = None

            targets = list(targets)[:400]  # bound the tail; enough to catch real rot
            for i in range(0, len(targets), cfg.concurrency * 2):
                await asyncio.gather(*(head_one(u) for u in targets[i:i + cfg.concurrency * 2]),
                                     return_exceptions=True)

            for l in out.links:
                l.status_code = crawled.get(l.to_url, checked.get(l.to_url))
    finally:
        # A crawl that raises mid-way must not leak the browser — worker.py
        # is one long-lived process handling job after job, so an unclosed
        # Chromium here outlives this job and eats memory for every job after.
        if browser_ctx is not None:
            await browser_ctx.close()
        if browser is not None:
            await browser.close()
        if pw is not None:
            await pw.stop()

    return out
