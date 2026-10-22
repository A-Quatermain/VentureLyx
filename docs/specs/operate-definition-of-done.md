# Venturelyx — Operate "Definition of Done" (60% → sellable)

Operate's core is built — CRM/leads, jobs/work orders, invoices, and payments are
live and already feed the Command Center and the Growth Score. "Done" here is:
draw the v1 line, make the daily workflow run end-to-end with no dead ends, and
handle the empty state for a brand-new client. Additive — preserve what works.

General rules: additive, don't break the CRM/jobs/invoices/payments pipeline,
confirm real table/column names first, org-scoped via RLS, match the shared design
language, don't touch /opt/outreach.

## 1. Draw the v1 line — ships vs "coming soon"
SHIPS in v1 (already built — polish + close gaps):
- CRM: leads/parties — add, edit, convert, log activity
- Jobs / work orders — create, schedule, update status
- Invoices — create, send, mark paid / record payment, overdue tracking
- Payments — record, tie to invoice

ACCOUNTING for v1 = EXPORT, not integration:
- A CSV/QuickBooks-compatible export of invoices and payments. Full accounting API
  integration is "coming soon."

COMING SOON (locked, not half-built):
- Vendor database
- Documents
- Full accounting API integration (QuickBooks/Xero sync)

## 2. Daily workflow runs end-to-end — no dead ends
- LEAD: add → edit → convert to customer → log an activity.
- JOB: create a work order → schedule → mark complete.
- INVOICE: create → send → record a payment / mark paid → leaves the overdue list.
Anything that can't complete yet is either finished or clearly labeled, never a
dead control.

## 3. Empty / first-run states
A brand-new client with no leads, jobs, or invoices sees designed empty states —
"No leads yet — add your first," "No jobs scheduled," "No invoices yet" — never raw
zeros, NaN, or broken tables. Money views handle "nothing outstanding" and "no
payments yet" cleanly.

## 4. Consistency + module-aware
- Follows the shared frame and components (stat rows, severity chips, the teal
  "Fix this for me" pill), matching Command Center and ScaleSEO.
- Sub-features the client's plan doesn't include are hidden/locked, not empty.
- Keep Operate's data feeding the Command Center tiles and the Growth Score "Sales"
  dimension correctly.

## Explicitly OUT of v1 (don't gold-plate)
Vendor database, documents, full accounting API sync, recurring invoices, and
multi-currency. Mark them "coming soon."

## Definition of Done (acceptance)
- A brand-new client sees clean empty states across CRM, jobs, invoices, and money.
- The full lead → customer → job → invoice → payment path completes from the UI with
  no dead ends.
- Accounting export produces a valid QuickBooks-compatible CSV of invoices/payments.
- Vendor DB, documents, and accounting sync are clean "coming soon."
- Operate's numbers still flow correctly into Command Center and the Growth Score.
- Matches the shared design, light and dark, down to phone width.

## Onboarding / Data import (added scope)
A new client must be able to bring their existing data in and start day one with real
numbers, not $0. Two additive pieces, specced separately:
- Import existing invoices -> docs/specs/operate-invoice-import.md
- Unified "Import your data" (customers, invoices, open jobs) ->
  docs/specs/operate-data-migration.md
Both reuse one shared CSV import framework (mapping, preview, dedupe, error report)
and must flow correctly into Command Center and the Growth Score.
