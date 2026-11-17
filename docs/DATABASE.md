# Braq Connect: Database

The database is PostgreSQL (Supabase in production). The schema is defined only by the versioned files in `backend/src/db/migrations/`; nothing else runs DDL.

Status labels: **Implemented**, **Partially implemented**, **Not implemented**, **Requires external configuration**, **Requires manual business verification**.

---

## 1. Enums (`0001_baseline.sql`)

| Type | Values |
|---|---|
| `client_type` | retail, school, corporate, hospitality, church, security, government, reseller |
| `staff_role` | admin, consultant, manager |
| `quotation_status` | draft, sent, accepted, rejected, expired |
| `ticket_category` | wrong_item, defective, missing_item, account_query, other |
| `ticket_status` | open, in_progress, resolved, closed |
| `payment_type` | deposit, balance, full |
| `product_category` | school_wear, knitwear, medical_wear, outdoor_wear, corporate_wear, safety_wear |
| `message_direction` | inbound, outbound |
| `message_status` | sent, delivered, read, failed. *Unused:* `messages.status` is a TEXT column added in 0003. |

The following are **TEXT** columns (no enum):

| Column | Values | Constraint |
|---|---|---|
| `orders.stage` | — | CHECK, migration 0006 |
| `orders.payment_status` | — | CHECK, migration 0006 |
| `orders.proof_status` | — | CHECK, migration 0006 |
| `conversations.state` | — | none |
| `messages.status` | queued, sent, delivered, read, failed, needs_template | none |
| `broadcasts.status` | queued, sending, done | none |
| `jobs.status` | — | CHECK |

---

## 2. Tables and key columns

| Table | Key columns / purpose |
|---|---|
| `staff` | `email` UNIQUE (stored lower-case), `password_hash` (bcrypt cost 12), `role`, `is_active`. Access is removed by deactivation; rows are never deleted. |
| `clients` | `whatsapp_number` UNIQUE, `customer_number` UNIQUE (`C-0001`), `client_type`, profile fields, `account_terms`, `account_terms_set_by`, `account_terms_set_at` (0009) |
| `conversations` | `client_id`, `state` (bot state), `context` JSONB, `is_open`, `assigned_staff_id`, `claimed_at`, `notified_at`, `reminder_sent_at`, `last_message_at`, `unanswered_reminder_at` (0013) |
| `messages` | `conversation_id`, `client_id`, `direction`, `body`, `meta_message_id` UNIQUE, `is_read_by_staff`, `status`, `job_id` UNIQUE (0003), `sent_by_staff_id` (0009), `ticket_id`, `media_id` (0010) |
| `products` | `category`, `name`, `school_name`, `sizes` JSONB, `price` NUMERIC(10,2) **excl. VAT**, `currency`, `is_active` |
| `school_catalog` | Per-school price list: `school_name`, `uniform_type`, `sizes`, `price`, `sort_order`, `is_active`. Deleting an entry is a hard delete. |
| `quotations` | See the detail below this table. |
| `orders` | See the detail below this table. |
| `order_stage_history` | `order_id`, `stage`, `from_stage`, `changed_by`, `notes`, `override_reason`, `overridden_guards` TEXT[] (0003) |
| `order_size_entries` | Size roster rows: `person_name`, `size`, `notes` |
| `payments` | `order_id` (ON DELETE CASCADE), `type`, `amount` NUMERIC(12,2), `currency`, `notes`, `recorded_by`, `idempotency_key` (0011) |
| `purchase_orders` | `quotation_id`, `order_id`, `po_number`, `status` CHECK ∈ pending_review/valid/invalid, `validated_by`, `notes`. Every submission is kept as an audit trail. |
| `tickets` | `client_id`, `order_id`, `category`, `status`, `description`, `sla_due_at`, `resolved_at`, `resolution_note` (0003), `assigned_staff_id`, `claimed_at`, `notified_at`, `reminder_sent_at`, `source_event_id` (0012) |
| `broadcasts` | `sent_by`, `message_type`, `body`, `recipient_count`, `status`, `sent_count`, `failed_count` (0003) |
| `broadcast_outcomes` | `job_id` PK, `broadcast_id`, `outcome` CHECK ∈ sent/failed (0014) |
| `job_events` | Timeline events without a table of their own: `quotation_id`, `order_id`, `type`, `actor_id`, `data` (0007) |
| `jobs` | Queue/outbox: `type`, `payload`, `status` CHECK ∈ pending/running/done/dead, `queue_key`, `run_at`, `attempts`, `max_attempts`, `locked_at`, `locked_by`, `last_error`, `dedupe_key` UNIQUE, `finished_at` (0002) |
| `inbound_events` | Webhook log: `meta_message_id` UNIQUE, `phone`, `kind`, `payload`, `processed_at` (0002) |
| `rate_limits` | `key` PK (SHA-256 hash), `count`, `reset_at` (0008) |
| `settings` | Key/value; seeded with `busy_mode='false'` |
| `sequence_counters` | `(key, date_key)` PK. Generates `customer` (`C-0001`), `order` (`BRQ-O-00001`, global) and `quotation` (`BRQ-Q-<SA date>-0001`, per day) references. |
| `schema_migrations` | `version`, `name`, `checksum` (SHA-256 of the LF-normalised file), `applied_at` |

