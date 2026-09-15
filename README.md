# Supplier Portal

Standalone supplier portal — accreditation, purchase orders, price lists and
payables. Built to mirror the customer portal, with the flows reversed: there
the customer orders and we fulfil; here **we** issue the purchase order and the
**supplier** fulfils.

## The shared database, and the one thing to know about it

This portal is a **separate repo and a separate Vercel project**, but it
**shares its Supabase database** with the customer portal.

It does that safely by owning a dedicated Postgres schema:

| | |
|---|---|
| `public` | the **customer portal** — live customer accounts. Never written here. |
| `supplier` | **this portal** — all 25 tables, views and functions. |

This matters because both systems independently want tables called `users`,
`companies`, `applications`, `invoices`, `notifications` and `audit_log`, and
both seed roles with codes like `superadmin` and `viewer` into a
`UNIQUE`-constrained column. The customer portal's migrations are all
`CREATE TABLE IF NOT EXISTS`, so a collision would **not** fail loudly — it
would skip the create, leave the customer portal's table in place, and then run
this portal's `ALTER`s and seed `INSERT`s against real customer data.

Four things prevent that:

1. **Every object is `supplier.`-qualified.** Nothing is created in `public`.
2. **`scripts/migrate.mjs` refuses to run** any migration whose SQL would
   create, alter or write outside `supplier` — checked before a connection is
   even opened. Try it: add `CREATE TABLE users (...)` to a migration and it
   aborts, naming the problem.
3. **Its migration ledger is `supplier.schema_migrations`.** Sharing
   `public.schema_migrations` would make each app think the other's migrations
   had already been applied.
4. **`src/lib/db.ts` pins `search_path=supplier`** on every connection, with
   `public` *off* the path — so an unqualified name in application code cannot
   silently fall through to a customer-portal table.

`npm run db:test` reports the table count in both schemas and **refuses to
proceed if it detects the ERP's tables** (`journal_entries`, `gl_accounts`,
`dp_sizes`). The ERP is the dangerous mix-up: its `public` schema is also
populated, and the project refs are opaque.

> **Never point this at the ERP project.** See the table in `.env.example`.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run gen:secrets            # JWT secrets — use DIFFERENT ones from the customer portal
npm run db:test                # confirms the project before anything is written
npm run db:migrate             # creates the `supplier` schema
npm run db:seed                # company, superadmin, accreditation form v1
npm run dev -- -p 3001         # 3001 so it can run alongside the customer portal
```

## The accreditation form is data, not code

The form is a JSON schema in `supplier.form_versions.schema`, seeded from
`db/seeds/supplier_accreditation_form.json`. The UI renders whatever it finds
there.

**The seeded form is a placeholder** modelled on what a Philippine poultry
buyer normally asks for. Replacing it with the real one is a seed edit plus
`npm run db:seed` — never a component rewrite. Re-seeding publishes a **new
version** and retires the old one; applications already in flight keep
rendering and validating against the version they started on.

Fields carry an optional `mapsTo` (e.g. `suppliers.legal_name`) that copies the
answer onto the supplier record on approval. Only columns on the allow-list in
`src/lib/forms.ts` can be written, so a hand-edited schema can never set
`payment_terms_days`, `ewt_rate` or `status`.

## What it does

**Accreditation** — register, verify email, fill the versioned form, upload
documents, capture a premises photo, e-sign a declaration, optionally print for
notarisation. Staff review, request more information, approve or reject. On
approval the supplier record is created, a vendor code (`AFCC-S-000123`) is
issued, and the applicant's login is linked — all in one transaction, because a
partial apply would leave someone accredited but unable to sign in.

**Purchase orders** — staff issue them; the supplier acknowledges with the
delivery date they can actually meet, or declines with a reason. That
acknowledgement is the point of the portal: today a PO is emailed as a PDF and
nobody knows whether it was seen.

**Price lists** — the supplier proposes prices per item; staff approve. Only an
approved price can price a PO line, and the line records *which* price row it
came from, so "why did we pay that?" has an answer months later.

**Payables** — the supplier submits an invoice, which is **three-way matched**
against the PO and the goods actually received at submission time. A mismatch
is recorded and shown to the supplier immediately, not rejected — our own
receiving records can be the thing that's wrong. Statements show ageing buckets
and confirmed payments net of withholding tax.

## Differences from the customer portal worth knowing

| Customer portal | Here |
|---|---|
| `credit_limit` — what they may owe us | `payment_terms_days`, `ewt_rate` — what we owe them, net of withholding |
| Customer places the order | **We** issue the PO; supplier acknowledges |
| We raise the invoice | **Supplier** submits it; we match it before it's payable |
| No expiry on an account | `accreditation_expires_at` — permits lapse, and an expired accreditation blocks **new** POs while leaving history and payment chasing intact |
| 7-stage delivery tracking | `Draft → Issued → Acknowledged → In Transit → Partially Received → Received → Closed` |

`requireSupplier` is the tenant boundary and re-reads `supplier_id` from the
database rather than trusting the JWT, so suspending a supplier takes effect on
the next request. `requireAccredited` is the stricter guard used for actions
that create new commitments.

## Scripts

| | |
|---|---|
| `npm run db:test` | verify the connection and which project it is |
| `npm run db:migrate` | apply pending migrations (`--status` to list) |
| `npm run db:seed` | company, superadmin, publish the form |
| `npm run gen:secrets` | generate JWT secrets |
| `npm run mail:test` | send a test email through the configured driver |
| `node scripts/set-admin-login.mjs` | change an admin login in place, keeping the user id |

## Deploying to Vercel

`.env.local` is gitignored, so **nothing in it reaches production**. Every
variable has to be set again in Vercel → Settings → Environment Variables.

The branding ones are easy to miss, because leaving them out is not an error —
the page just quietly falls back to a plain light layout with a text wordmark
instead of the logo. That fallback is deliberate (a missing file should never
render a broken image), which is exactly why the omission is silent:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_HERO_VIDEO` | `/hero.mp4` |
| `NEXT_PUBLIC_HERO_POSTER` | `/hero-poster.jpg` |
| `NEXT_PUBLIC_HAS_LOGO` | `true` |
| `NEXT_PUBLIC_LOGO_URL` | `/logo.png` |
| `NEXT_PUBLIC_APP_NAME` | `Art Fresh` |
| `NEXT_PUBLIC_APP_URL` | the deployment's own URL |

Plus `POSTGRES_URL`, `DATABASE_URL`, `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` — the JWT secrets **different** from the customer
portal's, or a token minted by one portal is accepted by the other.

**Adding variables does not trigger a rebuild, and `NEXT_PUBLIC_*` values are
compiled into the bundle at build time.** So after setting them: Deployments →
⋯ on the latest → Redeploy, with **"Use existing Build Cache" unticked**.
Without that step the old values stay baked in and nothing appears to change.

## Before this is used for real

1. **Set `UPLOAD_DRIVER=supabase`** with a `supplier-docs` bucket plus
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Uploads deliberately return
   503 on Vercel under the local driver, because a serverless filesystem would
   lose documents while reporting success.
2. **Configure `RESEND_API_KEY`.** Without it the mail driver is `log`:
   verification and reset tokens are written to `auth_tokens` but nothing sends
   them, so a supplier cannot complete signup or reset a password.
3. **Replace the placeholder accreditation form** with the real one.
4. **Build the supplier-facing UI pages** for orders, prices and invoices — the
   API routes exist and are typed, the screens are not built yet.

<!-- deploy marker: 2026-09-15T06:36:34Z -->
