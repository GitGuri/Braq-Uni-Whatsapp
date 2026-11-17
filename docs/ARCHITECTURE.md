# Braq Connect: Architecture

Braq Connect is a WhatsApp sales platform for Braq Uni. It has three parts:

- **API**: a Node.js / Express service (`backend/`).
- **Job worker**: runs in the same process as the API by default.
- **Staff dashboard**: React (`frontend/`).

All of them share one PostgreSQL database (Supabase in production).

The authoritative code is in `backend/` and `frontend/`. Status labels in this document: **Implemented**, **Partially implemented**, **Not implemented**, **Requires external configuration**, **Requires manual business verification**.

---

## 1. Processes

```
                   Meta WhatsApp Cloud API                  Staff browser
                    │ webhook POST   ▲ Graph API             │ HTTPS (JWT)
                    ▼                │ sends                 ▼
┌───────────────────────────────────────────┐      frontend/dist (static, Vite build)
│ API process   backend/src/index.js         │◄──── /api/* (axios, VITE_API_BASE_URL)
│  Express app (app.js)                      │
│  + in-process worker + scheduler           │      (WORKER_IN_PROCESS=true, the default)
└───────────────┬───────────────────────────┘
                │ pg Pool (DATABASE_URL, transaction pooler)
                ▼
┌───────────────────────────────────────────┐      ┌──────────────────────────────┐
│ PostgreSQL: domain tables + jobs (outbox),│◄─────│ Worker process (optional)    │
│ inbound_events, rate_limits, …            │ LISTEN│ backend/src/worker.js        │
└───────────────────────────────────────────┘ jobs │ (npm run worker)             │
                                                   └──────────────────────────────┘
           Workers call out to: Meta Graph API, Resend (email), Google Gemini (AI)
```

| Process | Entry | Start-up sequence | Notes |
|---|---|---|---|
| API | `backend/src/index.js` (`npm start`) | `assertProductionConfig()` → `testConnection()` → `assertSchemaUpToDate()` → listen on `PORT` → start the worker and scheduler when `WORKER_IN_PROCESS` is not `false` | Exits 1 if any start-up step fails. Never runs DDL. |
| Worker | `backend/src/worker.js` (`npm run worker`) | Same three checks, then `startWorker()` and `startScheduler()` | Any number may run (claims use `SKIP LOCKED`; schedules are deduped). Set `WORKER_IN_PROCESS=false` on the API when you use it. |
| Migrations | `backend/src/db/migrate.js` (`npm run migrate`) | Applies pending files | This is a deploy step. See [DATABASE.md](DATABASE.md). |

**Implemented.** The API refuses to start while migrations are pending, or when an applied migration file's checksum has changed.

---

## 2. Backend module layout

| Path | Contents |
|---|---|
| `src/core/` | Cross-cutting infrastructure:<br>• `config.js`: env and production checks<br>• `db.js`: pool, TLS, `withTransaction`, `connectDirect`<br>• `queue.js`: job queue<br>• `migrate.js`<br>• `logger.js`<br>• `errors.js`: `HttpError`, `errorMiddleware`<br>• `http.js`: `catchAsyncRoutes`, `validate`, `paged`<br>• `rbac.js`<br>• `money.js`<br>• `businessHours.js`<br>• `process.js`: signals<br>• `rateLimitStore.js` |
| `src/middleware/` | `auth.js` (`requireAuth`, `generateToken`) and `upload.js` (multer: roster `.xlsx`/`.csv` ≤ 5 MB; broadcast attachment JPG/PNG/WebP/PDF ≤ 20 MB) |
| `src/modules/<domain>/` | One folder per domain, usually `routes.js` → `controller.js` (Zod validation) → `service.js` (SQL):<br>`analytics`, `broadcasts`, `catalog`, `clients`, `conversations`, `jobs`, `meta`, `orders`, `payments`, `purchaseOrders`, `quotations`, `settings`, `staff`, `tickets`, `webhook` |
| `src/modules/lifecycle/` | Pure state machines (`machines.js`), stage guards (`guards.js`), SQL twins of the rules (`sql.js`), job-state derivation (`derive.js`) and next actions (`nextActions.js`) |
| `src/modules/bot/` | The WhatsApp bot:<br>• `router.js`: dispatch<br>• `reply.js`: transactional turn<br>• `states/*.js`: flows<br>• `templates.js`: client text<br>• `intents.js`, `gathering.js`, `lookups.js`, `profile.js`, `freeText.js` |
| `src/modules/notifications/` | `whatsapp.js` (outbox helpers, `TEMPLATE_FALLBACKS`) and `service.js` (staff emails) |
| `src/integrations/` | Thin clients:<br>• `whatsapp.client.js` (Meta Graph)<br>• `email.client.js` (Resend)<br>• `ai.client.js` (Gemini `gemini-2.5-flash`) |
| `src/workers/` | `loop.js` (claim, run, complete/fail), `scheduler.js` (recurring buckets), `handlers/*.js` (one per job type) |
| `src/db/` | `migrations/NNNN_*.sql`, `migrate.js`, guarded scripts (`reset.js`, `seed.js`, `seed-testing.js`, `safety.js`), `seed-catalog.js`, `backfill-needs-review.js` |
| `src/validators/` | Pure validators for quotations, purchase orders, clients and tickets |

