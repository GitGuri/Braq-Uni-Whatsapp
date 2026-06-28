# Braq Connect™ — WhatsApp Platform

A WhatsApp-based client communication and order management platform for Braq Uni.

---

## Architecture

```
braquni/
├── apps/
│   ├── api/              ← Node.js backend (this is what you build first)
│   │   └── src/
│   │       ├── index.js          ← App entry point
│   │       ├── config/           ← Env config loader
│   │       ├── db/               ← PostgreSQL pool, migrations, seed
│   │       ├── routes/           ← Express route definitions (thin, no logic)
│   │       ├── controllers/      ← Request/response handling + validation
│   │       ├── services/         ← Business logic, DB queries, WhatsApp sending, bot state machine
│   │       ├── middleware/       ← JWT auth
│   │       └── utils/            ← Logger, shared HttpError
│   └── dashboard/        ← React staff dashboard (Phase 2)
└── packages/
    └── shared/           ← Shared types/constants (future)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js v22 (ESM) |
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
- Node.js 18+
- PostgreSQL 14+
- A Meta developer account with WhatsApp Business API set up

### 2. Clone and install
```bash
git clone <your-repo>
cd braquni
npm install
```

### 3. Configure environment
```bash
cd apps/api
cp .env.example .env
# Fill in your values in .env
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

### 6. Create your first admin staff member
```bash
# Optionally set SEED_ADMIN_NAME / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env first
npm run seed
```

### 7. Run the dev server
```bash
npm run dev
```

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

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/staff/login` | Staff login → returns JWT |
| GET | `/api/staff/me` | Get current staff profile |

### Orders
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/orders` | List orders (filterable) |
| GET | `/api/orders/:id` | Get order + stage history + `progressPercent` |
| POST | `/api/orders` | Create new order |
| POST | `/api/orders/:id/advance` | Advance to next stage → sends WhatsApp |
| POST | `/api/orders/:id/delay` | Flag as delayed → notifies client |
| PATCH | `/api/orders/:id/assign` | Assign consultant |
| POST | `/api/orders/:id/payments` | Record a deposit/balance/full payment → notifies client |
| GET | `/api/orders/:id/payments` | List payments for an order |
| POST | `/api/orders/:id/sizes/upload` | Upload a bulk size roster (.xlsx/.csv) |
| GET | `/api/orders/:id/sizes` | List uploaded size entries for an order |

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
| POST | `/api/purchase-orders` | Manually record a purchase order (admin/manager) |

### Tickets (complaints/returns)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tickets` | List tickets (filter by `status`, `overdue=true`) |
| GET | `/api/tickets/:id` | Get a single ticket |
| PATCH | `/api/tickets/:id` | Update status / assign staff |

### Broadcasts
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/broadcasts/delay` | Send delay notice to all active orders |
| POST | `/api/broadcasts/busy` | Send high-volume notice to all clients |

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

```
quotation_requested
    ↓
quotation_submitted
    ↓
purchase_order_received
    ↓
design_approval_pending   ← customer must reply APPROVE before this can advance
    ↓
materials_procurement
    ↓
production_scheduled
    ↓
manufacturing
    ↓
branding_embroidery
    ↓
quality_control
    ↓
packing_dispatch
    ↓
completed
```

Each stage advance automatically sends the correct WhatsApp message to the client. A purchase order validated against an active quotation (via the bot's PO flow or `POST /api/purchase-orders`) creates the order directly at `purchase_order_received`, and also sets a deposit requirement (`orders.payment_status`) if the quotation specifies one.

---

## Phase Roadmap

- [x] **Phase 1** — API backend + WhatsApp bot + webhook
- [ ] **Phase 2** — React staff dashboard
- [ ] **Phase 3** — Quotation tool with PDF export
- [ ] **Phase 4** — Reporting + analytics
