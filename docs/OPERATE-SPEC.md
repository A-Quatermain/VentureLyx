# Operate — build specification

_The first module built to full depth. Everything else follows this pattern._

Operate is where the money is. Until it works, the Command Center has nothing
to summarise: revenue reads `$0`, the schedule is empty, and "revenue by
channel" — the claim that distinguishes this platform from six separate tools —
means nothing.

Build it completely before starting another module.

---

## Ground rules

**Tenancy is the database's job.** Every query runs through `req.db()`, which
opens a transaction with `app.current_org` set. No route may add an `org_id`
filter. If a query needs one, the route is wrong.

**Write endpoints need `requireRole`.** Reading is `viewer`. Creating and
editing is `staff`. Deleting, voiding, and anything touching money at rest is
`manager`. Changing prices or writing off invoices is `admin`.

**Soft-delete parties, hard-delete lines.** `parties.deleted_at` exists because
a customer with invoice history cannot vanish. Line items on a draft invoice can
be removed outright.

**Money is `numeric(12,2)` and arrives as a string.** Never parse it into a JS
number for arithmetic — `pg` returns numerics as strings deliberately. Total on
the server, in SQL, in one place.

**Every mutation writes a `timeline_events` row.** That table is what makes a
customer record tell a story rather than show a form. It is also what the AI
Team will read later.

---

## 1. Customers (CRM)

`parties` with `is_customer` or `is_lead`. One table, role flags, because a
lead who buys becomes a customer without changing identity — and their
attribution history survives the transition.

### Endpoints

```
GET    /v1/operate/parties?q=&role=&lifecycle=&page=&sort=
GET    /v1/operate/parties/:id
POST   /v1/operate/parties
PATCH  /v1/operate/parties/:id
DELETE /v1/operate/parties/:id          soft delete, manager
POST   /v1/operate/parties/:id/contacts
PATCH  /v1/operate/parties/contacts/:id
DELETE /v1/operate/parties/contacts/:id
POST   /v1/operate/parties/import       CSV, returns a dry-run preview
POST   /v1/operate/parties/import/commit
GET    /v1/operate/parties/:id/timeline
```

`GET /parties` returns, per row: id, display_name, lifecycle, city, primary
phone, primary email, lifetime value, open invoice total, last activity, and
first-touch channel. Those last three are what make the list useful — a name
and a phone number is a contact list, not a CRM.

`q` searches `display_name` (there is a trigram index), company_name, and
contact values. Paginate at 50.

### CSV import

The single highest-value feature in this module. Every prospective client has
customers in a spreadsheet, and typing them in by hand is why they will not
adopt the platform.

Two-step, always: upload returns a **preview** — detected columns mapped to
fields, first 10 rows as they would be created, a count of rows that would be
skipped and why. The person confirms, then `/commit` writes.

Accept messy input. Header names vary wildly ("Customer Name", "Client",
"NAME"); match case-insensitively on a synonym list. A row with a name and
nothing else is valid. Duplicate detection is by primary email or phone within
the org — flag them in the preview, let the person choose skip or merge.

### Screens

**List** — search field, filter chips (All / Leads / Customers / Dormant),
sortable table. Row: name and company stacked, city, phone, lifetime value
right-aligned in mono, lifecycle chip. Empty state explains CSV import with a
button, not just "No customers".

**Detail** — the record that tells a story:
- Header: name, lifecycle chip, quick actions (call, email, new job, new invoice)
- Left: contact points, address, tags, owner, notes
- Right: **timeline** — every job, invoice, payment, note, status change in
  reverse chronological order with icons
- Money strip: lifetime value, open balance, last payment, average job value
- Attribution: "First found you through Google search, 14 March"

**Add / edit** — a drawer, not a page. Name is the only required field.
Everything else optional, because a real intake is a phone call with a name and
a number, and a form that demands more will be abandoned.

---

## 2. Scheduling and Jobs

`work_orders` plus `work_order_lines`.

### Endpoints

```
GET    /v1/operate/jobs?from=&to=&status=&assigned=&party=
GET    /v1/operate/jobs/:id
POST   /v1/operate/jobs
PATCH  /v1/operate/jobs/:id
POST   /v1/operate/jobs/:id/status       scheduled|dispatched|in_progress|complete|cancelled
POST   /v1/operate/jobs/:id/lines
PATCH  /v1/operate/jobs/lines/:id
DELETE /v1/operate/jobs/lines/:id
POST   /v1/operate/jobs/:id/invoice      create an invoice from this job
GET    /v1/operate/schedule?date=        one day, grouped by assignee
```

`recurrence` is `jsonb`. Support the shapes a service business actually uses:
weekly on a given day, every N weeks, monthly on a date. Generate the next
occurrence when a job is completed — do not pre-create a year of rows.

### Screens

**Schedule** — the default Operate view. Week strip at top, day list below.
Each entry: time, customer, service, address, assignee, value. Tap to open.
Mobile-first: this is read in a truck.

**Job detail** — customer link, address with a map link, scheduled window,
assignee, line items with quantities and prices, running total, status
control, notes, photos. One prominent button: **Create invoice**.

