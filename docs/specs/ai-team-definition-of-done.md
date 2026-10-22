# Venturelyx — AI Team "Definition of Done"

Finalize the AI Team into one clean assistant per module. Three agents are live
and real (Growth Strategist, Content Writer, Reputation Assistant) — keep them.
Connect the two whose module already exists, add two for the modules that have no
agent, and keep Business Planner honest as "coming soon" until Build exists.

General rules: ADDITIVE — don't break the three live agents or the framework.
Org-scoped via RLS, confirm real table/column names first, match the existing AI
Team card design, don't touch /opt/outreach.

## Final agent roster (one per module)
KEEP — already live, don't change:
- Growth Strategist (Command Center) — next-best-action from open opps/signals
- Content Writer (ScaleSEO) — drafts service/location/blog/landing pages
- Reputation Assistant (Reviews) — drafts review replies in the client's voice

CONNECT — module exists, wire the agent for real:
- SEO Assistant (ScaleSEO): reads crawl results (seo_issues, seo_pages,
  seo_scores) and turns technical/content/local issues into a RANKED to-do list
  with severity. Replace the ScaleSEO "AI Recommendation" card's current reuse of
  the Growth Strategist with this dedicated agent.
- Insights Analyst (Command Center): explains why a metric moved, in plain
  English, on the card it sits on — compares current vs prior period and names the
  driver (e.g. "revenue +12% — three invoices cleared").

ADD — these modules have no agent yet:
- Outreach Writer (Grow): drafts and improves cold-email sequences, subject lines,
  and follow-ups; applies merge fields; flags deliverability red-flags. Drafts
  only — feeds the human-reviewed sequence, NEVER auto-sends.
- Follow-up Assistant (Operate): drafts lead follow-ups and overdue-invoice
  reminders in the client's voice from CRM/invoice data. Drafts only — NEVER
  auto-sends or auto-charges.

COMING SOON — leave not-connected:
- Business Planner (Build) — Build module doesn't exist yet. Keep the honest
  "coming soon" state.

## Shared framework (every agent)
1. MODEL PICKER per agent: the real models available via the configured API keys,
   plus "Auto". Persist each selection. Don't show models you can't call.
2. USAGE + COST per agent per month — extend to all agents, new ones included.
3. COST CAP: per-agent and per-org monthly spend cap. When hit, the agent pauses
   with a clear message instead of running up cost silently.
4. GUARDRAILS: agents DRAFT and RECOMMEND. No agent takes an irreversible outward
   action (sending email, charging, posting) without explicit human confirmation.
5. HONEST STATE per agent, driven by organizations.modules:
   - Active: module enabled + agent wired.
   - Coming soon: the module doesn't exist yet (Business Planner).
   - Locked: the client's plan doesn't include that module — show locked, not empty.

## Design
New and connected agents use the existing AI Team card exactly: icon, name, module
tag, state, description, usage/cost row, "Open in <module>" link, model picker.

## Definition of Done (acceptance)
- The three live agents are unchanged and still working.
- SEO Assistant and Insights Analyst are connected and produce real output; the
  ScaleSEO AI card now uses the SEO Assistant, not the Growth Strategist.
- Outreach Writer (Grow) and Follow-up Assistant (Operate) are added, draft from
  real module data, and never send/charge without a human confirm.
- Business Planner stays a clean "coming soon."
- Every agent has: model picker + Auto, usage/cost, a monthly cost cap,
  module-aware state, and human-confirm on any outward action.
- Matches the existing AI Team design, light and dark, down to phone width.
