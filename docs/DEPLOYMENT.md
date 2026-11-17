# Braq Connect: Deployment and Operations

This document covers configuration, the deploy procedure, recovery and the pre-go-live checklist.

Status labels: **Implemented**, **Partially implemented**, **Not implemented**, **Requires external configuration**, **Requires manual business verification**.

> `backend/.env` in the working copy points at the **production** database. Never run tests, seeds or `db:reset` with it. The test suites use their own throwaway Postgres.

---

## 1. Environment variables (`backend/src/core/config.js`, `backend/.env.example`)

### Required in production

With `NODE_ENV=production`, both the API and the worker call `assertProductionConfig()` at start-up. It refuses to start and lists **every** problem from `productionConfigProblems(env)`. A value that still holds an `.env.example` placeholder (`your_…`, `re_your_…`, `your-project-ref`) counts as missing.

| Variable | Rule |
|---|---|
| `DATABASE_URL` | Required. Supabase **transaction pooler** URL (port 6543). |
| `META_APP_SECRET` | Required. Verifies webhook signatures. |
| `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID` | Required. Used to send WhatsApp messages. |
| `META_WEBHOOK_VERIFY_TOKEN` | Required, and must not be the built-in default `braquni_verify` |
| `JWT_SECRET` | Required, at least **32 characters**, and not the dev default or a placeholder. `config.js` also throws on import when it is unset in production, which affects scripts too. |
| `GEMINI_API_KEY` | Required. AI routing and parsing. |
| `RESEND_API_KEY` | Required. Staff emails. |
| `DASHBOARD_BASE_URL` | Required. Used for email links and as the default CORS origin. |
| `DB_SSL_MODE` | If set, it must be `verify`. Unset means `verify` in production. |
| `WHATSAPP_WINDOW_CHECK` | Must not be `off` (that setting is for tests only) |

Scripts (`migrate`, `seed`) don't run this check, but they still need the database variables (and `JWT_SECRET` when `NODE_ENV=production`).

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | Set to `production` in production |
| `PORT` | 3000 | API port |
| `API_BASE_URL` | `http://localhost:3000` | Used only in the start-up log line |
| `DATABASE_DIRECT_URL` | — | Session/direct URL for the worker's `LISTEN jobs` and the migration advisory lock. Without it the worker polls only, and migrations use `DATABASE_URL`. |
| `DB_SSL_MODE` / `DB_SSL_CA` | verify (production) / no-verify (elsewhere) | `DB_SSL_CA` is a PEM file path, or the PEM text itself (`\n` escapes are allowed) |
| `DB_CONNECT_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | 15000 / 120000 | Pool connect and statement timeouts |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | localhost… | Used only when `DATABASE_URL` is empty |
| `META_API_VERSION` | v20.0 | Graph API version. (`META_APP_ID` is read but unused.) |
| `JWT_EXPIRES_IN` | 8h | Session length |
| `FROM_EMAIL` | `notifications@braquni.com` | Resend sender. **Requires external configuration:** the domain must be verified in Resend. |
| `NOTIFICATION_OVERRIDE_EMAIL` | — | Routes every email to one inbox. Use it only before the domain is verified. |
| `CORS_ORIGINS` | `DASHBOARD_BASE_URL` | Comma-separated origins allowed in production |
| `TRUST_PROXY` | off | Set to `1` (or a hop count or name) behind a load balancer or reverse proxy, so rate limits see real IPs |
| `LOG_LEVEL` | info | Winston level |
| `WORKER_IN_PROCESS` | true | Set `false` when you run `npm run worker` separately |
| `WORKER_POLL_MS`, `WORKER_CONCURRENCY`, `JOB_BACKOFF_BASE_MS` | 1000, 4, 5000 | Queue tuning |
| `WORKER_DRAIN_MS` | 25000 | How long running jobs may finish on SIGTERM. The process hard-exits at drain + 5 s. |
| `BROADCAST_RATE_PER_SEC` | 20 | Broadcast send rate |
| `AI_TIMEOUT_MS` | 20000 | Gemini timeout per call |
| `WHATSAPP_TEMPLATES` | — | JSON map of logical name → approved template (see §6). **Strongly recommended.** |
| `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin / `admin@braquni.com` / — | First admin (§4) |

**Frontend:** `VITE_API_BASE_URL` (see `frontend/.env.example`), e.g. `https://api.example.com/api`. It is baked in at build time and defaults to `/api` (same-origin, or the Vite dev proxy).

## 2. Supabase setup

