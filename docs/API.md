# Braq Connect: HTTP API Reference

**Base URL:** the API origin. Dashboard routes are under `/api`; Meta calls `/webhook`.

**Request format:** bodies are JSON (limit 1 MB) unless stated otherwise. Ids in paths are UUIDs; a malformed id returns **400** `Invalid <thing> id`.

**Auth column:**

- **public:** no auth.
- **staff:** `Authorization: Bearer <JWT>` from `POST /api/staff/login`, account active.
- A permission name (e.g. `order.override`) means staff **plus** that permission from `core/rbac.js`:
  - **admin** holds every permission.
  - **manager** holds all except `staff.manage`.
  - **consultant** holds none.

## Common responses

| Status | Body / meaning |
|---|---|
| 400 | `{ error, details? }`. A Zod failure includes `details` (flattened field errors). Bad ids, bad enum filters and mapped Postgres input errors also return 400. |
| 401 | `{ error }`: no token, invalid or expired token, or account inactive/removed. The dashboard signs out. |
| 403 | `{ error: 'Forbidden — insufficient permissions' }` (missing permission), or a domain code such as `OVERRIDE_FORBIDDEN`. |
| 404 | `{ error }`: record not found, or `Route not found`. |
| 409 | `{ error, code?, … }`: a business-rule conflict (codes below), or `Record already exists` (Postgres 23505). |
| 413 | Body or upload too large. |
| 429 | Rate limited. General: 1000 requests per 15 min per IP on `/api`. Login: 10 failed attempts per 15 min per IP + email. |
| 500 | `{ error: 'Internal server error' }` (logged). |
| 503 | `{ error: 'Service temporarily unavailable — please try again' }`: a valid token, but the database is unreachable during the auth check. The dashboard stays signed in. |

**Paged lists** return `{ items, total, page, limit }` plus a legacy key (e.g. `orders`). Pagination uses `page` and `limit`; the default limit varies by list, and the maximum is usually 200.

## Error codes (`code` field)

| Code | Status | Raised by |
|---|---|---|
| `STALE` | 409 | Order advance:<br>• `expect` ≠ the actual next stage<br>• lost a concurrent update<br>Quotation status: the row changed between check and write. |
| `HOLD` | 409 | Advance while on hold. `overridable:false`. |
| `PROOF_PENDING` | 409 | Advance to `in_production` while the proof is `sent` or `revision_requested`. Overridable. |
| `DEPOSIT_REQUIRED` | 409 | Advance to `in_production` without a deposit. Never applies to account-terms clients. Overridable. |
| `BALANCE_DUE` | 409 | Advance to `completed` before `paid_in_full`. Overridable. |
| `OVERRIDE_REASON_REQUIRED` | 400 | `override.reason` shorter than 5 characters |
| `OVERRIDE_FORBIDDEN` | 403 | Override attempted without `order.override` |
| `IDEMPOTENCY_MISMATCH` | 409 | Same payment `idempotencyKey` reused with a different type or amount |
| `QUOTE_EXPIRED` | 409 | Accepting a quote past its validity. Bot ordering from an accepted quote past validity (FIN-2). |
| `QUOTE_NOT_ACCEPTED` | 400 | Converting a quote that is not accepted |
| `QUOTE_NOT_DRAFT` | 409 | Editing a non-draft quote |
| `QUOTE_NOT_SENT` | 409 | Resending a quote that is not sent or accepted |
| `QUOTE_OR_ITEMS_REQUIRED` | 400 | `POST /api/orders` without `quotationId` or `lineItems` |
| `ORDER_EXISTS` | 409 | Converting a quote that already has an order. Declining or revising a quote with an order. |
| `INVALID_TRANSITION` / `INVALID_STATUS` | 409 / 400 | Quotation state machine |
| `PROOF_TRANSITION` | 409 | Proof state machine |
| `TICKET_TRANSITION` | 409 | Ticket state machine |
| `CONVERSATION_CLAIMED` | 409 | Takeover, assign or handback of a chat another consultant owns |
| `NO_WHATSAPP` | 409 | Reply or resend to a client without a WhatsApp number |
| `LAST_ADMIN` | 409 | Deactivating or demoting the last active admin |
| `SELF` | 400 | Removing yourself, or changing your own role or access |
| `BAD_PASSWORD` | 400 | Wrong current password |

A guard 409 on advance also carries:

