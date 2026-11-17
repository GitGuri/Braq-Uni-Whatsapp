# Production Readiness

**Assessed:** 2026-11-17, after the hardening pass ([CHANGELOG.md](CHANGELOG.md), [AUDIT_REPORT.md](AUDIT_REPORT.md)).

## Classification: READY FOR CONTROLLED STAGING

The code-level acceptance criteria are met and verified by automated tests against a throwaway
database. The system is **not yet ready for production traffic**. A short list of configuration,
data and business items has to be completed and verified first (see section 3). None of them needs
new code.

---

## 1. Evidence

All suites run on a throwaway embedded Postgres with WhatsApp, Gemini and Resend faked. Production
was not used for any test.

| Suite | Command | Baseline (before) | After hardening |
|---|---|---|---|
| Backend unit | `npm test` | 515 / 515 | **550 / 550** |
| Backend integration | `npm run test:integration` | 349 / 350 (1 flaky) | **379 / 379** (see note) |
| Backend black-box | `npm run test:blackbox` | 345 / 345 | **352 / 352** |
| Frontend contract + E2E | `npm run test:frontend` | 164 / 166 (2 flaky) | **177 / 177** |
| Frontend build | `npm run dashboard:build` | builds | **builds** |

**Note on the integration count:** the last full run showed 378 / 379. The one failure was a
time-dependent test (`bot.ux2`, "registration in one message"). It never fixed the clock, so it
failed whenever the suite ran after 17:00 in South Africa, when the bot correctly adds its
after-hours notice. The test was fixed and its file re-run (28 / 28). The full integration suite was
not run again after that one-line test fix. Two previously flaky tests were also stabilised:
TEST-1 (hold notification timing) and a concurrent first-message race.

## 2. Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Existing backend tests pass | ✅ | Table above |
| Existing frontend tests pass | ✅ | 177 / 177 |
| Backend builds and starts | ✅ (tests) | Black-box suites boot the real API process. Not started against production. |
| Frontend builds | ✅ | `vite build` |
| Migrations work on a clean, isolated database | ✅ | Every suite migrates a fresh database. `db-scripts` re-runs `migrate` (0 applied) and runs the README setup on an empty database. |
| No critical authentication bypass | ✅ | Route/auth enumeration test (`auth-security`). Every non-public route needs a token, which is re-checked against an active staff row on each request. The quotation PDF is now staff-only. |
| Production webhook signature verification is mandatory | ✅ | Start-up refuses a missing `META_APP_SECRET`. The webhook rejects unsigned requests when `NODE_ENV=production` (`unit/config.production`). |
| Duplicate webhook processing prevented | ✅ | `meta_message_id` UNIQUE, plus `source_event_id` replay idempotency (`integration/bot.idempotency`). |
| Duplicate financial transactions prevented | ✅ | Payment idempotency key with a unique index, an order-row lock, and `expect` on advances (`integration/payments.service`, `blackbox/lifecycle`). |
| Order lifecycle rules enforced on the server | ✅ | Guards plus conditional UPDATE plus `expect` (`blackbox/lifecycle`, `integration/orders.service`). |
| Design-approval requirement enforced | ✅ | PROOF_PENDING guard (existing tests). |
| Payment calculations correct | ✅ | Integer cents, VAT, 60/40 split (`unit/core`, `payments.pure`, integration). |
| Background jobs recover from failures | ✅ | Backoff, dead-letter, stale reclaim, fenced completion, SIGTERM drain (`integration/queue`, `unit/process`). |
| Outbox events reliably processed | ✅ | Enqueued in the business transaction. Idempotent senders. Dead sends settled (`integration/queue`). |
| Sensitive documents access-controlled | ✅ | `GET /api/quotations/:id/pdf` needs staff auth and sets `Cache-Control: private, no-store`. |
| Frontend handles API failures gracefully | ✅ | Error boundaries, 503 and timeout messages, error states (`frontend/contract`). |
| Required production env vars documented | ✅ | [DEPLOYMENT.md](DEPLOYMENT.md), `backend/.env.example`. Start-up lists anything missing. |
| No secrets committed | ✅ | `.env` files are untracked and absent from history (audit). |
| Deployment and recovery documented | ✅ | [DEPLOYMENT.md](DEPLOYMENT.md) |

