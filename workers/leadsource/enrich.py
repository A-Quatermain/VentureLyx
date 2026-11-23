"""
Venturelyx :: LeadSource enrichment (Phase 3).

For each lead needing enrichment: flag a registered-agent/virtual
address, find and self-confirm a website, pull an email/phone from THAT
confirmed page only (never pattern-guessed, never a people-search site,
never LinkedIn), and verify any found email with ZeroBounce before it can
ever count as "enriched."

Website discovery is two-tier, in this order:
  1. domain_guess — normalize the business name into a handful of likely
     domains, fetch each ourselves, accept the first one whose own page
     text actually contains the business's name. Nothing from a third
     party here, so the confirmed URL is ours to keep.
  2. search_transient — only if (1) found nothing AND the org has saved
     its own working Brave Search API key (leadsource_provider_keys).
     Brave's Search API Terms of Use (3(b)(i)) bar storing or caching
     Search Results — including result URLs — beyond transient use
     during the one operation that produced them. So: query Brave, fetch
     and self-confirm a candidate the same way as (1), extract contact
     info from the confirmed page, then DISCARD the URL. website_found
     is recorded true; website_url is NOT.

A lead's status can only become 'enriched' through the logic in
enrich_one() below — never by a caller setting the column directly to
something stronger than what was actually found/verified. In particular,
an email that was found but could not be run through ZeroBounce (balance
exhausted, API error, no key configured) is 'found_unverified' and that
alone can never produce 'enriched' — only 'partial'. Nothing in this file
pushes a lead or its enrichment row into Grow or /opt/outreach; that
bridge doesn't exist yet, and found_unverified emails must never be the
thing that creates it.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
from selectolax.parser import HTMLParser

import db
import vault

log = logging.getLogger("vx.leadsource.enrich")

# Politer than an owned-site crawl, same reasoning as workers/seo/competitors.py
# (DELAY_MS=600, CONCURRENCY=1): these are sites Venturelyx does not own,
# fetched on a stranger's behalf. One lead at a time, a pause between every
# outbound request this module makes — domain-guess candidates, the
# confirmation fetch, and (if it runs) the single Brave call.
REQUEST_DELAY_S = 0.6
FETCH_TIMEOUT_S = 8
USER_AGENT = "VenturelyxBot/1.0 (+https://venturelyx.com/bot; lead enrichment)"

LEGAL_SUFFIXES = {
    "LLC", "L.L.C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO",
    "COMPANY", "LP", "LLP", "LTD", "PA", "PLLC", "PC", "LC",
}
STOPWORDS = {
    "THE", "OF", "AND", "SERVICES", "SERVICE", "GROUP", "ENTERPRISES",
    "HOLDINGS", "MANAGEMENT", "SOLUTIONS", "FLORIDA", "USA",
}

# Agents/virtual-office providers commonly used as a registered agent —
# a match here means the filing's "principal address" is that provider's
# office, not the business's own location. Not exhaustive; a false
# negative here just means a virtual address goes unflagged, which is no
# worse than before this field existed.
VIRTUAL_RA_KEYWORDS = [
    "REGISTERED AGENTS INC", "NORTHWEST REGISTERED AGENT", "REGISTERED AGENT SOLUTIONS",
    "CORPORATION SERVICE COMPANY", "CSC-LAWYERS", "COGENCY GLOBAL", "CT CORPORATION",
    "NATIONAL REGISTERED AGENTS", "INCORP SERVICES", "HARBOR COMPLIANCE", "LEGALZOOM",
    "REGUS", "WEWORK", "IPOSTAL", "THE UPS STORE", "UPS STORE",
]

PHONE_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b")

ZB_DEFINITIVE_BAD = {"invalid", "spamtrap", "abuse", "do_not_mail"}
ZB_OK_MAP = {"valid": "valid", "catch-all": "unknown", "unknown": "unknown"}


def is_virtual_or_agent_address(ra_name: str | None) -> bool:
    if not ra_name:
        return False
    upper = ra_name.upper()
    return any(k in upper for k in VIRTUAL_RA_KEYWORDS)


def _normalize_name(name: str) -> str:
    tokens = re.split(r"[\s,]+", (name or "").strip())
    while tokens and tokens[-1].upper().rstrip(".") in LEGAL_SUFFIXES:
        tokens.pop()
    core = " ".join(tokens)
    return re.sub(r"[^A-Za-z0-9 ]", "", core).strip()


def candidate_domains(name: str) -> list[str]:
    core = _normalize_name(name)
    if not core:
        return []
    compact = core.lower().replace(" ", "")
    hyphenated = "-".join(core.lower().split())
    seen: list[str] = []
    for base in (compact, hyphenated):
        if base and base not in seen:
            seen.append(base)
    return [f"https://{base}{tld}" for base in seen for tld in (".com", ".net")][:4]


def significant_tokens(name: str) -> list[str]:
    core = _normalize_name(name)
    return [t for t in core.split() if len(t) >= 4 and t.upper() not in STOPWORDS]


async def _fetch_robots_disallow(client: httpx.AsyncClient, base: str) -> list[str]:
    """Minimal robots.txt check — same approach as workers/seo/crawler.py's
    _fetch_robots, re-implemented here rather than imported (separate
    package, separate Docker image — see db.py's own header on why each
    worker duplicates small pieces instead of sharing a module)."""
    disallow: list[str] = []
    try:
        r = await client.get(f"{base}/robots.txt", timeout=10)
        if r.status_code != 200:
            return disallow
        applies = False
        for line in r.text.splitlines():
            line = line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            k, v = (x.strip() for x in line.split(":", 1))
            if k.lower() == "user-agent":
                applies = v in ("*", "venturelyxbot")
            elif k.lower() == "disallow" and applies and v:
                disallow.append(v)
    except Exception as e:
        log.debug("robots.txt unavailable for %s: %s", base, e)
    return disallow


def _blocked(url: str, rules: list[str]) -> bool:
    path = urlparse(url).path or "/"
    return any(path.startswith(r) for r in rules)


async def fetch_confirm(client: httpx.AsyncClient, url: str, name: str) -> str | None:
    """Fetches url, returns its HTML only if the business's own name
    actually appears on the page — never accepts a candidate on domain
    match alone. Returns None for anything blocked, broken, or
    unconfirmed."""
    tokens = significant_tokens(name)
    if not tokens:
        return None
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    rules = await _fetch_robots_disallow(client, base)
    if _blocked(url, rules):
        return None
    try:
        r = await client.get(url, timeout=FETCH_TIMEOUT_S, follow_redirects=True)
    except Exception:
        return None
    if r.status_code != 200 or "html" not in r.headers.get("content-type", "").lower():
        return None
    text_upper = r.text.upper()
    if any(t.upper() in text_upper for t in tokens):
        return r.text
    return None


def extract_contact(html: str) -> tuple[str | None, str | None]:
    tree = HTMLParser(html)
    email = None
    for a in tree.css("a[href]"):
        href = (a.attributes.get("href") or "").strip()
        if href.lower().startswith("mailto:"):
            candidate = href[7:].split("?")[0].strip()
            if candidate:
                email = candidate
                break
    body = tree.css_first("body")
    text = " ".join(body.text(separator=" ", strip=True).split()) if body else ""
    phones = PHONE_RE.findall(text)
    phone = "".join(phones[0]) if phones else None
    return email, phone


async def brave_search_transient(client: httpx.AsyncClient, query: str, api_key: str) -> tuple[str, list[str]]:
    """Returns (outcome, candidate_urls). outcome is 'ok' | 'invalid' |
    'quota_exceeded' | 'error'. Candidate URLs are used ONLY by the caller
    to fetch-and-confirm within this same run — never persisted, never
    logged in full (see enrich_one)."""
    try:
        r = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": 3},
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
            timeout=10,
        )
    except Exception:
        return "error", []
    if r.status_code in (401, 403):
        return "invalid", []
    if r.status_code == 429:
        return "quota_exceeded", []
    if r.status_code != 200:
        return "error", []
    try:
        data = r.json()
        results = data.get("web", {}).get("results", [])
        return "ok", [x["url"] for x in results if x.get("url")][:3]
    except Exception:
        return "error", []


async def verify_email_zerobounce(client: httpx.AsyncClient, email: str) -> tuple[str | None, str | None]:
    """Returns (status, detail). status is 'valid'|'risky'|'unknown' (a real
    verify ran), 'found_unverified' (couldn't verify — balance, error, no
    key), or 'discard' (ZeroBounce confidently says this mailbox doesn't
    work — the caller drops the email entirely rather than reporting a
    known-bad address as a found contact)."""
    api_key = os.environ.get("ZEROBOUNCE_API_KEY")
    if not api_key:
        return "found_unverified", "no ZEROBOUNCE_API_KEY configured"
    try:
        r = await client.get(
            "https://api.zerobounce.net/v2/validate",
            params={"api_key": api_key, "email": email}, timeout=FETCH_TIMEOUT_S,
        )
        body = r.json()
    except Exception as e:
        return "found_unverified", str(e)[:200]
    if isinstance(body, dict) and body.get("error"):
        return "found_unverified", str(body["error"])[:200]
    status = body.get("status") if isinstance(body, dict) else None
    if status in ZB_DEFINITIVE_BAD:
        return "discard", f"provider:{status}"
    if status in ZB_OK_MAP:
        return ZB_OK_MAP[status], None
    return "found_unverified", f"unrecognized status: {status}"


def _recheck_delay(attempt_count: int) -> timedelta:
    if attempt_count <= 1:
        return timedelta(days=30)
    if attempt_count == 2:
        return timedelta(days=60)
    return timedelta(days=90)


def get_leads_to_enrich(conn, org_id: str, max_leads: int) -> list[dict]:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """SELECT l.id AS lead_id, l.source, l.source_id, r.raw,
                      COALESCE(e.attempt_count, 0) AS attempt_count
                 FROM leadsource_leads l
                 JOIN leadsource_raw_records r ON r.source = l.source AND r.source_id = l.source_id
            LEFT JOIN leadsource_enrichment e ON e.lead_id = l.id
                WHERE l.org_id = %(org_id)s
                  AND (e.id IS NULL OR (e.status IN ('no_website', 'partial') AND e.next_recheck_at <= now()))
             ORDER BY l.first_seen_at ASC
                LIMIT %(max_leads)s""",
            {"org_id": org_id, "max_leads": max_leads},
        )
        return cur.fetchall()


def get_usable_provider_key(conn, org_id: str) -> dict | None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """SELECT key_enc, key_iv, key_tag, status, monthly_search_cap,
                      searches_this_month, searches_month_reset_at
                 FROM leadsource_provider_keys
                WHERE org_id = %(org_id)s AND provider = 'brave' AND revoked_at IS NULL""",
            {"org_id": org_id},
        )
        row = cur.fetchone()
    if not row or row["status"] in ("invalid", "quota_exceeded"):
        return None
    today = date.today()
    reset = row["searches_month_reset_at"]
    used = 0 if (reset.month, reset.year) != (today.month, today.year) else row["searches_this_month"]
    if used >= row["monthly_search_cap"]:
        return None
    key = vault.decrypt_secret(row["key_enc"], row["key_iv"], row["key_tag"])
    return {"key": key, "used_this_month": used}


def record_brave_usage(conn, org_id: str, outcome: str) -> None:
    """Increments the usage counter (resetting it first if the calendar
    month has rolled over) and, on a definitive invalid/quota_exceeded
    outcome, marks the key's status so this run (and every later one)
    stops calling Brave for this org without a human re-saving the key —
    never a silent retry loop."""
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """UPDATE leadsource_provider_keys SET
                 searches_this_month = CASE
                   WHEN date_trunc('month', searches_month_reset_at) <> date_trunc('month', now()) THEN 1
                   ELSE searches_this_month + 1
                 END,
                 searches_month_reset_at = CASE
                   WHEN date_trunc('month', searches_month_reset_at) <> date_trunc('month', now()) THEN date_trunc('month', now())::date
                   ELSE searches_month_reset_at
                 END,
                 status = CASE WHEN %(outcome)s IN ('invalid', 'quota_exceeded') THEN %(outcome)s ELSE status END,
                 last_error = CASE WHEN %(outcome)s IN ('invalid', 'quota_exceeded', 'error') THEN %(detail)s ELSE last_error END
               WHERE org_id = %(org_id)s AND provider = 'brave' AND revoked_at IS NULL""",
            {"org_id": org_id, "outcome": outcome, "detail": f"last real-usage call: {outcome}"},
        )


async def enrich_one(client: httpx.AsyncClient, lead: dict, provider_key: dict | None) -> dict:
    raw = lead["raw"]
    name = raw.get("corp_name") or raw.get("name") or ""
    now = datetime.now(timezone.utc)

    result: dict = {
        "is_virtual_or_agent_address": is_virtual_or_agent_address(raw.get("ra_name")),
        "website_found": False, "website_url": None, "website_source": None,
        "website_confidence": None, "website_found_at": None,
        "email": None, "email_source": None, "email_found_at": None,
        "email_verify_status": None, "email_verified_at": None,
        "phone": None, "phone_source": None, "phone_found_at": None,
        "status": "no_website", "last_error": None,
        "_tried_domains": [], "_brave_outcome": None,
    }

    confirmed_html = None
    for candidate in candidate_domains(name):
        result["_tried_domains"].append(candidate)
        await asyncio.sleep(REQUEST_DELAY_S)
        html = await fetch_confirm(client, candidate, name)
        if html is not None:
            confirmed_html = html
            result["website_source"] = "domain_guess"
            result["website_url"] = candidate
            break

    if confirmed_html is None and provider_key is not None:
        query = f'"{name}" {raw.get("city", "")} FL'
        await asyncio.sleep(REQUEST_DELAY_S)
        outcome, urls = await brave_search_transient(client, query, provider_key["key"])
        result["_brave_outcome"] = outcome
        if outcome == "ok":
            for u in urls:
                await asyncio.sleep(REQUEST_DELAY_S)
                html = await fetch_confirm(client, u, name)
                if html is not None:
                    confirmed_html = html
                    result["website_source"] = "search_transient"
                    # website_url deliberately left None — see module header.
                    break

    if confirmed_html is not None:
        result["website_found"] = True
        result["website_confidence"] = "confirmed"
        result["website_found_at"] = now

        email, phone = extract_contact(confirmed_html)
        if phone:
            result["phone"], result["phone_source"], result["phone_found_at"] = phone, "own_site", now

        if email:
            verify_status, _detail = await verify_email_zerobounce(client, email)
            if verify_status == "discard":
                pass  # ZeroBounce confidently says this mailbox doesn't work — don't report it as found
            else:
                result["email"], result["email_source"], result["email_found_at"] = email, "own_site", now
                if verify_status == "found_unverified":
                    result["email_verify_status"] = "found_unverified"
                else:
                    result["email_verify_status"] = verify_status
                    result["email_verified_at"] = now

        has_usable_email = result["email"] is not None and result["email_verify_status"] != "found_unverified"
        if has_usable_email or result["phone"]:
            result["status"] = "enriched"
        else:
            result["status"] = "partial"
    else:
        result["status"] = "no_website"
        tried = ", ".join(result["_tried_domains"]) or "(no candidates — name too short/generic)"
        brave_note = f"; brave:{result['_brave_outcome']}" if result["_brave_outcome"] else ""
        result["last_error"] = f"tried: {tried}{brave_note}"

    return result


def save_enrichment(conn, org_id: str, lead_id: str, attempt_count_before: int, result: dict) -> None:
    attempt_count = attempt_count_before + 1
    next_recheck_at = (datetime.now(timezone.utc) + _recheck_delay(attempt_count)) if result["status"] == "no_website" else None
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """INSERT INTO leadsource_enrichment
                 (lead_id, org_id, is_virtual_or_agent_address, website_found, website_url, website_source,
                  website_confidence, website_found_at, email, email_source, email_found_at,
                  email_verify_status, email_verified_at, phone, phone_source, phone_found_at,
                  status, attempt_count, last_attempted_at, next_recheck_at, last_error)
               VALUES (%(lead_id)s, %(org_id)s, %(is_virtual_or_agent_address)s, %(website_found)s, %(website_url)s,
                       %(website_source)s, %(website_confidence)s, %(website_found_at)s, %(email)s, %(email_source)s,
                       %(email_found_at)s, %(email_verify_status)s, %(email_verified_at)s, %(phone)s, %(phone_source)s,
                       %(phone_found_at)s, %(status)s, %(attempt_count)s, now(), %(next_recheck_at)s, %(last_error)s)
               ON CONFLICT (lead_id) DO UPDATE SET
                 is_virtual_or_agent_address = EXCLUDED.is_virtual_or_agent_address,
                 website_found = EXCLUDED.website_found, website_url = EXCLUDED.website_url,
                 website_source = EXCLUDED.website_source, website_confidence = EXCLUDED.website_confidence,
                 website_found_at = EXCLUDED.website_found_at, email = EXCLUDED.email,
                 email_source = EXCLUDED.email_source, email_found_at = EXCLUDED.email_found_at,
                 email_verify_status = EXCLUDED.email_verify_status, email_verified_at = EXCLUDED.email_verified_at,
                 phone = EXCLUDED.phone, phone_source = EXCLUDED.phone_source, phone_found_at = EXCLUDED.phone_found_at,
                 status = EXCLUDED.status, attempt_count = EXCLUDED.attempt_count,
                 last_attempted_at = now(), next_recheck_at = EXCLUDED.next_recheck_at,
                 last_error = EXCLUDED.last_error, updated_at = now()""",
            {
                "lead_id": lead_id, "org_id": org_id, "attempt_count": attempt_count,
                "next_recheck_at": next_recheck_at,
                **{k: v for k, v in result.items() if not k.startswith("_")},
            },
        )


async def run_enrichment(conn, org_id: str, max_leads: int) -> dict:
    leads = get_leads_to_enrich(conn, org_id, max_leads)
    provider_key = get_usable_provider_key(conn, org_id)
    brave_disabled_this_run = provider_key is None

    counts = {
        "leads_processed": 0, "website_domain_guess": 0, "website_search_transient": 0,
        "no_website": 0, "email_found": 0, "email_valid": 0, "email_risky": 0, "email_unknown": 0,
        "email_found_unverified": 0, "phone_found": 0, "virtual_or_agent_address": 0,
        "status_enriched": 0, "status_partial": 0, "status_no_website": 0,
    }
    rows_for_report: list[dict] = []
    started = datetime.now(timezone.utc)

    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, verify=True) as client:
        for lead in leads:
            lead_started = datetime.now(timezone.utc)
            use_key = None if brave_disabled_this_run else provider_key
            result = await enrich_one(client, lead, use_key)

            if result["_brave_outcome"] is not None:
                record_brave_usage(conn, org_id, result["_brave_outcome"])
                if result["_brave_outcome"] in ("invalid", "quota_exceeded"):
                    brave_disabled_this_run = True  # never retry Brave again this run

            save_enrichment(conn, org_id, lead["lead_id"], lead["attempt_count"], result)

            counts["leads_processed"] += 1
            if result["website_source"] == "domain_guess":
                counts["website_domain_guess"] += 1
            elif result["website_source"] == "search_transient":
                counts["website_search_transient"] += 1
            else:
                counts["no_website"] += 1
            if result["email"]:
                counts["email_found"] += 1
                if result["email_verify_status"] == "found_unverified":
                    counts["email_found_unverified"] += 1
                elif result["email_verify_status"] in ("valid", "risky", "unknown"):
                    counts[f"email_{result['email_verify_status']}"] += 1
            if result["phone"]:
                counts["phone_found"] += 1
            if result["is_virtual_or_agent_address"]:
                counts["virtual_or_agent_address"] += 1
            counts[f"status_{result['status']}"] += 1

            elapsed_ms = (datetime.now(timezone.utc) - lead_started).total_seconds() * 1000
            rows_for_report.append({
                "source_id": lead["source_id"],
                "business_name": lead["raw"].get("corp_name") or lead["raw"].get("name"),
                "website_source": result["website_source"],
                "website_url": result["website_url"],
                "email": result["email"], "email_source": result["email_source"],
                "email_verify_status": result["email_verify_status"],
                "phone": result["phone"], "phone_source": result["phone_source"],
                "is_virtual_or_agent_address": result["is_virtual_or_agent_address"],
                "status": result["status"], "last_error": result["last_error"],
                "elapsed_ms": round(elapsed_ms),
            })
            log.info("enrich lead=%s status=%s website=%s elapsed_ms=%.0f",
                      lead["source_id"], result["status"], result["website_source"], elapsed_ms)

    total_elapsed_s = (datetime.now(timezone.utc) - started).total_seconds()
    return {
        "org_id": org_id, "counts": counts, "rows": rows_for_report,
        "total_elapsed_s": round(total_elapsed_s, 1),
        "avg_elapsed_s_per_lead": round(total_elapsed_s / len(leads), 2) if leads else 0,
    }


def run_enrichment_job(conn, job: dict) -> dict:
    payload = job["payload"] or {}
    org_id = payload.get("org_id")
    if not org_id:
        raise ValueError("payload.org_id is required for leadsource.enrich")
    max_leads = int(payload.get("max_leads", 50))
    return asyncio.run(run_enrichment(conn, str(org_id), max_leads))
