# Braq Connect™ — WhatsApp Platform

A WhatsApp-based client communication and order management platform for Braq Uni.

---

## Architecture

```
braquni/
├── backend/              ← Node.js API + WhatsApp bot
│   └── src/
│       ├── index.js          ← Boot: checks the schema version (runs NO DDL), listens, starts the worker
│       ├── app.js            ← createApp() — the Express app
│       ├── worker.js         ← Standalone job worker (`npm run worker`)
│       ├── core/             ← config, logger (request id + PII redaction), db, errors, http,
│       │                       money (VAT / deposit / validity / SLA), rbac, queue, migrate
│       ├── modules/<domain>/ ← routes / controller / service per domain (orders, quotations,
│       │                       payments, purchaseOrders, clients, tickets, staff, analytics,
│       │                       catalog, settings, conversations, broadcasts, webhook, bot, notifications)
│       ├── integrations/     ← WhatsApp, email (Resend) and Gemini clients
│       ├── workers/          ← Job loop, scheduler and job handlers
│       ├── db/               ← migrations/NNNN_*.sql, migrate / reset / seed scripts
│       ├── middleware/       ← JWT auth, uploads
│       └── validators/       ← Pure completeness validators (needs_review)
│       (controllers/, routes/, services/, config/, utils/ hold temporary re-export shims)
│   └── tests/            ← unit/ (pure), integration/ (in-process + throwaway Postgres),
│                           blackbox/ (real API + throwaway Postgres)
└── frontend/             ← React staff dashboard (Vite)
    └── tests/            ← API contract + headless browser E2E
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js v22+ (ESM) |
| Framework | Express.js |
| Database | PostgreSQL |
| WhatsApp | Meta Cloud API |
| Auth | JWT (jsonwebtoken) |
| Validation | Zod |
| Logging | Winston |
| Security | Helmet, CORS, rate limiting |
| AI (FAQ + quotation parsing) | Gemini API (`gemini-2.5-flash`) |
| PDF generation | pdfkit |
| File uploads | multer (memory storage) |
| Bulk size-roster parsing | exceljs (.xlsx), csv-parse (.csv) |

---

## Quick Start

### 1. Prerequisites
- Node.js 22+
- PostgreSQL 14+ (production runs on Supabase)
- A Meta developer account with WhatsApp Business API set up

### 2. Clone and install
```bash
git clone <your-repo>
cd braquni
npm install
```

### 3. Configure environment
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Fill in your values in each .env
```

### 4. Create the database
```bash
# In PostgreSQL
createdb braquni

# Or in psql:
psql -U postgres -c "CREATE DATABASE braquni;"
```

### 5. Run migrations
```bash
npm run migrate
```

`migrate` applies the versioned migrations in `backend/src/db/migrations/NNNN_*.sql` that are not yet
recorded in the `schema_migrations` table (advisory-locked, one transaction per file, checksums
verified). Every migration is additive; `0001_baseline` is the schema the old scripts created, so on a
database that already has it the baseline is a no-op. Re-running `migrate` applies nothing.

**The API server never runs DDL**: it refuses to start (exit code 1) while migrations are pending, so
`npm run migrate` is a deploy step. Set `DATABASE_DIRECT_URL` (session/direct connection, not the
transaction pooler) to give migrations and the job worker's LISTEN/NOTIFY a direct connection.

The job worker (Postgres queue: `jobs` table) runs inside the API process by default; to scale it
separately set `WORKER_IN_PROCESS=false` on the API and run `npm run worker`.

### 6. Create your first admin staff member
```bash
# Optionally set SEED_ADMIN_NAME / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env first
npm run seed
```

### 7. Run the dev servers
```bash
npm run dev          # backend API
npm run dashboard    # frontend dashboard (separate terminal)
```

### Optional: demo data and maintenance scripts (run from `backend/`)
```bash
npm run seed:catalog   # placeholder catalog (price 0 — set real prices via PATCH /api/products/:id)
npm run seed:testing   # demo staff, clients, quotations, orders, tickets, conversations (re-runnable)
npm run backfill       # re-flag needs_review on open orders/quotations (re-runnable)
```

### Wiping a local database
```bash
cd backend
npm run db:reset       # DROPS every table and type, then re-applies every migration
npm run seed
```
`db:reset` is the **only** destructive script. It refuses to run when `NODE_ENV=production`, when
`DATABASE_URL` points at Supabase, or when the database host is not local (to override the last check
deliberately, run `node src/db/reset.js --yes-wipe-everything --allow-remote-host`).

---