- `overridable`
- `guards`: the codes of every blocking guard
- `blockers`: `[{ code, message, overridable }]`

---

## System

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/health` | public | — | 200 `{ status:'ok', service, timestamp }`. Does **not** check the database. |
| GET | `/webhook` | public | `hub.mode`, `hub.verify_token`, `hub.challenge` | 200 with the challenge when the token equals `META_WEBHOOK_VERIFY_TOKEN`, else 403 |
| POST | `/webhook` | `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`) | Meta webhook JSON | **401** for an invalid or missing signature (in production, also when the secret is unset).<br>**200** after the events are committed.<br>**500** if they could not be stored, so Meta retries.<br>An unreadable payload returns 200 and is ignored. See [WHATSAPP_FLOW.md](WHATSAPP_FLOW.md). |
| GET | `/api/meta` | staff | — | Lifecycle vocabulary (stages, job states and queues, statuses, bot states), business numbers (currency, VAT, deposit %, validity, SLAs), `role`, `permissions` |

## Staff (`/api/staff`)

| Method | Path | Auth | Request body | Response / errors |
|---|---|---|---|---|
| POST | `/login` | public (login limiter) | `{ email, password (≥6) }` | 200 `{ token, staff:{id,name,email,role} }`. 401 `Invalid credentials` (constant time for unknown emails). 429 when rate limited. |
| GET | `/me` | staff | — | `{ staff }` |
| POST | `/me/password` | staff | `{ currentPassword, newPassword (8–200) }` | 204. 400 `BAD_PASSWORD`. Existing tokens are **not** revoked. |
| GET | `/` | staff | — | `{ staff:[{id,name,email,role,is_active,created_at}] }` |
| POST | `/` | `staff.manage` | `{ name, email, password (≥8), role? = consultant }` | 201 `{ staff }`. 409 `Email already exists`. |
| PATCH | `/:id` | `staff.manage` | Strict, at least one of `{ role?, isActive?, password? (8–200) }` | 200 `{ staff }`.<br>400 `SELF` (own role or access).<br>409 `LAST_ADMIN`.<br>404.<br>A password reset does not revoke existing tokens. |
| DELETE | `/:id` | `staff.manage` | — | 204. **Deactivates** (`is_active=false`); the row and history are kept, and requireAuth refuses the user's token at once.<br>400 `SELF`.<br>409 `LAST_ADMIN`. |

## Orders (`/api/orders`): all staff unless noted

| Method | Path | Request | Response / notes |
|---|---|---|---|
| GET | `/kpis` | — | `{ kpis:{new_enquiries, quotations_awaiting_pricing, active_orders, open_tickets, on_hold_orders}, attention:[…20] }` |
| GET | `/` | Query: `stage` (or array), `clientType`, `staffId`, `onHold=true`, `active=true`, `page`, `limit` (default 20) | Paged `orders`. Each row has `lifecycle_state`. |
| GET | `/:id` | — | `{ order, payments, history, stageInfo, lifecycle }` |
| POST | `/` | `{ clientId, clientType?, quotationId?` (accepted) **or** `lineItems[1..200], poNumber?, assignedStaffId?, conversationId? }` | 201 `{ order, quotationId }`. With `lineItems`, an accepted quotation is created first. With `poNumber`, a `valid` purchase-order row is logged. Errors: 400 `QUOTE_OR_ITEMS_REQUIRED`, 400 client/quote/staff checks, 409 `ORDER_EXISTS`. |
| POST | `/convert-from-quotation/:id` | `{ accept?, poNumber?, assignedStaffId?, conversationId? }` (`:id` = quotation) | 201 `{ order }`. `accept:true` accepts a **sent** quote in the same transaction (refused with `QUOTE_EXPIRED` past validity). 400 `QUOTE_NOT_ACCEPTED`. 409 `ORDER_EXISTS`. An **accepted** quote is converted even past its validity (staff path, FIN-2 unchanged). |
| POST | `/:id/advance` | `{ expect?: stage, notes?, estimatedCompletion?: 'YYYY-MM-DD', trackingNumber?, deliveryType?: collection\|delivery, override?: { reason }, payment?: { amount, type?=balance, notes? } }` | 200 `{ order, from, to, overridden, payment? }`. See the details below this table. |
| PATCH | `/:id/hold` | `{ isOnHold, holdReason? (≤200) }` | `{ order }`. `supplier_delay` newly set queues the delay WhatsApp. No permission check. |
| POST | `/:id/delay` | `{ reason? }` (ignored) | `{ order }`. Shortcut for hold with `supplier_delay`. |
| PATCH | `/:id/assign` | `{ staffId }` | `{ order }`. 400 if the staff member is missing or inactive. |
| POST | `/:id/payments` | `{ type: deposit\|balance\|full, amount (>0, ≤2 dp, ≤1e9), currency?: 'ZAR' only, notes?, startProduction?: { estimatedCompletion?, notes? }, idempotencyKey?: [\w-]{8,100} }` | **201** `{ payment, advanced? }` when new. **200** `{ payment, replayed:true }` when the key was already recorded. See the details below this table. |
| GET | `/:id/payments` | — | `{ payments }` (newest first) |
| PATCH | `/:id/materials` | Any JSON object, at most 10 KB | `{ order }` |
| POST | `/:id/proof` | `{ proofUrl: http(s) URL, notes? }` | `{ order }`. Sets `proof_status='sent'`, moves the open chat to `proof_review` (unless a human owns it), and queues the WhatsApp. 409 `PROOF_TRANSITION`. |
| PATCH | `/:id/proof/status` | `{ status: approved\|revision_requested\|sent, notes?, startProduction? }` | `{ order }`. `startProduction` is allowed only with `approved`; it advances to `in_production` in the same transaction. |
| POST | `/:id/sizes/upload` | multipart field `file` (`.xlsx`/`.csv`, ≤5 MB; columns Name, Size[, Notes]) | 201 `{ sizes, count }`. **Replaces** the roster. 415 wrong type, 413 too large. |
| GET | `/:id/sizes` | — | `{ sizes }` |
| GET | `/:id/size-run-sheet` | — | PDF attachment `size-run-<ref>.pdf` |

**`POST /:id/advance` details:**

- A guard failure returns 409 (`HOLD`, `PROOF_PENDING`, `DEPOSIT_REQUIRED`, `BALANCE_DUE`) with `guards` and `blockers`.
- `expect` mismatch or a lost race returns 409 `STALE`. The dashboard always sends `expect` (DAT-1).
- 400 `OVERRIDE_REASON_REQUIRED`; 403 `OVERRIDE_FORBIDDEN`; 400 when already at the final stage or the stage is unknown.
- A `payment` is recorded first in the same transaction and rolled back if the advance is refused.
- The advance-with-payment path takes no `idempotencyKey`.

**`POST /:id/payments` details:**

| Status | Cause |
|---|---|
| 400 | Overpayment, `Order is already paid in full`, or non-ZAR currency |
| 409 | `IDEMPOTENCY_MISMATCH` |
| 404 | Order not found |
| 409 guard codes | `startProduction` was set and the advance was refused; the payment is rolled back |

Any staff member may record a payment; `payments.recorded_by` records who did.

## Quotations (`/api/quotations`): all staff

| Method | Path | Request | Response / notes |
|---|---|---|---|
| GET | `/` | Query: `status`, `search`, `clientId`, `page`, `limit` | Paged `quotations` with `lifecycle_state`. 400 for an unknown status. |
| POST | `/` | `{ clientId, conversationId?, lineItems?[≤200], notes? }` | 201 `{ quotation, lifecycle }`. A draft assigned to the creator. |
| GET | `/:id` | — | `{ quotation, lifecycle }`. Includes `is_expired`, `past_validity`, `order_id`. |
| PUT | `/:id` | At least one of `{ lineItems?, notes?, validUntil?: 'YYYY-MM-DD'\|null }` | `{ quotation }` (autosave). 409 `QUOTE_NOT_DRAFT`. |
| POST | `/:id/approve` | `{ lineItems[≥1] }` | `{ quotation, whatsappSent, lifecycle }`. Recomputes every line and the totals on the server, sets `sent`, fixes `valid_until`, and queues `quotation.pdf.send`. 400 if the quote is not a draft; 409 if already approved. |
| PATCH | `/:id/status` | `{ status: draft\|sent\|accepted\|rejected\|expired }` | `{ quotation, lifecycle }`. Follows `QUOTATION_TRANSITIONS`. 409 with `INVALID_TRANSITION`, `QUOTE_EXPIRED`, `ORDER_EXISTS` or `STALE`. |
| POST | `/:id/claim` | — | `{ quotation }`. First claimer wins. 409 `Already claimed by …`. |
| POST | `/:id/resend` | — | **202** `{ queued:true, quotation }`. 409 `QUOTE_NOT_SENT` or `NO_WHATSAPP`. Double clicks within 10 s are deduped. |
| GET | `/:id/pdf` | — | **Staff only** (AUTH-4). `application/pdf`, `Cache-Control: private, no-store`, inline `<reference>.pdf`. 422 when the quote has no line items. Clients never get this link: they receive the PDF as a WhatsApp document uploaded to Meta's media store. |

**Line item shape** (`LineItemSchema`):

```
{ productId?, name, category?, colour?, sizes:[{size, qty≥0}], quantity (int >0),
  unitPrice ≥0, brandingSurcharge? ≥0, branding?: { type: none|embroidery|screen_print|sublimation|heat_transfer, position?, detail? },
  effectiveUnitPrice?, lineTotal?, aiNote?, priceConfirmed? }
