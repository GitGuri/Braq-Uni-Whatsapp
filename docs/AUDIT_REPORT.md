# Braq Connect: Phase One Audit Report

**Date:** 2026-11-17
**Scope:** `backend/` and `frontend/` only (`.kilo/` ignored).
**Method:** read-only static review of every backend module, migration, worker and frontend page,
plus a full baseline test run. No code was changed for this report.

Status labels:

- **CONFIRMED:** the exact code path was traced. Items marked ✔ were also re-checked by hand during review.
- **POTENTIAL:** the logic suggests a problem, but it needs a runtime or production-data check.

---

## 1. Baseline

The baseline was run against throwaway embedded Postgres with every external service faked. Production
was never touched.

| Suite | Command | Result |
|---|---|---|
| Backend unit | `npm test` | **515 / 515 pass** |
| Backend integration | `npm run test:integration` | 349 / 350. One failure, `setOrderHold: notification failure is retried`, is **flaky**: it passed 2 of 2 reruns. Cause: with the test backoff of 10 ms, the retry completes inside the same `drain()`. |
| Backend black-box | `npm run test:blackbox` | **345 / 345 pass** |
| Frontend contract + E2E | `npm run test:frontend` | 164 / 166. Two ticket E2E tests failed with `page.goto: Timeout 20000ms` and are **flaky**: they passed on rerun. |
| Frontend build | `npm run dashboard:build` | **Builds.** Warning: the antd chunk is 1 MB (312 kB gzip). |

**Repository state:** the move from `apps/api` to `backend/` (about 150 files) is uncommitted.
No `.env` file is tracked in git or present in its history.

---

## 2. Urgent operational items

These need action outside the code.

| ID | Item | Action |
|---|---|---|
| **OPS-1** | `backend/.env` line 39 is a 53-character value with no `KEY=` name, which looks like a pasted API key. An audit tool printed variable names to a session log, so treat the value as exposed. | **Rotate that key** with its provider and delete the line. |
| **OPS-2** | `backend/.env` points at **production** Supabase. `npm run seed:testing` has **no production guard**: it would create admin `thabo@braquni.com` with the hard-coded password `Braq@2025!` on the live system. `seed.js` falls back to `changeme123`. | Do not run either seed against `.env` until SEC-1 is fixed. If either has ever been run against production, check the `staff` table now. |

---

## 3. Confirmed and potential problems, by priority

### Critical / High

| ID | Area | Problem | Status | Evidence |
|---|---|---|---|---|
| SEC-1 | Data safety | Seed scripts create known-password admins with no production or Supabase refusal. `db:reset` has one; the seeds don't. | CONFIRMED ✔ | `db/seed-testing.js:30-33`, `db/seed.js:8,25` |
| SEC-2 | Webhook | When `META_APP_SECRET` is unset, signature verification is **skipped** with one log warning, so anyone can forge messages "from" a client: accept quotes, approve proofs, place orders. Startup doesn't require the secret in production. | CONFIRMED ✔ (whether production sets it needs runtime confirmation) | `webhook/controller.js:27-34`, `core/config.js:42` |
| SEC-3 | DB TLS | `ssl: { rejectUnauthorized: false }` is hard-coded, so the Supabase certificate is never validated (man-in-the-middle risk). The `DB_SSL` setting is read but unused. | CONFIRMED ✔ | `core/db.js:24,40`, `core/config.js:37` |
| SEC-4 | Availability | Some async handlers await outside any error handling (e.g. `broadcasts/controller.js` `list`, and `custom` with a non-string `message`). Express 4 doesn't catch rejected promises, and there is no `unhandledRejection` handler, so **one bad request or DB error can kill the API process**. An unknown broadcast `audience` silently becomes **all clients**. | CONFIRMED ✔ | `broadcasts/controller.js:23,32`, `broadcasts/service.js:87` |
| DAT-1 | Order lifecycle | **A second "advance" skips a stage.** The service supports an `expect` stage check, but the Zod schema strips the field and the UI never sends it. A stale tab or a retried request after a timeout can move in_production to ready (or ready to completed) and send the client a false WhatsApp. | CONFIRMED ✔ | `orders/controller.js:50-63`, `orders/service.js:313`, `useJobActions.js:95-103` |
| DAT-2 | Bot / idempotency | **A replayed bot turn duplicates business records.** Quotation, ticket and direct-order creation commit before the turn's transaction (`processed_at` and the stored message are written only at commit). A replay after a crash, a deploy (the API has no SIGTERM drain) or a failed commit creates a second quote (and auto-sends a second PDF), ticket or order. | CONFIRMED ✔ | `bot/reply.js:96-130`, `states/quote.js:57,64`, `states/ticket.js:74`, `states/order.js:233`, `index.js` |
| FE-1 | Frontend | **No error boundary.** One render error, or a lazy chunk failing to load after a redeploy, blanks the whole dashboard. | CONFIRMED | `main.jsx`, `App.jsx`, `DashboardLayout.jsx` |

