# STAYBID JAPAN

支払った総額だけで順位が決まる、日本の週末ステイランキング。アカウント・投票なし。

A public ranking of weekend stays in Japan, inspired by outbid.lol (Jonathan
Wilke): the only way to move up is to pay more than whoever is above you.
No accounts, no votes, no algorithm — just a list sorted by total yen paid,
in the open, forever. Anyone can add a listing or top one up for ¥100.

## Architecture

- **Frontend**: `index.html`, static, served from the repo root.
- **Backend**: Vercel serverless functions under `api/`:
  - `rankings.js` — GET, returns the current ranking.
  - `create-checkout.js` — POST, creates a Stripe Checkout session.
  - `stripe-webhook.js` — POST, confirms payment and applies it to the DB.
  - `thumbnail.js` — GET, resolves a listing's photo from its own site
    (`og:image`/icon), so the browser never loads images from a third-party
    screenshot service.
- **Database**: Supabase (Postgres) — see `supabase-schema.sql`.
- **Payments**: Stripe Checkout, one-time payments, JPY.

## Setup (fresh Supabase project)

1. Create a Supabase project.
2. Run `supabase-schema.sql` once, top to bottom, in its SQL Editor.
3. Set these environment variables in Vercel:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `STRIPE_SECRET_KEY` (live key)
   - `STRIPE_WEBHOOK_SECRET`
   - `PUBLIC_BASE_URL` (the deployed domain, e.g. `https://staybid-japan.vercel.app`)
4. In Stripe (Developers → Webhooks / Event destinations), add an endpoint
   for `https://<your-domain>/api/stripe-webhook` listening for
   `checkout.session.completed`, and copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.
5. Redeploy.

## Tests

`npm test` runs the three Node suites in `test/`, with Stripe and Supabase
stubbed — no keys, no network, no database needed:

- `test-checkout.js` — the minimum payment can't be undercut by calling the
  API directly, bad amounts and `javascript:` URLs are rejected, and the
  return URLs survive a missing or mistyped `PUBLIC_BASE_URL`.
- `test-webhook.js` — signs real payloads with the Stripe library: a valid
  signature is applied once, a tampered body is refused, duplicates are
  ignored, and a failure returns 500 so Stripe retries instead of the
  payment being lost.
- `test-thumbnail.js` — the SSRF guard, including a simulated DNS-rebinding
  attack.

`test/schema-test.sql` checks the database guarantees against a real
Postgres (see the header of that file for how to run it).

## Design notes worth knowing before touching the code

- **No two listings can ever tie.** `total_paid_jpy` has a database-level
  unique constraint; `apply_paid_listing` retries 1 yen higher on a
  collision. This is enforced by Postgres itself, not application logic, so
  it holds even under truly concurrent payments.
- **Ranking placement is automatic.** There's no per-listing "minimum to
  beat this one" — any payment (min ¥100) sorts itself into the right spot
  by total paid. The OUTBID button's suggested amount is informational only.
- **Payments always ADD to a listing's total** (never overwrite it) — this
  is what lets several people crowdfund the same listing over time.
- **Each Stripe session is applied at most once.** `apply_paid_listing`
  locks the payment row and checks whether it already has a `listing_id`
  before touching `listings`, so a webhook retry (Stripe's own redelivery,
  or two concurrent deliveries of the same event) can never double-count
  a payment.
- **The webhook's `bodyParser: false` must be set on the exported handler
  itself**, after the function is defined — setting it before
  `module.exports = ...` gets silently discarded and breaks Stripe
  signature verification.