**`quotations` columns:**

- `reference` UNIQUE, VARCHAR(60) since 0009.
- `client_id` ON DELETE RESTRICT.
- `status`, `line_items` JSONB.
- `subtotal`, `vat`, `total` NUMERIC(12,2).
- `valid_until` DATE, `sla_remind_at`, `reminder_sent_at`.
- `approved_by`, `approved_at`, `auto_quoted`, `needs_review`.
- `assigned_staff_id`, `claimed_at`, `notified_at`, `staff_reminder_sent_at`.
- `conversation_id` (0003), `source_event_id` (0012).

**`orders` columns:**

- `reference` UNIQUE, `client_id` ON DELETE RESTRICT, `quotation_id`.
- `stage`, `is_on_hold`, `hold_reason`.
- `payment_status`, `total_amount` (0003), `deposit_amount`, `balance_amount`.
- `proof_url`, `proof_status`, `proof_notes`, `proof_sent_at`.
- `estimated_completion_date`, `tracking_number`, `delivery_type`, `cancelled_at` (0003).
- `material_notes` JSONB, `assigned_staff_id`, `conversation_id`.

All money columns are NUMERIC rands. Application arithmetic is done in integer cents (`core/money.js`). `updated_at` triggers exist on staff, clients, conversations, products, school_catalog, quotations, orders, purchase_orders and tickets.

---

## 3. Constraints and indexes that protect business invariants

| Object | Definition | Invariant | Status |
|---|---|---|---|
| `uniq_orders_quotation` | UNIQUE `orders(quotation_id) WHERE quotation_id IS NOT NULL` (0001) | One order per quotation. A concurrent conversion loses with 23505, returned as 409. Bot direct-order replays are also keyed through it. | **Requires manual verification on production** (see below) |
| `uniq_open_conversation_per_client` | UNIQUE `conversations(client_id) WHERE is_open` (0001) | One open chat per client. `bot/state.js` uses `ON CONFLICT … DO NOTHING`. | **Requires manual verification on production** |
| `orders_stage_check` | stage ∈ 4 canonical stages + 11 legacy values + `cancelled` (0006) | No unknown stage | **Requires manual verification on production** |
| `orders_payment_status_check` | ∈ unpaid, deposit_paid, paid_in_full, deposit_required, not_required (0006) | Known payment status | **Requires manual verification on production** |
| `orders_proof_status_check` | ∈ none, sent, approved, revision_requested (0006) | Known proof status | **Requires manual verification on production** |
| `uniq_payments_order_idempotency` | UNIQUE `payments(order_id, idempotency_key) WHERE idempotency_key IS NOT NULL` (0011) | A retried "Record payment" submission is never stored twice | Implemented |
| `payments_amount_positive` | CHECK `amount > 0`, added NOT VALID, then VALIDATEd only when no row has `amount <= 0` (0011) | Payments are positive | Enforced for all new or updated rows. Validated only if historical data is clean (otherwise a NOTICE and left NOT VALID). Check `pg_constraint.convalidated`. |
| `uniq_quotations_source_event` | UNIQUE `quotations(source_event_id) WHERE NOT NULL` (0012) | A replayed bot turn never creates a second quotation | Implemented |
| `uniq_tickets_source_event` | UNIQUE `tickets(source_event_id) WHERE NOT NULL` (0012) | A replayed bot turn never creates a second ticket | Implemented |
| `messages.meta_message_id` UNIQUE | (0001) | A WhatsApp message is stored once (duplicate deliveries roll back the turn) | Implemented |
| `messages.job_id` UNIQUE | (0003) | One inbox row per send job (send idempotency) | Implemented |
| `inbound_events.meta_message_id` UNIQUE | (0002) | Webhook dedupe by Meta message id | Implemented |
| `jobs.dedupe_key` UNIQUE | (0002) | Outbox dedupe (one deposit message per order, one schedule per bucket, …) | Implemented |
| `broadcast_outcomes.job_id` PK | (0014) | Each broadcast send is counted once | Implemented |
| `quotations.reference`, `orders.reference`, `clients.whatsapp_number`, `clients.customer_number`, `staff.email` | UNIQUE | Unique business identifiers | Implemented |
| `purchase_orders.status`, `jobs.status`, `broadcast_outcomes.outcome` | CHECK | Known statuses | Implemented |