## Meta Cloud API Setup

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create an app → Business → WhatsApp
3. Add a phone number
4. Get your **Phone Number ID** and **Access Token**
5. Set your webhook URL to: `https://your-domain.com/webhook`
6. Set webhook verify token to match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`
7. Subscribe to the **messages** webhook field

> For local development, use [ngrok](https://ngrok.com) to expose your localhost:
> `ngrok http 3000`

---

## WhatsApp message templates

WhatsApp only allows free-text messages within **24 hours of the client's last
message**. Business-initiated messages sent later (stage updates, receipts, a
proof or quote that is ready, a resolved ticket, a consultant's reply) must use
a template approved by Meta. The `whatsapp.send` worker handles this:

- client wrote in the last 24 hours → the normal free text;
- otherwise → the approved template configured for the message (its PDF becomes
  the document header for a quote);
- no template configured → the message is marked `needs_template` in the inbox
  and the consultants (or the chat's owner) are emailed to follow up — it is not
  retried. Meta error **131047** (re-engagement) is treated the same way.

Register these templates in WhatsApp Manager (category **Utility**, language
English), then map the logical names to the approved template names:

```
WHATSAPP_TEMPLATES={"order_stage":"braq_order_stage","payment_received":"braq_payment_received","proof_ready":"braq_proof_ready","ticket_resolved":"braq_ticket_resolved","quote_ready":"braq_quote_ready","quote_expiring":"braq_quote_expiring","consultant_reply":"braq_consultant_reply","order_delay":"braq_order_delay"}
```

A value may also be `{ "name": "braq_order_stage", "language": "en_ZA" }`
(default language `en`). `WHATSAPP_WINDOW_CHECK=off` disables the 24-hour check
(the test harness uses it; never set it in production).

| Logical name | Suggested template name | Header | Body (`{{n}}` = parameter) |
|---|---|---|---|
| `order_stage` | `braq_order_stage` | — | Hi {{1}}, an update on your Braq Uni order {{2}}: {{3}}. {{4}} Reply to this message if you have any questions. |
| `payment_received` | `braq_payment_received` | — | Hi {{1}}, thank you — we have received your payment of R {{2}} for order {{3}}. {{4}} |
| `proof_ready` | `braq_proof_ready` | — | Hi {{1}}, the design proof for your Braq Uni order {{2}} is ready: {{3}} Reply *approve* if you are happy, or *changes* and tell us what to change. |
| `ticket_resolved` | `braq_ticket_resolved` | — | Hi {{1}}, your issue about {{2}} has been resolved. {{3}} If anything is still not right, just reply to this message. |
| `quote_ready` | `braq_quote_ready` | Document (the PDF) | Hi {{1}}, your Braq Uni quotation {{2}} is ready: R {{3}} incl. VAT, valid until {{4}}. Reply *accept* to go ahead, *changes* to request edits, or *9* to talk to us. |
| `quote_expiring` | `braq_quote_expiring` | — | Hi {{1}}, your Braq Uni quotation {{2}} expires on {{3}}. Reply *accept* to go ahead or *changes* if anything should change. |
| `consultant_reply` | `braq_consultant_reply` | — | Hi {{1}}, {{2}} from Braq Uni replied to your message: "{{3}}" Reply here to continue the chat. |
| `order_delay` | `braq_order_delay` | — | Hi {{1}}, an update on your Braq Uni order {{2}}: we are waiting for fabric from our supplier. Your order remains active and production continues as soon as it arrives. |

Parameters are built by `TEMPLATE_FALLBACKS` in
`backend/src/modules/notifications/whatsapp.js`; queue messages with
`queueClientMessage(tx, client, { text, templateFallback, conversationId, dedupeKey })`.

---

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/staff/login` | Staff login → returns JWT |
| GET | `/api/staff/me` | Get current staff profile |

