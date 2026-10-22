# Venturelyx — Operate: Import Your Existing Data (unified onboarding/migration)

Additive. A guided flow so a new client brings their whole business in at once and
starts day one with real data across Operate + Command Center. Builds ON TOP of the
invoice import (reuse its CSV mapping / preview / dedupe / error-report framework —
do not duplicate it).

Rules: additive, confirm real table/column names first, org-scoped via RLS, don't
touch /opt/outreach.

## Flow
A guided "Import your data" step in onboarding, reachable later from Operate/Settings.
One importer per entity type, all sharing the invoice-import framework: CSV upload,
column mapping, preview-before-commit, dedupe, downloadable errors.

## Entity importers
- CUSTOMERS (parties): name, email, phone, company, address, lifecycle. Upsert by
  email, else name. Standalone, not only via invoices.
- INVOICES: as built (see operate-invoice-import.md). Kept under this flow.
- OPEN JOBS / work orders: title, customer (link by email/name), status, scheduled
  date, notes. Link to the customer; create the customer if missing.
- (Optional) a simple service/product catalog for invoice line items.

## Order + linking
Customers first so invoices and jobs can link to them; when an invoice/job references
a customer not yet imported, upsert that customer on the fly. Dedupe each entity on
its natural key (email for customers, invoice_number for invoices).

## Onboarding checklist
Add "Import customers", "Import invoices", "Import jobs" steps, each showing done /
skip — a client can import some and not others.

## Flows into
Command Center and the Growth Score correctly (customers, revenue, outstanding,
active jobs).

## Acceptance
On a fresh org: import customers, then invoices, then open jobs from CSVs -> all
linked correctly, correct statuses, Command Center + Growth Score reflect a real
operating business immediately. All imports idempotent.

## Sequencing note
Hand this to Claude Code AFTER the invoice import is committed, so it extends that
shared framework rather than building a second parallel importer.