**Requires manual verification on production (pg_indexes / pg_constraint).** Migration 0001 creates `uniq_orders_quotation` and `uniq_open_conversation_per_client` inside `EXCEPTION WHEN unique_violation` handlers. If duplicate rows already exist, it raises a NOTICE instead of creating the index.

Migration 0006 works differently: it adds each CHECK only when no existing row violates it, otherwise it raises a NOTICE and skips it. It uses a conditional, not an exception handler.

On a database whose existing rows violated these rules, the objects can be **absent** while `schema_migrations` still records the migration as applied. Check with:

```sql
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('uniq_orders_quotation','uniq_open_conversation_per_client');
SELECT conname, convalidated FROM pg_constraint
 WHERE conname IN ('orders_stage_check','orders_payment_status_check',
                   'orders_proof_status_check','payments_amount_positive');
```

If any are missing:

1. Clean up the duplicate or invalid rows.
2. Create the missing objects in a **new** migration. Never edit an applied migration.

Other indexes are for read paths:

| Migration | Indexes |
|---|---|
| 0001 | Client, status, SLA and unclaimed partial indexes |
| 0002 | `idx_jobs_ready`, `idx_jobs_queue_key`, `idx_jobs_running` |
| 0005 | Built `CONCURRENTLY`: `idx_messages_conversation_created`, `idx_conversations_last_message`, `idx_orders_created`, `idx_tickets_order`, `idx_quotations_assigned_staff` |
| 0007 | `job_events` indexes |
| 0008 | `rate_limits.reset_at` |
| 0014 | `broadcast_outcomes.broadcast_id` |

Foreign keys to `clients` from quotations, orders and tickets are `ON DELETE RESTRICT`. There is no client-delete endpoint.

---

## 4. Migrations

| File | Summary |
|---|---|
| `0001_baseline.sql` | Idempotent baseline: all enums, the original tables, upgrade `ADD COLUMN IF NOT EXISTS`es, indexes, `updated_at` triggers, seed rows (`busy_mode`, counters), and the two guarded unique indexes (NOTICE on duplicates). |
| `0002_queue.sql` | `jobs` queue/outbox table with claim indexes; `inbound_events` webhook log. |
| `0003_columns.sql` | Additive nullable columns:<br>• orders: `total_amount`, `conversation_id`, `delivery_type`, `cancelled_at`<br>• quotations: `conversation_id`<br>• messages: `status`, `job_id` UNIQUE<br>• order_stage_history: `from_stage`, `override_reason`, `overridden_guards`<br>• broadcasts: progress counters<br>• tickets: `resolution_note` |
| `0004_backfill.sql` | Re-runnable backfills:<br>• `orders.total_amount` from the quote total or from the deposit/balance bookkeeping<br>• `tickets.order_id` when the client has exactly one order |
| `0005_indexes.sql` | `-- migrate:no-transaction`. Hot-path indexes `CREATE INDEX CONCURRENTLY`. Drops duplicates of the UNIQUE-backed indexes. An interrupted build leaves an INVALID index: drop it `CONCURRENTLY` and re-run. |
| `0006_checks.sql` | CHECKs on `orders.stage`, `payment_status` and `proof_status` (canonical + legacy values). Added NOT VALID, then VALIDATEd, only when the data is clean. |
| `0007_job_events.sql` | `job_events` timeline table (quote sent/accepted/declined/revised/resent, proof events, PO recorded, ticket resolved). |
| `0008_rate_limits.sql` | `rate_limits` table for the shared login limiter. |
| `0009_staff_ux.sql` | `clients.account_terms` (+ set_by/set_at), `messages.sent_by_staff_id`, `quotations.reference` widened to VARCHAR(60). Creates accepted `BRQ-Q-LEGACY-<order ref>` quotations for orders that had none and links them; VAT is derived as total/1.15. |
| `0010_bot_ux.sql` | `messages.ticket_id` (photos linked to tickets), `messages.media_id`. |
| **`0011_payment_integrity.sql`** | `payments.recorded_by` (FK staff, SET NULL), `payments.idempotency_key` + partial unique index `uniq_payments_order_idempotency`, CHECK `payments_amount_positive` (NOT VALID → validated when the data is clean). |
| **`0012_bot_idempotency.sql`** | `quotations.source_event_id` and `tickets.source_event_id` (BIGINT, no FK) with partial unique indexes. Bot replay idempotency (DAT-2). |
| **`0013_unanswered_chat_reminder.sql`** | `conversations.unanswered_reminder_at`: one owner reminder per unanswered client message in `consultant_active` chats (MSG-2). |
| **`0014_broadcast_outcomes.sql`** | `broadcast_outcomes(job_id PK, broadcast_id, outcome)`: idempotent per-send broadcast counting (MSG-5). No FK to `jobs`, because jobs are pruned. |