**New job** — customer (search existing or create inline), service from
catalog, date and time, assignee, address defaulting to the customer's.

---

## 3. Invoices and Payments

### Endpoints

```
GET    /v1/operate/invoices?status=&party=&overdue=
GET    /v1/operate/invoices/:id
POST   /v1/operate/invoices
PATCH  /v1/operate/invoices/:id          draft only
POST   /v1/operate/invoices/:id/lines
PATCH  /v1/operate/invoices/lines/:id
DELETE /v1/operate/invoices/lines/:id
POST   /v1/operate/invoices/:id/send     draft -> sent, stamps issued_on
POST   /v1/operate/invoices/:id/void     manager
POST   /v1/operate/invoices/:id/payments record a payment
GET    /v1/operate/payments?from=&to=
POST   /v1/operate/payments
GET    /v1/operate/invoices/:id/pdf
```

**Totals are computed server-side in SQL, never trusted from the client.**
`subtotal` = sum of line quantity × unit_price; `tax` applies to taxable lines
at the org's rate; `total` = subtotal + tax. Recompute on every line change.

Status transitions are rules, not free text: `draft → sent → partial → paid`,
with `void` reachable from any state and `overdue` derived from `due_on <
current_date AND status IN ('sent','partial')` rather than stored.

Recording a payment updates `amount_paid`, and sets status to `paid` when
`amount_paid >= total`, `partial` otherwise. A payment against a `draft`
invoice is an error.

Invoice numbering: `INV-0001` per org, sequential, gapless. Allocate inside the
insert transaction — `SELECT max(...) + 1` outside a transaction races.

### Screens

**Invoice list** — status tabs (All / Draft / Sent / Overdue / Paid). Row:
number, customer, issued date, due date, total, amount due, status chip.
Overdue rows carry the alert colour. Header strip: total outstanding, overdue
count, collected this month.

**Invoice detail / editor** — editable line table while draft, read-only after
sending. Line: description, quantity, unit price, total. Add-line row with a
catalog picker. Totals block bottom-right. Actions by status: draft gets Send;
sent gets Record payment and Void; paid gets Download PDF.

**Record payment** — modal: amount (defaulting to the balance), method, date,
reference.

---

## 4. Vendors and Expenses

`parties` with `is_vendor`, plus `expenses`.

```
GET    /v1/operate/vendors
POST   /v1/operate/vendors
GET    /v1/operate/vendors/:id
PATCH  /v1/operate/vendors/:id
GET    /v1/operate/expenses?from=&to=&category=&vendor=
POST   /v1/operate/expenses
PATCH  /v1/operate/expenses/:id
DELETE /v1/operate/expenses/:id
```

Vendors reuse the party detail screen with a different tab set — spend to date,
expense history, documents. Expenses: date, vendor, category, amount, notes,
optional receipt file.

---

## 5. Documents

`documents` + `files`, MinIO for storage.

```
GET    /v1/operate/documents?party=&kind=
POST   /v1/operate/documents           multipart
GET    /v1/operate/documents/:id       signed URL, 15-minute expiry
DELETE /v1/operate/documents/:id
```

Attachable to a party, job, or invoice. Never serve bytes through the API —
issue a presigned MinIO URL.

---

## 6. Catalog

What the business sells. Feeds job lines, invoice lines, and later the SEO
opportunity matrix.

```
GET    /v1/operate/catalog
POST   /v1/operate/catalog
PATCH  /v1/operate/catalog/:id
DELETE /v1/operate/catalog/:id
```

Item: name, kind (service/product/package/fee), description, unit price, unit,
taxable, active. A simple list screen with inline editing is enough.

---

## 7. What this unlocks in Command Center

Once Operate holds real data, these stop being empty and no new tables are
needed:

**Revenue this month** — `sum(payments.amount)` for the current month, with the
previous month for comparison.

**Revenue by channel** — payments joined to parties joined to
`attribution_touches` via `first_touch_id`. This is the claim no single-purpose
tool can make: *"$10,970 of this month's revenue came from customers who found
you on Google."*

**Today's jobs, money owed, new leads** — direct queries against work_orders,
invoices, parties.

**Signals that matter more than SEO warnings** — an invoice 30 days overdue, a
lead with no contact in 5 days, a customer whose recurring service lapsed.
Write these into `signals` from a scheduled job so they rank alongside the
crawler's findings in one list.

---

## Build order

Each step ends with something that works end to end. Do not start the next
until the current one is usable in a browser.

1. **Catalog** — smallest surface, proves the CRUD pattern
2. **Customers** — list, detail, add, edit, timeline
3. **CSV import** — preview then commit
4. **Jobs and schedule** — including recurrence
5. **Invoices** — editor, totals, send, PDF
6. **Payments** — recording, status transitions
7. **Vendors and expenses**
8. **Documents**
9. **Command Center rewiring** — revenue, channels, signals against real data

---

## Definition of done

A person can sign in, import 200 customers from a spreadsheet, schedule a job
for tomorrow, complete it, invoice it, record the payment, and see that money
appear in the Command Center revenue figure attributed to the channel the
customer originally came from.

Until that entire path works in a browser, Operate is not finished.
