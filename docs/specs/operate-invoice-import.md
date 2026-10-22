# Venturelyx — Operate: Import Existing Invoices (onboarding/migration)

Additive to Operate. Lets a new client bring their current-year invoices (and the
customers on them) in, so the system reflects their real business from day one —
Command Center, revenue, outstanding, and Growth Score are meaningful immediately
instead of showing $0.

Rules: additive, don't break the Operate write path, confirm real table/column
names first, org-scoped via RLS, don't touch /opt/outreach. Reuse the Grow
contact-import pattern (tolerant parsing, column mapping, preview-before-commit).

## Flow
- "Import invoices" action on the Operate Invoices page, surfaced in onboarding too.
- CSV upload -> column mapping -> preview -> commit.

## Columns accepted (tolerant / mapped)
customer_name, customer_email, invoice_number, issue_date, due_date,
description/line items, total, amount_paid, paid_date, status.

## Per row
- Upsert the CUSTOMER (party) by email, else name — link if exists, create if not.
  Customers come in automatically with their invoices.
- Create the INVOICE with number, issue/due dates, total, amount_paid.
- Derive status:
  - paid (amount_paid >= total) -> mark paid; record a payment dated to paid_date if given
  - partial
  - sent
  - overdue (due_date < today and unpaid)
  So outstanding invoices land in the money/overdue views; paid ones form revenue history.

## Integrity
- Dedupe on invoice_number per org — re-import is idempotent.
- Before commit, show: "X invoices, Y customers (N new, M linked), $Z total,
  $W outstanding", with a downloadable list of bad rows. Commit only on confirm.

## Flows into
Command Center (revenue, outstanding) and the Growth Score (populating prior months
so revenue_trend is meaningful).

## Acceptance
Upload a current-year invoice CSV on a fresh org -> customers created/linked,
invoices created with correct status, paid ones show as revenue, outstanding ones in
overdue, Command Center reflects it immediately, re-import doesn't duplicate.