### Medium

| ID | Area | Problem | Status |
|---|---|---|---|
| FIN-1 | Payments | No idempotency: a part-payment submitted twice is stored twice and can wrongly flip `deposit_paid`. Payments don't record **who** recorded them, and any consultant can record a "full" payment that satisfies the deposit and balance checks without the manager override. There is no void/refund path. | CONFIRMED (`payments/service.js:145-149`, `0001_baseline.sql:245`) |
| FIN-2 | Quotations | An **accepted** quote never lapses, so an order can be created months later at stale prices through the staff or bot path. The PO path does check this. | CONFIRMED (`orders/convert.js:88-96`) |
| FIN-3 | Quotations | Draft (unpriced) quotes show **AI-guessed totals** to the client when they ask for their quote status. | CONFIRMED (`quotations/service.js:128-151`, `templates.js:355`) |
| FIN-4 | Quotations | Auto-sent quotes don't bound quantity (no integer check or upper limit, sizes not reconciled with quantity) before the PDF goes out with no human review. | CONFIRMED (`quotations/service.js:100`, `states/quote.js:63`) |
| FIN-5 | Quotations | `quotation.pdf.send` renders whatever the row holds at run time, with no status check. A quote revised back to draft can still go out with draft prices and "Reply accept". | CONFIRMED |
| MSG-1 | Bot | A turn's state write is unconditional, so it can **overwrite a consultant takeover** made at the same moment, and the bot keeps talking over the consultant. | CONFIRMED (`bot/reply.js:109-113`) |
| MSG-2 | Bot | A `consultant_active` chat is never released or reminded. If the consultant forgets it, the client is ignored indefinitely. | CONFIRMED (`router.js:220`, `reminder.scan.js:67-71`) |
| MSG-3 | Queue | Meta 4xx errors other than 131047 (e.g. a body over 4096 characters) are retried 8 times. Because each client's sends are FIFO, **all replies to that client stall about 21 minutes**. AI follow-up text isn't length-capped. | CONFIRMED (`whatsapp.client.js:23-29`, `gathering.js:36`) |
| MSG-4 | Bot | After a failed commit, the created draft or ticket has `notified_at` NULL, so staff are never emailed and never reminded. | CONFIRMED |
| MSG-5 | Broadcasts | Sent/failed counters can be lost or double-counted. A recipient with no conversation can be **re-sent** on retry. Jobs dead-lettered by `reclaimStale` skip the failure bookkeeping, so the message stays `queued` forever. | CONFIRMED (`whatsapp.send.js:70-80,134,196-206`) |
| AUTH-1 | RBAC | `PATCH /conversations/:id/assign` and `handback` skip the ownership rule that `takeover` enforces, so any consultant can take any chat. | CONFIRMED (`conversations/service.js:245,299-310`) |
| AUTH-2 | Staff | Staff can only be **hard-deleted**, including yourself or the last admin, which locks everyone out. There's no deactivate, role-change or password-change endpoint, and deleting wipes the person's name from audit history. | CONFIRMED (`staff/service.js:36-39`) |
| AUTH-3 | Config | The JWT secret's only check is that it exists, and only when `NODE_ENV === 'production'`. Otherwise it falls back to a public default. `META_WEBHOOK_VERIFY_TOKEN` also has a default. | CONFIRMED (`core/config.js:17-19,45,50`) |
| AUTH-4 | Docs | The quote PDF link is public by design (Meta must fetch it). It uses a v4 UUID (not guessable) but **never expires**, carries no `Cache-Control`, and exposes the client's name, phone, address and prices. | CONFIRMED (`quotations/controller.js:224`) |
| AUTH-5 | Proxy | `TRUST_PROXY` isn't set. Behind a proxy, all staff share one rate-limit bucket, and the login limiter can be used to lock out any staff member. | POTENTIAL (depends on hosting) |
| FE-2 | Frontend | A manager override can **never** succeed for "Record deposit + Start production now": the override isn't sent with the payment, so the same 409 repeats. | CONFIRMED (`useJobActions.js:77-91`) |
| FE-3 | Frontend | Pressing Enter twice in the inbox sends the WhatsApp reply twice (no `isPending` guard). | CONFIRMED (`ConversationChat.jsx:191-196`) |
| FE-4 | Frontend | The "busy" broadcast goes to every client with an open order on **one click**, with no confirmation. | CONFIRMED (`Broadcasts.jsx:199`) |
| FE-5 | Frontend | The delay broadcast ignores the reason staff type, and the UI says "every client with an active order" while the backend sends only to non-retail clients. | CONFIRMED (`Broadcasts.jsx:342-345`) |
| FE-6 | Frontend | The one-click "Client accepted — create order" on the dashboard has no confirmation. | CONFIRMED (`Dashboard.jsx:160-171`) |
| FE-7 | Frontend | A network timeout on a mutation shows a raw error even when the server committed, which invites a retry (see DAT-1, FIN-1). | CONFIRMED |

