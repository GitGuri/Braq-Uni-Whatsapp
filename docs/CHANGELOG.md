# Changelog

## 2026-11-17: Production hardening

This is a security, integrity and reliability pass over the existing system. No feature was removed,
and no architecture was replaced: Express, PostgreSQL, the Postgres job queue and outbox, Gemini, the
Meta WhatsApp integration and JWT authentication are all unchanged.

Issue IDs refer to [AUDIT_REPORT.md](AUDIT_REPORT.md). Every change has an automated test (listed by
test file). Four database migrations were added, all additive and idempotent; none changes or deletes
an existing row.

### Security

| ID | Change | Files | Tests |
|---|---|---|---|
| SEC-1 | `seed-testing.js` and `seed-catalog.js` (R 0 placeholder prices) refuse to run against production (`NODE_ENV=production` or a Supabase URL). `seed.js` needs `SEED_ADMIN_PASSWORD` (at least 12 characters, not the default) there. The guard is shared with `reset.js`, which now also drops `job_events`, `rate_limits` and `broadcast_outcomes`. | `db/safety.js` (new), `db/seed.js`, `db/seed-testing.js`, `db/seed-catalog.js`, `db/reset.js` | `unit/db.safety`, `blackbox/db-scripts` |
| SEC-2 / AUTH-3 | Production start-up refuses a missing or placeholder `META_APP_SECRET`, `JWT_SECRET` (it must be at least 32 characters and not the dev default), verify token, Meta, Gemini and Resend keys, and the dashboard URL. It also refuses `WHATSAPP_WINDOW_CHECK=off` and unverified DB TLS. The webhook rejects unsigned requests in production even if the start-up check is bypassed. | `core/config.js`, `index.js`, `worker.js`, `modules/webhook/controller.js` | `unit/config.production` |
| SEC-3 | Database TLS is set by `DB_SSL_MODE`: `verify` (the default in production, with the `DB_SSL_CA` certificate), `no-verify` (the default elsewhere) or `disable`. `ssl*` parameters in the URL are stripped so they can't silently override it. A certificate failure prints a clear start-up error. Connection timeout and statement timeout were added. | `core/db.js`, `core/config.js` | `unit/pool`, `unit/config.production` |
| SEC-4 | Every route handler's rejection or throw now reaches the error middleware (`catchAsyncRoutes`), so one bad request can no longer kill the process. The broadcast body is validated with Zod. An unknown or missing `audience` returns **400** instead of reaching every client. | `core/http.js`, `app.js`, `modules/broadcasts/*` | `unit/core`, `blackbox/broadcasts`, `integration/http` |
| SEC-5 | A valid token while the database is unreachable gets **503**, not 401, so staff aren't signed out during a blip. A token whose id isn't a UUID gets 401. | `middleware/auth.js` | `unit/middleware`, `integration/auth` |
| SEC-6 | Login takes the same time for unknown emails (dummy bcrypt compare). | `modules/staff/service.js` | `integration/auth` |
| SEC-9 / SEC-10 / SEC-11 | Staff reply length is capped at 4,096 characters. A settings value must be a scalar. `/health` no longer returns `env`. | `modules/conversations/controller.js`, `modules/settings/routes.js`, `app.js` | full suites |
| AUTH-1 | Chat `assign` and `handback` follow the take-over rule: the owner, anyone when the chat is unassigned, or an admin/manager. Anyone else gets 409 naming the owner. | `modules/conversations/*` | `integration/auth` |
| AUTH-2 | `DELETE /api/staff/:id` now **deactivates** instead of erasing, so history keeps the name. It refuses your own account and the last active admin, including two admins removing each other at the same moment. New `PATCH /api/staff/:id` (role, reactivate, password reset; admin only) and `POST /api/staff/me/password`. | `modules/staff/*` | `integration/auth`, `blackbox/auth-security` |
| AUTH-4 | `GET /api/quotations/:id/pdf` now requires a staff login and sends `Cache-Control: private, no-store`. Clients still get the PDF as an uploaded WhatsApp document; no production code used the public link. | `modules/quotations/routes.js`, `controller.js` | `blackbox/catalog-quotes`, `auth-security`, `staff-ux` |

### Data and financial integrity

| ID | Change | Files | Tests |
|---|---|---|---|
| DAT-1 | `POST /orders/:id/advance` accepts `expect`, and the dashboard always sends it. A repeated or stale advance returns **409 STALE** instead of skipping a stage and messaging the client. Any payment sent with it is rolled back. | `modules/orders/controller.js`, frontend `useJobActions.js`, `Dashboard.jsx` | `blackbox/lifecycle`, `frontend/contract` |
| FIN-1 | Payments take an `idempotencyKey`. The same key returns the first payment with 200 `replayed: true`; there's no second row or second receipt. The same key with different details gets 409. Each payment stores `recorded_by`. A database CHECK enforces amount > 0. (migration 0011) | `modules/payments/service.js`, `modules/orders/*`, `modules/jobs/service.js`, frontend | `integration/payments.service`, `blackbox/lifecycle`, `frontend/contract` |
| FIN-2 | On WhatsApp, ordering from an **accepted** quote past its validity is refused (`QUOTE_EXPIRED`) and a refreshed quote is offered. Staff conversion is unchanged (business decision). | `modules/orders/convert.js`, `modules/bot/states/order.js` | `integration/orders.service` |
| FIN-3 | A draft's (possibly AI-suggested) total is never shown to the client. | `modules/bot/templates.js` | `unit/bot.templates` |
| FIN-4 | An AI-parsed line is auto-priced only for a whole quantity of 1 to 5,000, with sizes that add up to it. Anything else goes to a consultant. | `modules/quotations/service.js` | `integration/quotations.service` |
| FIN-5 | The quote PDF job sends nothing if the quote is no longer sent or accepted. | `workers/handlers/quotation.pdf.send.js` | `integration/quotations.service` |
| FIN-9 | Payments are ZAR only (another currency would be summed as rand). | `modules/payments/service.js`, `modules/orders/controller.js` | `integration/payments.service`, `blackbox/orders` |
| FIN-10 | Size-roster uploads for one order are serialised (row lock). | `modules/orders/sizes.js` | orders suites |
| FIN-11 | A quote status change locks the quote first, so a decline can't land on a quote being converted. | `modules/quotations/service.js` | quotations suites |
| DAT-2 | A replayed bot turn (crash, deploy, retry) **can't create a second quotation, ticket or direct order**. Each carries `source_event_id` with a unique index. A direct order consumes its pending items in the order transaction. The API drains running jobs on SIGTERM. Unhandled errors are logged before exit. (migration 0012) | `modules/bot/states/*`, `modules/quotations/service.js`, `modules/tickets/service.js`, `modules/orders/service.js`, `index.js`, `core/process.js` (new) | `integration/bot.idempotency`, `unit/process` |