1. **`DATABASE_URL`**: Project Settings → Database → Connection string → **Transaction pooler** (port 6543). URL-encode special characters in the password. `?family=4` forces IPv4.
2. **`DATABASE_DIRECT_URL`**: the **session** pooler (port 5432) or the direct connection. The transaction pooler doesn't support `LISTEN` or session advisory locks.
3. **TLS**:
   - Download the CA from Project Settings → Database → SSL configuration.
   - Set `DB_SSL_MODE=verify` and `DB_SSL_CA=<path or PEM>`.
   - Production refuses `no-verify` and `disable`. An unverifiable certificate fails start-up with a clear "Set DB_SSL_CA" message.
   - Any `ssl*` parameters in the URL (e.g. `sslmode=require`) are **stripped**: `DB_SSL_MODE` is the single source of truth.
4. **Backups** (**Requires external configuration**): enable Supabase daily backups or PITR on a suitable plan. **Test a restore** into a scratch project before go-live, and periodically after.

## 3. Migrations (deploy step)

```bash
npm run migrate            # from repo root (or backend/)
```

- Run this **before** starting the new API or worker version. Neither starts while migrations are pending, or when an applied file's checksum changed.
- It is safe to run concurrently: an advisory lock serialises the runs.
- Each file is its own transaction, with `lock_timeout` 5 s. If a file fails, it rolls back and the deploy stops.
- **Read the migrate log for NOTICE warnings.** Then verify the guarded indexes and CHECKs as described in [DATABASE.md](DATABASE.md#3-constraints-and-indexes-that-protect-business-invariants).

## 4. First admin

```bash
SEED_ADMIN_NAME="…" SEED_ADMIN_EMAIL=admin@yourdomain SEED_ADMIN_PASSWORD='<≥12 chars>' npm run seed
```

- Against production (`NODE_ENV=production` or a Supabase host), the password is required, must be at least 12 characters, and must not be the local default `changeme123`.
- The script skips an email that already exists.
- **Never** run `seed:testing` (it refuses production) or `seed:catalog` (no guard; inserts R 0 products) on production unless you intend it.
- After you sign in, change the password with `POST /api/staff/me/password`, and create other staff through the dashboard.

## 5. Starting processes

| Topology | Commands |
|---|---|
| Single process (default) | `npm start`: the API runs with the in-process worker and scheduler |
| Separate worker(s) | API with `WORKER_IN_PROCESS=false` and `npm start`. Then one or more `npm run worker`. |

- **Health check:** `GET /health` returns `200 {"status":"ok",…}`. It only shows the HTTP server is up; it doesn't check the database. The process exits at start-up if the database, migrations or config are wrong.
- **Graceful shutdown:** on SIGTERM the HTTP server stops accepting connections, running jobs get `WORKER_DRAIN_MS`, then the pool closes and the process exits 0. Set the platform's kill grace period **above `WORKER_DRAIN_MS` + 5 s** (default 30 s). Bot turns cut off mid-run are replayed safely.
- **Proxy:** behind Render, Nginx or a load balancer, set `TRUST_PROXY=1`. Otherwise all users share one rate-limit bucket.

## 6. Meta WhatsApp setup (Requires external configuration)

1. Create a Meta app with WhatsApp. Note the phone number id and a **permanent** system-user token. Set the `META_*` variables.
2. Webhook: callback URL `https://<api>/webhook`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribed to the **messages** field. The app secret goes in `META_APP_SECRET`; unsigned or invalid POSTs get 401.
3. **Templates:** register the Utility templates listed in README "WhatsApp message templates":
   - `order_stage`, `payment_received`, `proof_ready`, `ticket_resolved`, `quote_ready` (document header), `consultant_reply`, `order_delay`
   - `quote_expiring` is defined but unused

   After Meta approves them, set:
   ```
   WHATSAPP_TEMPLATES={"order_stage":"braq_order_stage","quote_ready":{"name":"braq_quote_ready","language":"en"},…}
   ```
   **Without them, business-initiated messages to clients who haven't written in 24 h are NOT delivered.** They are marked `needs_template`, and staff are emailed.
4. Meta retries webhooks that don't get a 200. The API returns 500 when it can't store events, and duplicate deliveries are dropped by `meta_message_id`. A short API outage therefore loses no messages, within Meta's retry window.

## 7. Frontend build

```bash
VITE_API_BASE_URL=https://<api>/api npm run dashboard:build    # → frontend/dist
```

- Serve `frontend/dist` as static files, with an SPA fallback that serves `index.html` for unknown paths (the app uses BrowserRouter).
- Add the dashboard origin to `CORS_ORIGINS` (or `DASHBOARD_BASE_URL`).
- After a redeploy, open tabs show "The dashboard has been updated" when a lazy chunk is missing.

## 8. Logs and monitoring

- Production logs are JSON on stdout, with PII redacted and a `requestId` or `jobId` on each line.
- **Not implemented:** metrics, alerting, and a dead-job dashboard. Watch for `job dead-lettered` and `Unhandled error` log lines, and query `jobs` (§9).

## 9. Useful SQL

```sql
-- Queue health
SELECT status, type, COUNT(*) FROM jobs GROUP BY 1,2 ORDER BY 1,2;
-- Dead jobs with their last error
SELECT id, type, attempts, last_error, finished_at FROM jobs WHERE status='dead' ORDER BY id DESC LIMIT 50;
-- Messages awaiting a template
SELECT id, conversation_id, created_at FROM messages WHERE status='needs_template' ORDER BY created_at DESC;
```

## 10. Rotating secrets

| Secret | Procedure |
|---|---|
| `JWT_SECRET` | Change it and restart. Every staff session is invalidated, and everyone signs in again. |
| `META_APP_SECRET` | Rotate in Meta, update the env var, and restart promptly. Webhooks signed with the old secret get 401 until then, and Meta retries them. |
| `META_WHATSAPP_TOKEN` | Generate a new system-user token, update it and restart. Sends that fail meanwhile retry (code 190 is retryable). |
| `RESEND_API_KEY`, `GEMINI_API_KEY` | Rotate with the provider, update and restart |
| Database password | Rotate in Supabase, update both URLs and restart |
| Staff password | `PATCH /api/staff/:id {password}` (admin) or `POST /api/staff/me/password`. Existing tokens stay valid until they expire; rotate `JWT_SECRET` to force everyone out. |

## 11. Recovery procedures

- **Database restore:** restore the Supabase backup or PITR, then run `npm run migrate` (it applies any newer files), then start the API and worker.
  - Jobs that were `running` at the snapshot are reclaimed after 5 min.
  - Expect some outbound messages to be re-sent (at-least-once delivery).
- **Requeue dead jobs** after fixing the cause (e.g. a template or token). Choose specific ids:

```sql
BEGIN;
UPDATE jobs
   SET status = 'pending', attempts = 0, run_at = now(),
       locked_at = NULL, locked_by = NULL, finished_at = NULL
 WHERE status = 'dead' AND id IN (101, 102, 103)   -- the chosen ids
RETURNING id, type;
COMMIT;
SELECT pg_notify('jobs', 'requeue');
```

  For a requeued `whatsapp.send` whose inbox row was marked `failed`, the handler retries the send; the row becomes `sent` on success.

- **Webhook outage:** no action is needed. Meta retries with backoff, and duplicates are deduped. For events stored but not processed, check `inbound_events WHERE processed_at IS NULL` and the matching `inbound.process` jobs.
- **Stuck `running` jobs:** these are reclaimed automatically after 5 min.

## 12. Pre-go-live checklist

- [ ] `NODE_ENV=production`, and every required variable is set (the API starts without the "Unsafe production configuration" error).
- [ ] `DB_SSL_MODE=verify` with `DB_SSL_CA` = the Supabase CA. The start-up log shows `ssl: verified`.
- [ ] `DATABASE_DIRECT_URL` is set to the session or direct URL. The log shows "worker listening for job notifications".
- [ ] `npm run migrate` ran cleanly. NOTICEs were reviewed, and the guarded indexes and CHECKs verified with `pg_indexes`/`pg_constraint`.
- [ ] The first admin was seeded with a strong password. No demo staff (`*@braquni.com`, `Braq@2025!`) exist in `staff`.
- [ ] Catalogue prices are real (no R 0 products) and active flags are correct.
- [ ] Meta webhook verified, `META_APP_SECRET` set, and a test message round-trips.
- [ ] WhatsApp templates approved and `WHATSAPP_TEMPLATES` set. Test a message to a client silent for more than 24 h.
- [ ] Resend domain verified, `FROM_EMAIL` set, `NOTIFICATION_OVERRIDE_EMAIL` **removed**.
- [ ] Consultant accounts exist with real emails (default notifications go to role `consultant` only).
- [ ] `TRUST_PROXY` and `CORS_ORIGINS` set for the hosting topology. The dashboard is built with the right `VITE_API_BASE_URL`.
- [ ] The platform kill grace period is above `WORKER_DRAIN_MS` + 5 s. The health check points at `/health`.
- [ ] Supabase backups or PITR enabled, and a test restore done.
- [ ] Business owner has signed off the "Requires manual business verification" items in [BUSINESS_RULES.md](BUSINESS_RULES.md#9-requires-manual-business-verification).

## 13. Tests

Every suite uses a **throwaway embedded PostgreSQL** in a temp directory, with fakes for Meta, Resend and Gemini. **Never point tests at production.**

| Command (repo root) | Scope |
|---|---|
| `npm test` | Backend unit tests (pure logic, no database) |
| `npm run test:integration` | Services, queue and migrations in-process against embedded Postgres |
| `npm run test:blackbox` | The real API over HTTP against embedded Postgres (`migrate` + `seed`), external services faked |
| `npm run test:frontend` | Frontend API-contract tests plus headless Microsoft Edge E2E against a throwaway backend |
| `npm run test:coverage --workspace=backend` | Unit tests with coverage |