### Low

- **FIN-6:** a zero-total order can never be marked paid. Every stage needs an override.
- **FIN-7:** an order with an unknown total can be marked `paid_in_full` by any payment.
- **FIN-8:** two different "order total" formulas (payments vs `outstandingAfter`). They can disagree on legacy rows.
- **FIN-9:** any 3-letter currency is accepted, then summed as ZAR.
- **FIN-10:** two size-roster uploads at once merge into one.
- **FIN-11:** declining a quote while it's being converted to an order can leave a rejected quote with a live order. POTENTIAL.
- **FIN-12:** account-terms clients need an override at every completion. This is a business rule to confirm.
- **Q-1:** stale-lock reclaim plus `complete()`/`fail()` that aren't fenced on `locked_by` could run the same job twice. There are no pool or statement timeouts.
- **Q-2:** dead jobs are visible only in logs. No UI or requeue.
- **Q-3:** `reminder.scan` doesn't re-check a claim before emailing.
- **Q-4:** `withTransaction` loses the original error if `ROLLBACK` throws.
- **Q-5:** the LISTEN connection isn't re-established (the 1 s polling covers it).
- **Q-6:** WhatsApp and email sends are at-least-once. This is inherent; Resend could take an `Idempotency-Key`.
- **SEC-5:** a DB error in the auth check returns 401, which logs every staff member out.
- **SEC-6:** login timing reveals which emails exist.
- **SEC-7:** an xlsx decompression bomb isn't capped.
- **SEC-8:** the attachment MIME type is trusted.
- **SEC-9:** the reply body has no length cap.
- **SEC-10:** settings PATCH stores `String(object)`.
- **SEC-11:** `/health` exposes `env`.
- **SEC-12:** the JWT is in `localStorage`, and logout is client-side only.
- **DB-1:** `uniq_orders_quotation`, `uniq_open_conversation_per_client` and the `0006` CHECKs are skipped silently if existing data violates them. **Check `pg_indexes`/`pg_constraint` in production.** There's no `CHECK (amount > 0)` on payments.
- **FE-8:** "Price & send" isn't disabled during the autosave flush.
- **FE-9:** admins can delete themselves (see AUTH-2).
- **FE-10:** closing a chat doesn't refresh lists.
- **FE-11:** upload size isn't checked before upload.
- **FE-12:** failed loads render as zeros or empty states.
- **FE-13:** no warning when replying outside the 24-hour window.
- **FE-14:** price inputs allow more than 2 decimals.
- **FE-15:** the quote builder lists inactive products.

### Flaky tests

- **TEST-1:** `setOrderHold: notification failure is retried`, a timing race with a 10 ms backoff.
- **TEST-2:** ticket E2E tests time out on the page load (20 s).

---

## 4. Verified correct

These were checked and need no change.