```

`effectiveUnitPrice` and `lineTotal` are always recomputed on the server.

## Jobs, clients, purchase orders, tickets

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | `/api/jobs` | staff | Query: `state` (CSV of job states), `queue` (CSV), `owner=me\|unassigned`, `overdue=true`, `search`, `clientId`, `page`, `limit` | `{ items, total, page, limit, counts, queueCounts, flagCounts }`. 400 for an unknown state, queue or owner. |
| GET | `/api/jobs/by-order/:orderId` | staff | — | `{ orderId, quotationId }` |
| GET | `/api/jobs/:quotationId` | staff | — | `{ quotation, order, payments (with recorded_by_name), sizes, purchaseOrders, tickets, conversation, client, history, lifecycle }` |
| GET | `/api/clients` | staff | Query: `search`, `clientType`, `page`, `limit` (default 30) | Paged `clients` |
| GET | `/api/clients/:id` | staff | — | Client + history |
| PATCH | `/api/clients/:id` | staff | camelCase or snake_case profile fields: `name`, `email`, `clientType`, `organisation`, `contactPerson`, `notes`, `physicalAddress`, `vatNumber`, `preferredStoreLocation`, `schoolName`, `deliveryPreference` (`''` clears) | `{ client }` |
| PATCH | `/api/clients/:id/account-terms` | `client.terms` | `{ accountTerms: boolean }` | `{ client }`. Records who set it and when. |
| POST | `/api/clients/:id/conversation` | staff | — | 201 `{ conversation, created:true }` or 200 for the existing open chat |
| GET | `/api/purchase-orders` | staff | `page`, `limit` (default 50) | Paged `purchaseOrders` |
| POST | `/api/purchase-orders` | `po.create` | `{ quotationId, poNumber (1–100), amount?, notes? }` | **201** `{ purchaseOrder, order, warnings }` (order created; a sent quote is accepted inline).<br>**422** `{ error, reasons, purchaseOrder }` when the quote is not sent/accepted, is past validity, or is already converted (stored as `invalid`).<br>An amount more than 5% off the quote total is only a warning. |
| GET | `/api/tickets` | staff | Query: `status`, `overdue=true`, `clientId`, `orderId`, `page`, `limit` | Paged `tickets` with `is_overdue` |
| POST | `/api/tickets` | staff | `{ clientId, orderId?, category, description (5–5000) }` | 201 `{ ticket }`. Assigned to the creator; SLA 4 h. |
| GET | `/api/tickets/:id` | staff | — | `{ ticket }` |
| PATCH | `/api/tickets/:id` | staff | `{ status?, assignedStaffId?\|null, resolutionNote? }` | `{ ticket }`. 409 `TICKET_TRANSITION`. A new `resolved` queues the client WhatsApp. |
| POST | `/api/tickets/:id/claim` | staff | — | `{ ticket }`, or 409 `Already claimed by …` |

## Conversations (`/api/conversations`): all staff

| Method | Path | Request | Response / notes |
|---|---|---|---|
| GET | `/` | Query: `state`, `isOpen=true\|false\|all` (default true), `assignedToMe=true`, `search`, `clientId`, `page`, `limit` | Paged `conversations` |
| GET | `/unread-count` | — | `{ waiting, unreadMessages }` |
| GET | `/:id` | — | `{ conversation, messages }` |
| POST | `/:id/reply` | `{ body }` (1–4096 chars) | `{ sent:true, queued:true, messageId, jobId, metaMessageId:null }`. See the details below this table. |
| PATCH | `/:id/takeover` | — | `{ conversation }`: `consultant_active`, assigned to the caller, and the client is told who is helping. 409 `CONVERSATION_CLAIMED` unless the chat is unassigned, already the caller's, or the caller is admin/manager. |
| PATCH | `/:id/handback` | — | `{ conversation }`: back to `main_menu`, unassigned, and the client is notified. **Ownership enforced:** owner, unassigned, or admin/manager; otherwise 409 `CONVERSATION_CLAIMED`. |
| PATCH | `/:id/assign` | `{ staffId }` (active staff) | `{ conversation }`. **Ownership enforced** (same rule). |
| POST | `/:id/claim` | — | `{ conversation }`. Only if unassigned, else 409. |
| PATCH | `/:id/close` | — | `{ conversation }` (`is_open=false`). No ownership check. |
| PATCH | `/:id/read` | — | `{ ok:true }` |

**`POST /:id/reply` details:**

- The reply is queued through the outbox and recorded at once with status `queued`.
- `awaiting_consultant` changes to `consultant_active`; the replier is assigned if the chat had no owner.
- Outside the 24-hour window it uses the `consultant_reply` template.
- 409 `NO_WHATSAPP`.
- **No ownership check:** any staff member can reply to any chat.

## Catalog, settings, analytics, broadcasts

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/products` | staff | Query: `category`, `schoolName`, `activeOnly=true\|1` | `{ products }` |
| GET | `/api/products/:id` | staff | — | `{ product }` |
| POST | `/api/products` | `product.write` | `{ category, name, schoolName?, sizes[], price ≥0, currency?=ZAR, description?, isActive?=true }` | 201 `{ product }` |
| PATCH | `/api/products/:id` | `product.write` | Any subset of the above (nullable `schoolName` and `description`) | `{ product }` |
| GET | `/api/school-catalog` | staff | Query: `school` | `{ entries }` |
| GET | `/api/school-catalog/schools` | staff | — | `{ schools }` |
| POST | `/api/school-catalog` | `catalog.write` | `{ schoolName, uniformType, description?, sizes[], price, currency?, sortOrder? }` | 201 `{ entry }` |
| PATCH | `/api/school-catalog/:id` | `catalog.write` | Subset, plus `isActive` | `{ entry }` |
| DELETE | `/api/school-catalog/:id` | `catalog.write` | — | `{ ok:true }` (hard delete) |
| GET | `/api/settings` | `settings.read` | — | `{ settings: { key: value } }` |
| PATCH | `/api/settings/:key` | `settings.write` | `{ value: string\|number\|boolean (≤2000 chars) }` | `{ setting }`. 404 for an unknown key (only existing keys, e.g. `busy_mode`). |
| GET | `/api/analytics/revenue` | `analytics.view` | — | `{ summary, byMonth, conversion, stageBreakdown }` |
| GET | `/api/analytics/top-clients` | `analytics.view` | `limit` (1–100, default 10) | `{ clients }` |
| GET | `/api/analytics/top-products` | `analytics.view` | `limit` | `{ products }` |
| GET | `/api/broadcasts` | staff | — | `{ broadcasts }` (latest 50) |
| POST | `/api/broadcasts/custom` | `broadcast.send` | `{ audience: all_clients\|active_orders\|corporate\|retail` (**required**; an unknown value is 400, never "everyone"), `message? (≤4096), imageUrl?, mediaId?, mediaType?: image\|pdf, mediaFilename? }`. At least one of message, imageUrl or mediaId. | **202** `{ broadcastId, recipients, status, total, sent, failed }`. `sent` is the number queued. |
| POST | `/api/broadcasts/delay` | `broadcast.send` | — | 202. A supplier-delay notice per open order of **non-retail** clients. |
| POST | `/api/broadcasts/busy` | `broadcast.send` | — | 202. A high-volume notice to every client with an open order. |
| POST | `/api/broadcasts/upload-attachment` | `broadcast.send` | multipart `attachment` (JPG/PNG/WebP/PDF, ≤20 MB) | `{ mediaId, filename, size, type }`. Uploaded to Meta. 500 if Meta rejects it. |

The broadcast send behaviour (24-hour window, rate, counting) is described in [WHATSAPP_FLOW.md](WHATSAPP_FLOW.md#9-broadcasts).