### Orders
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/orders` | List orders (filter by `stage`, `clientType`, `staffId`, `onHold`, `active`) |
| GET | `/api/orders/kpis` | Dashboard KPI counts |
| GET | `/api/orders/:id` | Get order + payments + stage history + `stageInfo` (`stageInfo.percent` = pipeline progress) |
| POST | `/api/orders` | Create new order (starts at `deposit_pending`) |
| POST | `/api/orders/:id/advance` | Advance to next stage → sends WhatsApp |
| PATCH | `/api/orders/:id/hold` | Put an order on hold / release it (with a reason) → notifies client |
| POST | `/api/orders/:id/delay` | Shortcut: hold with reason `supplier_delay` → notifies client |
| PATCH | `/api/orders/:id/assign` | Assign consultant |
| POST | `/api/orders/:id/payments` | Record a deposit/balance/full payment → notifies client |
| GET | `/api/orders/:id/payments` | List payments for an order |
| PATCH | `/api/orders/:id/materials` | Update material / stock notes |
| POST | `/api/orders/:id/proof` | Send a design proof to the client for approval |
| PATCH | `/api/orders/:id/proof/status` | Set the proof status (e.g. `approved`, `revision_requested`) |
| POST | `/api/orders/:id/sizes/upload` | Upload a bulk size roster (.xlsx/.csv, field `file`) — replaces the existing roster |
| GET | `/api/orders/:id/sizes` | List uploaded size entries for an order |
| GET | `/api/orders/:id/size-run-sheet` | Size run sheet (PDF) for production |
| POST | `/api/orders/convert-from-quotation/:id` | Convert an accepted quotation into an order |

### Clients
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clients` | List clients |
| GET | `/api/clients/:id` | Client + order history |
| PATCH | `/api/clients/:id` | Update client info / CRM fields |

### Purchase Orders
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/purchase-orders` | List purchase orders |
| POST | `/api/purchase-orders` | Record a client PO against a sent/accepted, unexpired quotation (admin/manager) → creates the order at `deposit_pending` with a 60/40 deposit split and notifies the client; an invalid PO is stored as `invalid` and returns 422 with reasons |

### Tickets (complaints/returns)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tickets` | List tickets (filter by `status`, `overdue=true`) |
| GET | `/api/tickets/:id` | Get a single ticket |
| PATCH | `/api/tickets/:id` | Update status / assign staff |

### Broadcasts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/broadcasts` | Broadcast history |
| POST | `/api/broadcasts/delay` | Send delay notice to all active orders |
| POST | `/api/broadcasts/busy` | Send high-volume notice to clients with open (not completed) orders |
| POST | `/api/broadcasts/custom` | Send a custom message |

### Products (catalog)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/products` | List catalog items (filter by `category`/`clientType`) |
| GET | `/api/products/:id` | Get a single product |
| POST | `/api/products` | Create a product (admin/manager) |
| PATCH | `/api/products/:id` | Update a product, e.g. real pricing (admin/manager) |

### Quotations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/quotations` | List quotations |
| GET | `/api/quotations/:id` | Get a single quotation |
| GET | `/api/quotations/:id/pdf` | PDF (public — used by WhatsApp document delivery) |

### Webhook
| Method | Path | Description |
|--------|------|-------------|
| GET | `/webhook` | Meta verification handshake |
| POST | `/webhook` | Incoming WhatsApp messages |

---

## Order Stages

Orders move through a 4-stage pipeline (`STAGE_ORDER` in `backend/src/modules/bot/templates.js`):

```
deposit_pending   ← order created; waiting for the client's deposit
    ↓
in_production     ← deposit received; being manufactured / branded
    ↓
ready             ← ready for collection, or dispatched for delivery
    ↓
completed
```

- `POST /api/orders/:id/advance` moves an order one stage forward and automatically sends the matching
  WhatsApp message to the client. `GET /api/orders/:id` returns `stageInfo` (including `percent` and
  `isLast`) for progress display.
- **Proof-approval gate:** once a design proof has been sent to the client (`POST /api/orders/:id/proof`),
  the order cannot move into `in_production` until the client approves the proof (by replying on
  WhatsApp, or a consultant recording the approval via `PATCH /api/orders/:id/proof/status`).
- An order on hold (`PATCH /api/orders/:id/hold`) cannot be advanced until the hold is released.
- Every transition is recorded in `order_stage_history`.

---

## Testing

Every test run is self-contained: it **never** touches the Supabase database and never sends real
WhatsApp messages, emails or AI calls.

```bash
npm test                                  # backend unit tests (pure logic, no database)
npm run test:integration                  # backend services/queue/migrations in-process against a throwaway Postgres
npm run test:blackbox                     # black-box API tests against a throwaway local Postgres
npm run test:frontend                     # frontend API-contract tests + headless Microsoft Edge E2E
npm run test:coverage --workspace=backend # backend unit tests with a coverage report
```

- **Black-box** tests start an embedded PostgreSQL in a temp directory, run `migrate` + `seed`, boot the
  real API with every external service (Meta WhatsApp, Resend, Gemini) replaced by local fakes, and
  delete everything afterwards.
- **Frontend E2E** drives the dashboard in headless Microsoft Edge against the same kind of throwaway
  backend.

---

## Phase Roadmap

- [x] **Phase 1** — API backend + WhatsApp bot + webhook
- [ ] **Phase 2** — React staff dashboard
- [ ] **Phase 3** — Quotation tool with PDF export
- [ ] **Phase 4** — Reporting + analytics
