# Venturelyx — ScaleSEO "Definition of Done" (70% → sellable)

ScaleSEO is already real and polished — crawler, SEO health score + sub-scores,
issue grouping, page analysis, Priority Actions, Local Rankings, Reviews. "Done"
is three things: draw the v1 line (ships vs "coming soon"), make every action
honest, and handle the empty state for a brand-new site. Additive — preserve the
look, don't break the crawler/scoring/rankings pipeline. Org-scoped via RLS.
Don't touch /opt/outreach.

## 1. Draw the v1 line
SHIPS (already built — polish only): SEO Health score + sub-scores (Technical,
Content, Local SEO, Performance), crawler, issue grouping, page analysis,
Priority Actions, Local Rankings, Reviews.

COMING SOON — confirm which actually FUNCTION; anything half-built gets a clean
locked "coming soon" state, never a broken panel:
- Google Business management
- AI visibility / AI-search presence
- Content generation ("Generate Page" / AI recommendation)
If it genuinely works end to end, ship it; if not, lock it.

## 2. Make every action honest
Each "Fix this for me" button and the "Generate Page" AI card must do one real
thing — never a dead button: (a) a real auto-fix, (b) a guided how-to, or
(c) if it can't act yet, label it plainly ("How to fix" / "Mark as done"), not
"Fix this for me". Confirm the AI "Generate Page" produces a real draft; if not,
make it "coming soon."

## 3. Empty / in-progress states
A newly added site with no crawl yet shows "Crawl queued / running…" or "Add your
site to see its health" — never zeros, NaN, or a blank gauge. No rankings yet / no
reviews yet get clean empty states, not empty widgets.

## 4. Consistency + module-aware
Follows the shared frame and components (score gauge, stat rows, severity chips,
teal "Fix this for me" pill), matching Command Center and Operate. Sub-features the
client's plan doesn't include are hidden/locked, not empty.

## Explicitly OUT of v1
AI visibility, content generation, Google Business management (unless already
working), deep historical-trend views. Mark "coming soon."

## Definition of Done (acceptance)
- A brand-new site added → coherent "crawling…" state, no broken panels, no zeros.
- A crawled site → real scores, grouped issues, rankings; every action acts or
  honestly guides, no dead buttons.
- Google Business / AI visibility / content are either genuinely working or a clean
  "coming soon" — never half-rendered.
- Matches the shared design, light and dark, down to phone width.