## 3. Blocking items before production traffic

| # | Item | Owner action |
|---|---|---|
| 1 | **Rotate the exposed key.** `backend/.env` line 39 holds a nameless 53-character value that looks like an API key and was printed to a session log. | Rotate it with its provider and delete the line. |
| 2 | **Apply migrations 0011 to 0014** to production. | `npm run migrate` with the production `DATABASE_DIRECT_URL`. The API refuses to start until this is done. |
| 3 | **Database TLS CA.** Production now verifies the database certificate. | Download the Supabase CA certificate and set `DB_SSL_CA` (and `DB_SSL_MODE=verify`). |
| 4 | **Production env completeness:** `META_APP_SECRET`, a 32+ character `JWT_SECRET`, a non-default `META_WEBHOOK_VERIFY_TOKEN`, Gemini/Resend keys, `DASHBOARD_BASE_URL`, `TRUST_PROXY`, `NODE_ENV=production`. | Start the API once in staging with production-like settings. It lists every problem. |
| 5 | **WhatsApp templates.** `WHATSAPP_TEMPLATES` is not set, so every business-initiated message more than 24 h after the client last wrote is **not delivered** (stage updates, receipts, quote ready, delays). | Register the 8 templates in WhatsApp Manager and set the variable. |
| 6 | **Database invariants on production.** Check that `uniq_orders_quotation`, `uniq_open_conversation_per_client` and the `0006` CHECK constraints exist. They are skipped when old rows violate them. | Query `pg_indexes` / `pg_constraint`. Fix the violating rows if needed, then re-run the migrations. |
| 7 | **Seeds.** Confirm that `seed-testing.js` (admin `thabo@braquni.com` with a published password) was never run against production. | Check the `staff` table. Deactivate any such account. |
| 8 | **Real catalogue and school prices loaded.** Placeholder products (R 0) would be auto-quoted at R 0.00. | Check `products` and `school_catalog`. |
| 9 | **Controlled pilot.** Run a few real clients end to end on the live number: quote, accept, deposit, proof, production, collection, and a complaint. | Use staging or a pilot group. |

## 4. Requires manual business verification

These decisions were kept as they are, documented in [BUSINESS_RULES.md](BUSINESS_RULES.md):

- Account-terms clients still need a manager override (BALANCE_DUE) to complete an order.
- Consultants may record payments. This is now audited (`recorded_by`) and idempotent.
- Staff can convert an **accepted** quote past its validity. Only the WhatsApp path refuses it.
- There is no way to void or refund a payment in the app.
- A zero-total order can never be marked paid. An order with an unknown total can be marked paid by any balance/full payment.
- The 4-hour SLAs count clock hours, while client messages say "4 business hours".
- WhatsApp **direct orders** don't apply the auto-quote quantity bounds. The client sees and confirms the items and total first.

## 5. Known remaining risks (not blocking a controlled staging)

| Risk | Why it remains |
|---|---|
| Outbound WhatsApp is at-least-once. | Meta has no idempotency key. A crash between Meta accepting a message and the database update can repeat one message. |
| Broadcasts and take-over/hand-back notices have no template fallback. | Clients silent for more than 24 h won't receive them. This needs new Meta templates. |
| Staff JWT is in `localStorage`, and a password change does not revoke existing tokens. | A cookie-session migration is a larger change. Tokens expire after 8 h, and deactivation is immediate. |
| Any staff member can reply to or close any chat. | The ownership rule covers take-over, assign and hand-back only. Replying is part of the shared-inbox workflow. |
| Dead-lettered jobs are visible only in logs and SQL. | There is no dashboard view. A requeue procedure is in [DEPLOYMENT.md](DEPLOYMENT.md). |
| Two "order total" formulas can disagree on legacy rows (FIN-8). | The change was reverted because it altered tested behaviour. Check production for rows where `total_amount ≠ balance + max(paid, deposit)`. |
| `quote_expiring` template is defined, but nothing sends it. | No feature uses it yet. |
| Default staff emails go to consultants only. | Admins and managers aren't on the list. |