---

## 3. Request path (`backend/src/app.js`)

`createApp()` builds the app in this order:

1. **`trust proxy`**: set from `TRUST_PROXY` when it is present. Rate limits need it behind a proxy to see real client IPs. **Requires external configuration.**
2. **`requestContext`** (`core/logger.js`): accepts a sane incoming `X-Request-Id` or mints one, echoes it in the response, and stores it in AsyncLocalStorage so every log line carries `requestId`.
3. **`helmet()`**: default security headers.
4. **CORS**:
   - In production, origins come from `CORS_ORIGINS` (falling back to `DASHBOARD_BASE_URL`).
   - Elsewhere, `localhost:5173` and `localhost:3001` are allowed.
   - `credentials: true`; `X-Request-Id` is exposed.
5. **General limiter** on `/api`: 1000 requests per 15 minutes per IP, counted **in memory** (per instance).
6. **`express.json({ limit: '1mb' })`**: keeps the raw bytes in `req.rawBody` for webhook signature checks. `/webhook` also accepts any other content type raw, through `express.raw`.
7. **Login limiter** on `/api/staff/login`:
   - 10 **failed** attempts per 15 minutes, keyed on `ip|email`.
   - Successful logins don't count.
   - Counted in Postgres (`rate_limits`, keys SHA-256 hashed) through `PgRateLimitStore`, so the limit holds across instances.
8. **`catchAsyncRoutes(router)`** (`core/http.js`, SEC-4): runs on every router before mounting. It wraps each route handler and router-level middleware so that a rejected promise or a synchronous throw reaches `next(err)` instead of becoming an unhandled rejection.
9. Routers are mounted at `/webhook` and `/api/*`. `GET /health` returns `{ status:'ok', service, timestamp }` and does **not** check the database. Unknown routes return 404 `{ error: 'Route not found' }`.
10. **`errorMiddleware`** (`core/errors.js`):

| Error | Response |
|---|---|
| `ZodError` | 400 with `validationBody` |
| `HttpError` | Its status, plus `{ error, ...extra }` (e.g. `code`) |
| body-parser errors | 400 malformed JSON, or 413 body too large |
| Mapped Postgres codes | `22P02`, `22007`/`22008`, `22001`, `22003` → 400<br>`23503` → 400<br>`23505` → 409 |
| Anything else | 500, logged with its stack |

**Authentication** (`middleware/auth.js`):