### Messaging and queue reliability

| ID | Change | Files | Tests |
|---|---|---|---|
| MSG-1 | A staff change to a chat made while a bot turn runs (take-over, hand-back) is no longer overwritten. The turn's state change is dropped, and so is its reply when a consultant took the chat over (human state **and** a new owner). | `modules/bot/reply.js` | `integration/bot.idempotency`, `integration/bot.orderref` |
| MSG-2 | A consultant-owned chat whose client has waited 2 hours or more emails the owner (once per unanswered message). (migration 0013) | `workers/handlers/reminder.scan.js`, `modules/notifications/service.js` | `integration/queue` |
| MSG-3 | A Meta 400/404 that isn't a rate limit or outage is dead-lettered at once, instead of 8 retries holding up the client's other messages for about 20 minutes. Text is clipped to 4,096 characters and captions to 1,024. | `integrations/whatsapp.client.js`, `workers/handlers/whatsapp.send.js` | `unit/whatsapp.client`, `integration/queue` |
| MSG-4 | Bot-made drafts and tickets whose staff email was lost (failed turn) are picked up by the 2-hour reminder scan. | `workers/handlers/reminder.scan.js` | `integration/bot.idempotency` |
| MSG-5 | Each broadcast recipient's outcome is recorded once per job, so counters can't be lost or double-counted and a retry can't re-send. Crash-dead-lettered sends are settled: inbox row marked failed, broadcast completed. (migration 0014) | `workers/handlers/whatsapp.send.js`, `workers/loop.js` | `integration/queue`, `integration/http` |
| Q-1 | `complete`/`fail` are fenced on the claiming worker, so a slow run of a reclaimed job can't overwrite the new run. | `core/queue.js`, `workers/loop.js` | `integration/queue` |
| Q-3 | A reminder is stamped (conditionally) before its email is queued, so an item claimed in between isn't reminded. | `modules/notifications/service.js` | `unit/notifications.service` |
| Q-4 | A failing `ROLLBACK` keeps the original error and discards the broken connection. | `core/db.js` | `unit/pool` |
| Q-6 | Email sends carry an idempotency key per job, so a retried job doesn't send a duplicate email. | `integrations/email.client.js`, `workers/handlers/email.send.js` | full suites |

### Dashboard

| ID | Change |
|---|---|
| FE-1 | Error boundaries around each page and around the app. A broken page or a stale bundle after a redeploy shows a Reload card instead of a blank screen. |
| FE-2 | "Skip the check (manager)" is offered only for stage advances, where it works. |
| FE-3 | Enter can't double-send an inbox reply. |
| FE-4 / FE-6 | Confirmation before the "busy" broadcast and before one-click "create order". |
| FE-5 | Delay-notice form: the unused reason field was removed and the audience wording corrected. |
| FE-7 | A timeout on a change says it "may have gone through — refresh first". 503 has its own message and doesn't sign you out. |
| FE-8 | "Price & send" is disabled while the draft autosaves. |
| FE-9 / AUTH-2 | Staff page: "Remove access" (not on your own row), an Inactive tag, and Restore access. Assignment dropdowns hide inactive staff. |
| FE-10 to FE-15 | Lists refresh after closing a chat. File sizes are checked before upload. Load failures show an error instead of zeros. A 24-hour-window warning appears in the composer. Prices are limited to 2 decimals. The quote builder lists active products only. |

### Tests changed (behaviour intentionally changed)

- `blackbox/broadcasts`, `integration/http`: requests that relied on "unknown or missing audience = all clients" now name `all_clients`. The old behaviour is asserted as a **400**.
- `blackbox/orders`, `integration/payments.service`: a USD payment is now refused (**400**).
- `blackbox/catalog-quotes`, `auth-security`, `staff-ux`: the quotation PDF without a login is **401**.
- `integration/queue`: the reminder-scan result has a new `unansweredChats` count.
- `integration/orders.service`: the flaky hold test (TEST-1) now asserts behaviour instead of timing.
- `frontend/e2e`: the one-click create-order test now clicks the new confirmation.

### Deployment notes

1. **Run `npm run migrate`** before starting the new version (0011 to 0014). The API refuses to start while migrations are pending.
2. **Set `DB_SSL_CA`** to the Supabase CA certificate. Production now verifies database TLS by default.
3. **Check all required production variables** (see [DEPLOYMENT.md](DEPLOYMENT.md)). Start-up lists every missing one.
4. **Behaviour change:** clients that called the quotation PDF without a login (none in this codebase) now get 401.