- **Money:** integer cents throughout. VAT is 15% rounded half-up. Deposit plus balance always equals the total. Totals are recomputed on the server, and client `lineTotal` is ignored.
- **Quotes:** line items are snapshotted as JSON, and the PDF is rendered from the stored row.
- **Concurrency:**
  - Payment overpayment checks lock the order row (`FOR UPDATE`).
  - Quote-to-order conversion locks the quote and refuses a second order (409).
  - Two simultaneous advances: the conditional UPDATE lets only one win.
  - Proof-vs-advance and hold-vs-advance races resolve correctly.
  - Quotation, ticket and conversation claims are atomic (`WHERE assigned_staff_id IS NULL`).
- **Expiry on accept** is enforced in SQL, not only by the scheduler.
- **Reference counters** (quotation, order, customer) are atomic upserts with UNIQUE references.
- **Notifications** are enqueued in the same transaction as the change, with dedupe keys.
- **Webhook (when the secret is set):** constant-time HMAC over the exact raw body for every content type. 200 only after commit. Meta retries are deduped by `meta_message_id UNIQUE`.
- **Queue:**
  - `SKIP LOCKED` claims, FIFO per key, and dead jobs don't block a key.
  - Exponential backoff with a cap and jitter, plus dead-lettering.
  - Prune deletes only `done` jobs, and scheduler buckets dedupe across instances.
- **AI:** catalogue products and prices come from the DB, never from Gemini (except FIN-3 drafts). Every call has a timeout, a schema and a shape check, plus a fallback.
- **Auth:** JWT pinned to HS256 with 8 h expiry. The staff row and role are re-checked on every request, so deactivation takes effect immediately. bcrypt cost 12. Login rate limit stored in Postgres.
- **SQL:** no user input is interpolated. LIKE searches are escaped, and LIMIT/OFFSET are clamped.
- **Errors:** generic 500s, no stack traces to clients, and logs redact tokens, emails and phone numbers.
- **Frontend:** 401 handling, display of 409 blockers, broad query invalidation, and no optimistic financial updates. Most money and stage buttons show a pending state. Permission-gated UI.
- **Contract:** every frontend call maps to a real backend route with matching methods, field casing and status values.

---

## 5. Needs runtime or production verification

1. Whether `META_APP_SECRET` is set (non-empty) in the production deployment. (SEC-2)
2. Whether the production DB has `uniq_orders_quotation`, `uniq_open_conversation_per_client` and the `0006` CHECK constraints. (DB-1)
3. Whether either seed script has ever been run against production. (OPS-2)
4. Hosting and proxy setup, to choose the right `TRUST_PROXY`. (AUTH-5)
5. Supabase CA certificate and connection mode (pooler vs direct), for TLS verification. (SEC-3)
6. Legacy rows where `total_amount` differs from the payments-derived total. (FIN-8)
7. Business decisions:
   - Should account-terms clients skip BALANCE_DUE? (FIN-12)
   - Should accepted quotes expire? (FIN-2)
   - Should consultants record payments? (FIN-1)

---

## 6. Proposed fix order

Each fix is minimal and test-backed, in the order the brief sets.

1. **Security:**
   - SEC-1: seed refusal checks
   - SEC-2 and AUTH-3: production fail-fast for webhook secret, JWT secret, verify token
   - SEC-4: async error safety, `unhandledRejection` handler, broadcast validation
   - SEC-3: verified TLS behind config, local and dev unchanged
2. **Data integrity:**
   - DAT-1: `expect` on advance, UI sends it
   - FIN-1: payment idempotency key and `recorded_by` (additive migration)
   - DAT-2 and MSG-4: idempotency keys from `inbound_events.id`, SIGTERM drain
   - FIN-2, FIN-5, FIN-3
3. **Messaging and queue:** MSG-3 (permanent 4xx, 4096-character cap), MSG-1, MSG-5, Q-1, Q-4.
4. **Auth gaps:** AUTH-1, AUTH-2 (deactivate instead of delete, last-admin guard), SEC-5.
5. **Frontend:** FE-1, FE-2, FE-3, FE-4, FE-6, FE-7.
6. **Tests and docs:** regression tests for each fix, the flaky-test fixes, then the `docs/` set and `.env.example` updates.