- Requests carry `Authorization: Bearer <HS256 JWT>`, signed with `JWT_SECRET` and expiring after `JWT_EXPIRES_IN` (default 8h).
- On every request the staff row is re-read (`is_active = true`), so deactivation and role changes apply immediately.
- If the database is unreachable during this check, the API returns **503**, not 401 (SEC-5).
- Role permissions are in `core/rbac.js` (see [BUSINESS_RULES.md](BUSINESS_RULES.md#8-roles-and-permissions)).

**Partially implemented:** a password change or reset doesn't revoke tokens that were already issued; they stay valid until they expire. Deactivation does revoke them.

---

## 4. Postgres job queue and outbox (`core/queue.js`, migration 0002)

Every side effect (WhatsApp send, email, PDF delivery, inbound processing) is a row in `jobs`.

| Mechanism | Behaviour |
|---|---|
| `enqueue(client, type, payload, { runAt, dedupeKey, queueKey, maxAttempts })` | Inserts on the **caller's client**. Pass the transaction client so the job commits or rolls back with the domain write (outbox).<br>`ON CONFLICT (dedupe_key) DO NOTHING`, so a duplicate key returns `null`.<br>`pg_notify('jobs', type)` wakes listeners on commit.<br>Default `max_attempts` is 8. |
| `claimBatch` | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` sets `status='running'`, `locked_by=<workerId>` and `attempts+1`.<br>Only jobs with `status='pending'` and `run_at <= now()` are claimed, ordered by `run_at, id`. |
| `queue_key` FIFO | A job is claimed only when no older job with the same `queue_key` is pending or running. Keys in use:<br>• `wa:<phone>`: inbound processing for one sender<br>• `out:<phone>`: outbound sends to one recipient<br>Broadcast sends have no queue key, so they never block bot replies. |
| Backoff | Retry *n* waits `min(2^n × JOB_BACKOFF_BASE_MS, 1h)` plus up to 1 s of jitter (base 5000 ms). |
| Dead-letter | `fail()` sets `status='dead'` when `attempts >= max_attempts`, or immediately for a `PermanentJobError` (`err.permanent`). An unknown job type is permanent. |
| Fencing (Q-1) | `complete()` and `fail()` update only `WHERE locked_by = <this worker> AND status='running'`. A slow first run of a reclaimed job can't overwrite the newer run. The loop logs `lost` in that case. |
| `reclaimStale` | Jobs left `running` for more than 5 min (`STALE_LOCK_MS`) go back to `pending`, or to `dead` if out of attempts. Runs every 60 s in the worker's maintenance pass. |
| `prune` | Deletes `done` jobs older than 14 days. Runs hourly, together with `pruneRateLimits` (rate-limit windows that ended more than 1 day ago). |
| `settleDeadSends` | Runs every maintenance pass. A `whatsapp.send` job that was dead-lettered without its final step gets its inbox row marked `failed` and its broadcast outcome counted. |

**Worker loop** (`workers/loop.js`):

- Concurrency is `WORKER_CONCURRENCY` (default 4).
- Wake-up comes from `LISTEN jobs` on a dedicated connection to `DATABASE_DIRECT_URL`, which the Supabase transaction pooler drops. Without a direct URL the worker only polls.
- A poll every `WORKER_POLL_MS` (default 1000 ms) runs regardless, as a safety net.
- A lost LISTEN connection is not re-established; polling continues.

**Job types** (`workers/handlers/index.js`):

| Type | Purpose |
|---|---|
| `inbound.process` | Run one bot turn for a stored webhook event |
| `message.status` | Apply a Meta delivery receipt |
| `whatsapp.send` | Send one message (text, document, image or template) |
| `quotation.pdf.send` | Render the PDF, upload it to Meta and send it as a document |
| `broadcast.fanout` | Expand one broadcast into per-recipient sends |
| `email.send` | Send a staff email through Resend (uses an `Idempotency-Key`) |
| `reminder.scan` | Unclaimed and unanswered reminders (scheduled) |
| `quotation.expire` | Persist `expired` on lapsed sent quotes (scheduled) |

**Dead jobs** are visible only in the `jobs` table and the logs. There is no UI to see or requeue them (**Not implemented**). See [DEPLOYMENT.md](DEPLOYMENT.md#11-recovery-procedures) for SQL requeue.

### Scheduler (`workers/scheduler.js`)

Every 60 s, each running instance enqueues the current time bucket for each schedule:

- `reminder.scan` and `quotation.expire`, every 30 min.
- `bucket = floor(now / 30 min)`, with `dedupeKey = '<type>:<bucket>'` and `maxAttempts = 3`.
- Each bucket runs exactly once across all instances.
- Both handlers also take `pg_try_advisory_xact_lock`, so two runs never overlap.

---

## 5. Graceful shutdown (`core/process.js`)

On `SIGTERM` or `SIGINT`, `drain()` runs once:

- **API:** `server.close()` (stop accepting connections), then stop the scheduler, then `worker.stop({ timeoutMs: WORKER_DRAIN_MS })`, then `pool.end()`.
- **Worker:** the same, without the HTTP server.

The process then exits 0. It exits 1 in either of these cases:

- A second signal arrives.
- The drain takes longer than `WORKER_DRAIN_MS + 5 s` (default 25 s + 5 s). Set the platform's kill grace period above this.

`unhandledRejection` and `uncaughtException` are logged with their stack, and the process exits 1 so the platform restarts it.

A bot turn cut off mid-run is safe to replay (see [WHATSAPP_FLOW.md](WHATSAPP_FLOW.md#replay-idempotency-dat-2)). A job still running when the process exits stays `running` until `reclaimStale` returns it to `pending` after 5 min.

---

## 6. Logging and redaction (`core/logger.js`)

- Winston writes to stdout: JSON with a timestamp in production, colourised text elsewhere. The level is set by `LOG_LEVEL` (default `info`).
- Each line carries the `requestId` (HTTP) or `jobId` (worker) from AsyncLocalStorage.
- **Redaction** runs on the message and on all metadata, up to 5 levels deep:

| Data | Logged as |
|---|---|
| JWTs | `[jwt]` |
| Emails | `a***@domain` |
| Runs of 9–15 digits (phone numbers) | e.g. `27*******567` |
| Values of `body`, `text`, `caption`, `messageBody`, `description`, `password`, `password_hash`, `token`, `authorization` | `[redacted]` |

- `core/db.js` logs failed queries with their first line only, never the parameters.

---

## 7. Frontend (`frontend/`)

| Concern | Implementation |
|---|---|
| Stack | Vite 5, React 18, antd 5, TanStack React Query 5, react-router 6, axios, dayjs. |
| Build | `npm run dashboard:build` produces `frontend/dist`. Route pages are lazy-loaded; vendor chunks are `react`, `antd` and `vendor`. The antd chunk is about 1 MB minified. |
| API client (`src/api/client.js`) | `baseURL = VITE_API_BASE_URL ?? '/api'` with a 30 s timeout.<br>Adds `Bearer` from `localStorage.braq_token`.<br>A **401** (except on the login call) clears the token and redirects to `/login`.<br>A **503** keeps the session. |
| Auth (`src/auth/AuthContext.jsx`) | Stores `braq_token` and `braq_staff` in `localStorage`. Logging in clears the React Query cache. Logout is client-side only. `ProtectedRoute` guards every page except `/login`. |
| Permissions | `GET /api/meta` returns lifecycle vocabulary, business numbers, `role` and `permissions`. `useCan` and `useMeta` hide actions the caller can't perform. |
| Errors | `components/ErrorBoundary.jsx` wraps the whole app (`fullPage`) and individual pages. It shows a Reload card. A failed lazy-chunk load (dashboard redeployed) shows "The dashboard has been updated". |
| Data | React Query defaults: `retry: 1`, `staleTime: 30s`, no refetch on focus, polling paused in background tabs. |
| Payments | `lib/idempotency.js` creates one key per "Record payment" submission and sends it as `idempotencyKey`. |
| Dev | Vite dev server on port 5173 proxies `/api` to `http://localhost:3000`. |

Main routes: `/`, `/inbox`, `/jobs`, `/jobs/:quotationId`, `/purchase-orders`, `/tickets`, `/clients`, `/products`, `/school-catalog`, `/staff`, `/broadcasts`, `/analytics`. `/quotations` and `/orders` redirect to the Jobs board.

**Partially implemented (security posture):** the JWT lives in `localStorage`, which an XSS can read, and logout doesn't invalidate the token on the server.
