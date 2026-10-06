"""
Venturelyx :: scoring and signal emission.

Turns crawl output into (a) issues, (b) a health score, (c) signals feeding the
shared intelligence layer.

(c) is the part that distinguishes this from an SEO tool. A deindexed page and
an overdue invoice both become signals, so the Command Center's "worth doing"
list is one ranked queue across the whole business rather than a per-module tab.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from urllib.parse import urlparse

from crawler import CrawlOutput, PageResult

# code -> (severity, weight, auto_fixable, human summary template)
RULES = {
    "broken_internal_link":  ("critical", 6, False, "Broken link on your site"),
    "page_error":            ("critical", 8, False, "Page failed to load"),
    "server_error":          ("critical", 8, False, "Page returned a server error"),
    "noindex_page":          ("high",     5, False, "Page is hidden from Google"),
    "missing_title":         ("high",     5, True,  "Page has no title"),
    "missing_h1":            ("high",     3, False, "Page has no main heading"),
    "duplicate_title":       ("high",     4, False, "Two pages share the same title"),
    "missing_meta_desc":     ("medium",   2, True,  "Page has no description for Google"),
    "duplicate_meta_desc":   ("medium",   2, True,  "Two pages share the same description"),
    "title_too_long":        ("medium",   1, True,  "Title is cut off in search results"),
    "title_too_short":       ("medium",   1, True,  "Title is too short to rank well"),
    "meta_desc_too_long":    ("low",      1, True,  "Description is cut off in search results"),
    "multiple_h1":           ("medium",   2, False, "Page has more than one main heading"),
    "images_missing_alt":    ("medium",   2, True,  "Images have no description text"),
    "thin_content":          ("medium",   3, False, "Page has very little text"),
    "duplicate_content":     ("high",     4, False, "Two pages have identical content"),
    "redirect_chain":        ("medium",   2, False, "Link passes through several redirects"),
    "slow_page":             ("medium",   2, False, "Page is slow to load"),
    "missing_canonical":     ("low",      1, True,  "Page does not state its preferred URL"),
    "broken_external_link":  ("low",      1, False, "Link to another site is dead"),
    "no_schema":             ("low",      1, True,  "Page has no structured data for Google"),
    # AI/local visibility — site-wide checks (detect_visibility_issues),
    # not per-page like everything above. Weight is irrelevant for these
    # (compute_ai_visibility scores this family separately from
    # health/technical/content/performance), kept at 0 so a weight sum
    # elsewhere never silently double-counts them.
    "missing_local_business_schema": ("high",   0, True,  "No LocalBusiness listing for search engines or AI to read"),
    "incomplete_local_business_schema": ("medium", 0, True, "LocalBusiness listing is missing key details"),
    "missing_faq_schema":    ("low",      0, True,  "No FAQ structured data"),
    "inconsistent_phone_number": ("high", 0, False, "Different phone numbers appear on different pages"),
    "weak_qa_structure":     ("medium",   0, True,  "Pages don't read as direct answers to real questions"),
}


@dataclass
class Issue:
    code: str
    severity: str
    url: str | None
    detail: str
    auto_fixable: bool


def detect_issues(out: CrawlOutput, site_url: str) -> list[Issue]:
    issues: list[Issue] = []

    def add(code: str, url: str | None, detail: str):
        sev, _w, fixable, _s = RULES[code]
        issues.append(Issue(code, sev, url, detail, fixable))

    html_pages = [p for p in out.pages if p.content_hash or p.error or p.status_code]

    titles = Counter(p.title for p in html_pages if p.title)
    metas = Counter(p.meta_description for p in html_pages if p.meta_description)
    hashes = Counter(p.content_hash for p in html_pages if p.content_hash and p.word_count > 100)

    for p in html_pages:
        if p.error:
            add("page_error", p.url, p.error)
            continue
        if p.status_code and p.status_code >= 500:
            add("server_error", p.url, f"HTTP {p.status_code}")
            continue
        # A page that returned nothing at all (timeout, DNS, refused) is a
        # hard failure. Previously these fell through the content_hash guard
        # and disappeared from the report entirely.
        if p.status_code is None:
            add("page_error", p.url, "no response (timeout or connection refused)")
            continue

        if p.status_code in (301, 302, 307, 308):
            add("redirect_chain", p.url, f"redirects to {p.redirect_to or 'elsewhere'}")
            continue

        if not p.content_hash:
            continue  # non-HTML

        # Content checks only apply to pages that actually served. A 404 page
        # has no meta description by design; flagging it is noise, and noise is
        # how an owner learns to ignore the whole report.
        if p.status_code != 200:
            continue

        if p.indexable is False:
            add("noindex_page", p.url, f"meta robots: {p.meta_robots}")

        if not p.title:
            add("missing_title", p.url, "No <title> element")
        else:
            n = len(p.title)
            if n > 60:
                add("title_too_long", p.url, f"{n} characters; Google shows about 60")
            elif n < 20:
                add("title_too_short", p.url, f"only {n} characters")
            if titles[p.title] > 1:
                add("duplicate_title", p.url, f"shared with {titles[p.title]-1} other page(s)")

        if not p.meta_description:
            add("missing_meta_desc", p.url, "No meta description")
        else:
            n = len(p.meta_description)
            if n > 160:
                add("meta_desc_too_long", p.url, f"{n} characters; Google shows about 160")
            if metas[p.meta_description] > 1:
                add("duplicate_meta_desc", p.url, f"shared with {metas[p.meta_description]-1} other page(s)")

        if p.h1_count == 0:
            add("missing_h1", p.url, "No <h1> heading")
        elif p.h1_count > 1:
            add("multiple_h1", p.url, f"{p.h1_count} h1 headings")

        if p.images_no_alt:
            add("images_missing_alt", p.url, f"{p.images_no_alt} of {p.images_total} images")

        if p.word_count < 150 and p.status_code == 200:
            add("thin_content", p.url, f"{p.word_count} words")

        if p.content_hash and hashes[p.content_hash] > 1:
            add("duplicate_content", p.url, f"identical to {hashes[p.content_hash]-1} other page(s)")

        if p.redirect_hops >= 2:
            add("redirect_chain", p.url, f"{p.redirect_hops} redirects to {p.redirect_to}")

        if p.response_ms and p.response_ms > 2500:
            add("slow_page", p.url, f"{p.response_ms} ms")

        if not p.canonical:
            add("missing_canonical", p.url, "No canonical link")

        if not p.schema_types:
            add("no_schema", p.url, "No JSON-LD structured data")

    # Report each broken target once, naming a page that links to it.
    broken_int: dict[str, str] = {}
    broken_ext: dict[str, str] = {}
    for l in out.links:
        if l.status_code is not None and l.status_code >= 400:
            (broken_int if l.is_internal else broken_ext).setdefault(l.to_url, l.from_url)
    for target, src in broken_int.items():
        add("broken_internal_link", src, f"links to {target}")
    for target, src in broken_ext.items():
        add("broken_external_link", src, f"links to {target}")

    return issues


# ---------------------------------------------------------------------------
# AI / local visibility — site-wide, not per-page
# ---------------------------------------------------------------------------
#
# Everything above is "is this one page broken." These four checks ask a
# different question: can a search engine or an AI model actually tell who
# this business is, where it is, and whether a given page answers something
# real. One issue per *problem* across the whole site, not one per page —
# "your LocalBusiness schema is missing" is one thing to fix no matter how
# many pages lack it.
QA_MIN_WORDS = 100          # skip near-empty pages (nav-only, redirects) — nothing to judge
QA_WEAK_THRESHOLD = 0.5     # share of eligible pages that must fail before this is "a problem"


def detect_visibility_issues(out: CrawlOutput) -> list[Issue]:
    issues: list[Issue] = []
    html_pages = [p for p in out.pages if p.content_hash and p.status_code == 200]
    if not html_pages:
        return issues

    homepage = next((p for p in html_pages if urlparse(p.url).path in ("", "/")), html_pages[0])

    has_local_business = any(p.has_local_business_schema for p in html_pages)
    local_business_complete = any(p.local_business_schema_complete for p in html_pages)
    if not has_local_business:
        issues.append(Issue(
            "missing_local_business_schema", "high", homepage.url,
            "No page has LocalBusiness (or a matching subtype) structured data", True,
        ))
    elif not local_business_complete:
        issues.append(Issue(
            "incomplete_local_business_schema", "medium", homepage.url,
            "LocalBusiness data is present but missing name, address, phone, or hours", True,
        ))

    if not any(p.has_faq_schema for p in html_pages):
        issues.append(Issue(
            "missing_faq_schema", "low", homepage.url, "No FAQPage structured data found anywhere on the site", True,
        ))

    all_phones: set[str] = set()
    for p in html_pages:
        all_phones.update(p.phone_numbers)
    if len(all_phones) > 1:
        issues.append(Issue(
            "inconsistent_phone_number", "high", homepage.url,
            f"{len(all_phones)} different phone numbers found across the site", False,
        ))

    qa_eligible = [p for p in html_pages if p.word_count >= QA_MIN_WORDS]
    if qa_eligible:
        weak = [p for p in qa_eligible if not (p.has_early_answer and p.question_subheadings > 0)]
        if len(weak) / len(qa_eligible) > QA_WEAK_THRESHOLD:
            issues.append(Issue(
                "weak_qa_structure", "medium", weak[0].url,
                f"{len(weak)} of {len(qa_eligible)} pages don't open with a direct answer or use "
                "question-style headings",
                True,
            ))

    return issues


def compute_ai_visibility(out: CrawlOutput, issues: list[Issue]) -> int:
    """0-100, purely from what this crawl actually found: structured-data
    presence and completeness (up to 40), whether the phone number is
    consistent across pages (20), and what share of substantial pages read
    as a direct answer to a real question rather than company description
    (up to 40). A real, deterministic computation from the crawl — not an
    estimate of traffic, rankings, or anything an AI model was actually
    asked (see the separate weekly ai_answer_checks job for that)."""
    html_pages = [p for p in out.pages if p.content_hash and p.status_code == 200]
    if not html_pages:
        return 0

    codes = {i.code for i in issues}
    if "missing_local_business_schema" in codes:
        schema_score = 0
    elif "incomplete_local_business_schema" in codes:
        schema_score = 25
    else:
        schema_score = 35
    if "missing_faq_schema" not in codes:
        schema_score += 5
    schema_score = min(40, schema_score)

    nap_score = 0 if "inconsistent_phone_number" in codes else 20

    qa_eligible = [p for p in html_pages if p.word_count >= QA_MIN_WORDS]
    if qa_eligible:
        strong = sum(1 for p in qa_eligible if p.has_early_answer and p.question_subheadings > 0)
        qa_score = round(40 * strong / len(qa_eligible))
    else:
        qa_score = 0

    return max(0, min(100, schema_score + nap_score + qa_score))


def compute_scores(out: CrawlOutput, issues: list[Issue]) -> dict:
    """Sub-scores start at 100 and lose weighted points per issue, normalised by
    page count so a 200-page site is not punished for scale."""
    pages = max(1, sum(1 for p in out.pages if p.content_hash))

    buckets = {
        "technical": {"page_error", "server_error", "noindex_page", "broken_internal_link",
                      "redirect_chain", "missing_canonical", "broken_external_link"},
        "content":   {"missing_title", "title_too_long", "title_too_short", "missing_meta_desc",
                      "duplicate_meta_desc", "meta_desc_too_long", "missing_h1", "multiple_h1",
                      "thin_content", "duplicate_content", "duplicate_title",
                      "images_missing_alt", "no_schema"},
        "performance": {"slow_page"},
    }

    scores: dict[str, int] = {}
    for name, codes in buckets.items():
        penalty = sum(RULES[i.code][1] for i in issues if i.code in codes)
        scores[name] = max(0, min(100, round(100 - (penalty / pages) * 8)))

    overall = round(scores["technical"] * 0.45 + scores["content"] * 0.40
                    + scores["performance"] * 0.15)

    sev = Counter(i.severity for i in issues)
    return {
        "health": max(0, min(100, overall)),
        "technical": scores["technical"],
        "content": scores["content"],
        "performance": scores["performance"],
        # Independent of health/technical/content/performance above (none of
        # the visibility issue codes carry a RULES weight) — a site can be
        # technically flawless and still invisible to an AI model, or vice
        # versa, and blending the two would hide that.
        "ai_visibility": compute_ai_visibility(out, issues),
        "pages": pages,
        "broken_links": sum(1 for i in issues if i.code == "broken_internal_link"),
        "critical_issues": sev["critical"],
        "high_issues": sev["high"],
    }


# ---------------------------------------------------------------------------
# Signals — the bridge into the shared intelligence layer
# ---------------------------------------------------------------------------

def signal_rows(issues: list[Issue], site_id: str, site_name: str) -> list[dict]:
    """One signal per issue CODE, not per URL. Twenty pages missing descriptions
    is one thing to do, not twenty items in the owner's list."""
    grouped: dict[str, list[Issue]] = {}
    for i in issues:
        if i.severity in ("critical", "high", "medium"):
            grouped.setdefault(i.code, []).append(i)

    sev_num = {"critical": 1, "high": 2, "medium": 3, "low": 4}
    rows = []
    for code, group in grouped.items():
        sev, _w, fixable, summary = RULES[code]
        n = len(group)
        rows.append({
            "module": "scaleseo",
            "signal_type": f"seo.{code}",
            "severity": sev_num[sev],
            "entity_type": "seo_site",
            "entity_id": site_id,
            "summary": summary if n == 1 else f"{summary} ({n} pages)",
            "detail": {
                "code": code,
                "count": n,
                "auto_fixable": fixable,
                "site": site_name,
                "examples": [{"url": g.url, "detail": g.detail} for g in group[:5]],
            },
            "dedupe_key": f"seo:{site_id}:{code}",
        })
    return rows