---

## 5. Migration runner (`backend/src/core/migrate.js`)

- Files must match `NNNN_name.sql` and are applied in version order. Each applied file is recorded in `schema_migrations` with a SHA-256 checksum, computed after normalising CRLF to LF.
- **Advisory lock:** `pg_advisory_lock(hashtext('braq:migrate'))` on a direct connection (`DATABASE_DIRECT_URL`, else `DATABASE_URL`). Concurrent deploys wait for each other.
- **One transaction per file**, with `SET LOCAL lock_timeout = '5s'`. If a file fails, it is rolled back and the run stops.
- A file whose first line is `-- migrate:no-transaction` runs statement by statement outside a transaction. It must not use dollar-quoting, and each statement must end with `;` at the end of a line.
- **Checksums:** if an applied file has changed on disk, both `migrate` and API start-up fail. Never edit an applied migration; add a new one.
- `RAISE NOTICE` output (e.g. a skipped index) is logged as a warning, so read the migrate log on every deploy.
- **Boot guard:** `assertSchemaUpToDate()` (API and worker) throws when anything is pending: "Run `npm run migrate` before starting the server."

---

## 6. Guarded maintenance scripts (`backend/src/db/`)

`safety.js` treats a target as **production** when either of these holds:

- `NODE_ENV=production`.
- The `DATABASE_URL` host matches `supabase.(co|com|net)`, or the URL contains "supabase".

| Script | Command | Guard |
|---|---|---|
| `reset.js` | `npm run db:reset` (passes `--yes-wipe-everything`) | Refuses unless all of these hold:<br>• the flag is given<br>• `NODE_ENV` is not production<br>• the host is not Supabase<br>• the host is local, or `--allow-remote-host` is given<br>Drops the listed tables and types, then re-runs every migration. **Partially implemented:** its DROP list omits `job_events`, `rate_limits` and `broadcast_outcomes`, so those tables survive a reset. |
| `seed.js` | `npm run seed` | Creates the first admin (`SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`). Skips if the email already exists. Against production it requires `SEED_ADMIN_PASSWORD` of at least 12 characters that is not `changeme123`. Locally it falls back to `changeme123` with a warning. |
| `seed-testing.js` | `npm run seed:testing` | Demo data, with staff password `Braq@2025!`. **Refuses any production target.** |
| `seed-catalog.js` | `npm run seed:catalog` | Inserts placeholder products with `price = 0`. **No production guard.** Zero-priced catalogue items would be auto-quoted at R 0.00. Run against production only deliberately, and price the items before go-live. |
| `backfill-needs-review.js` | `npm run backfill` | Sets the `needs_review` flag on orders and quotations. No production guard. Writes only that flag. |
| `migrate.js` | `npm run migrate` | Non-destructive and safe on production. This is the deploy step. |

Never run tests or seeds against `backend/.env` when it points at production. The test suites create their own throwaway embedded Postgres (see [DEPLOYMENT.md](DEPLOYMENT.md#13-tests)).
