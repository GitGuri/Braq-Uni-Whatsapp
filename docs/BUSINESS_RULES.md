# Braq Connect: Business Rules

This document lists the rules the code enforces, where each one is defined, and the gaps the business must confirm.

Status labels: **Implemented**, **Partially implemented**, **Not implemented**, **Requires external configuration**, **Requires manual business verification**.

---

## 1. Money (`backend/src/core/money.js`)

| Rule | Value / formula |
|---|---|
| Currency | `ZAR` only |
| Arithmetic | Integer **cents** throughout; rands only at the edges (NUMERIC(12,2) columns, messages) |
| Prices | Catalogue and line prices **exclude VAT** |
| VAT | 15% (`VAT_RATE_BP = 1500`). `vat = round(subtotal × 1500 / 10000)`, rounded **half-up** to the cent. `total = subtotal + vat`. |
| Line total | `quantity × (unitPrice + brandingSurcharge)`, always recomputed on the server. A client-sent `lineTotal` is ignored when quantity and price are known. |
| Deposit | **60%** of the total: `deposit = round(total × 60 / 100)` |
| Balance | `total − deposit`, so deposit + balance always equals the total exactly |
| Quote validity | **30 days** (`QUOTE_VALIDITY_DAYS`), counted in South African calendar days |
| SLAs | Quote pricing 4 h (`QUOTE_SLA_HOURS`); ticket 4 h (`TICKET_SLA_HOURS`) |

The dashboard reads these values from `GET /api/meta`, so they are defined once.

## 2. Quotations

**Statuses:** `draft` (pricing) → `sent` → `accepted` / `rejected` / `expired`.

The allowed transitions (`lifecycle/machines.js` `QUOTATION_TRANSITIONS`) are below. Every transition is one conditional `UPDATE`; a refusal returns 409 with a code.

| To | Allowed from | Extra rule |
|---|---|---|
| `draft` (revise) | sent, rejected, expired | Refused once an order exists (`ORDER_EXISTS`). Clears `valid_until`. |
| `sent` | draft | Sets `valid_until` if it is empty |
| `accepted` | sent | Must be **within validity** (`QUOTE_EXPIRED`) |
| `rejected` | draft, sent, accepted, expired | Refused once an order exists |
| `expired` | sent | — |

**Expiry is enforced in SQL** (`lifecycle/sql.js`):

- The quote is valid through `valid_until` (an SA date). Without one, it is valid through `approved_at` (or `created_at`) + 30 days.
- A `sent` quote past that date is **read as expired** everywhere (`IS_EXPIRED_SQL`), and `quotation.expire` persists the status every 30 min.
- `accepted` quotes are never expired automatically.

**Sending (approve):**

- Lines are re-priced and totals recomputed on the server.
- A `valid_until` set while drafting is kept if it is still in the future; otherwise it becomes today + 30.
- An unowned quote is claimed by the sender.
- The PDF is queued, and an `awaiting_consultant` chat returns to the bot.
- `quotation.pdf.send` refuses to send a quote that is no longer `sent` or `accepted` (FIN-5).

**Drafts:**

- Drafts are created by the bot (`sla_remind_at = now + 4 h`) or by staff.
- AI price suggestions on drafts are marked `priceConfirmed:false`, and a draft total is never shown to the client.

**FIN-2:** WhatsApp ordering from an **accepted** quote past its validity is refused with `QUOTE_EXPIRED`, and the client is offered a refresh at today's prices.

- Staff conversion (`convert-from-quotation`, `POST /orders` with `quotationId`) of an accepted quote is **unchanged**: no validity check.
- Purchase orders are refused when the quote is past its validity.

## 3. Orders

**Creation:**

- Every order comes from an **accepted** quotation (`orders/convert.js`), one per quotation (`uniq_orders_quotation`).
- The order starts at `deposit_pending` with `payment_status = 'unpaid'`.
- `total_amount`, `deposit_amount` and `balance_amount` come from the quote total (60/40 split).
- The deposit WhatsApp is queued; account-terms clients are told no deposit is needed.
- References are `BRQ-O-00001`, a global sequence.

**Stages:**

```
deposit_pending → in_production → ready → completed      (one step per advance)
```

- Legacy 10-stage values are mapped onto these four stages and never rewritten in the database.
- `cancelled` (stage or `cancelled_at`) is recognised for display only. **Not implemented:** there is no endpoint to cancel an order.

**Guards** (`lifecycle/guards.js`):

| Guard | Blocks | Overridable? |
|---|---|---|
| `HOLD` | Any advance while `is_on_hold` | **No.** Release the hold first. |
| `PROOF_PENDING` | → `in_production` while the proof is `sent` or `revision_requested` | Yes |
| `DEPOSIT_REQUIRED` | → `in_production` while the payment status is below `deposit_paid`. **Never for clients with `account_terms`.** | Yes |
| `BALANCE_DUE` | → `completed` unless `paid_in_full` (or legacy `not_required`) | Yes |

**Overrides:**

- An override needs the `order.override` permission (admin or manager), otherwise 403 `OVERRIDE_FORBIDDEN`.
- It needs `override.reason` of at least 5 characters, otherwise 400 `OVERRIDE_REASON_REQUIRED`.
- The overridden guards and the reason are written to `order_stage_history` (`overridden_guards`, `override_reason`) and logged as a warning.

**Concurrency (DAT-1):**

- `expect` (the stage the caller means to reach) must equal the next stage, or the request fails with 409 `STALE`. The dashboard always sends it.
- The write is a conditional `UPDATE` (stage unchanged, and the guards are re-checked in SQL unless overridden). A lost race returns 409 with the failing guard code, or `STALE`.

**Side effects of an advance:**

- A stage-history row.
- A stage WhatsApp (deduped per history row), with the `order_stage` template outside 24 h.
- `ready` + `delivery` uses the delivery text. `ready` messages include the balance still owed.
- Optional fields: `estimatedCompletion`, `trackingNumber`, `deliveryType` (stored at `ready`).

## 4. Payments (`modules/payments/service.js`)

| Rule | Behaviour |
|---|---|
| Locking | The order row is locked (`FOR UPDATE`) for each payment, so concurrent payments apply one at a time |
| Amount | `> 0`, at most 2 decimal places, ≤ 1e9. Also a DB CHECK (`payments_amount_positive`). |
| Currency | **ZAR only.** Anything else is a 400. |
| Overpayment | Refused (400 `Payment exceeds the outstanding amount of R …` / `Order is already paid in full`) when the total is known |
| Order total | `orders.total_amount` if it is above 0. Otherwise deposit/balance bookkeeping (`balance + max(paid, deposit)`). Otherwise the quote total. Otherwise **unknown**. |
| Status | `paid ≥ total` → `paid_in_full`. Otherwise `paid ≥ deposit` → `deposit_paid`. With an unknown total, a `balance` or `full` payment → `paid_in_full`. Status **never moves backwards**. |
| Balance | `balance_amount = total − max(paid, deposit)` (minimum 0) |
| Idempotency | `idempotencyKey` (one per form submission) plus a partial unique index. A replay returns the first payment (HTTP 200 `replayed:true`) and does not advance again. The same key with a different type or amount returns 409 `IDEMPOTENCY_MISMATCH`. |
| Audit | `recorded_by` = the staff member who recorded the payment |
| With production start | `startProduction` records the payment and advances to `in_production` in one transaction. If the advance is refused, the payment is rolled back. |
| Receipt | A client WhatsApp (`payment_received` template outside 24 h) with the deposit still due or the outstanding balance |
| Who may record | Any staff member, including consultants |
| Void / refund / reversal | **Not implemented.** A wrong payment can only be corrected in the database. |

## 5. Purchase orders, proofs, holds, tickets

**Purchase orders** (`po.create`: admin or manager):

- A PO is valid only if the quote is `sent` or `accepted`, within its validity, and not already converted.
- A valid PO accepts a sent quote and creates the order (source `po`).
- An invalid PO is stored as `invalid`, and the response is 422 with the reasons.
- An amount more than 5% off the quote total is only a warning.
- `POST /api/orders` with a `poNumber` (any staff) also records a `valid` PO row.

**Proofs** (`PROOF_TRANSITIONS`):

| From | Allowed targets |
|---|---|
| none | sent |
| sent | sent, approved, revision_requested |
| revision_requested | sent |
| approved | sent, **only before production starts** |

- Sending a proof moves the client's open chat to `proof_review` unless a human owns it.
- The client approves or asks for changes on WhatsApp, and the owner (or the consultants) is emailed.
- Staff may record the outcome with `PATCH /proof/status`. `approved` + `startProduction` advances in the same transaction.

**Holds:**

- Any staff member can put an order on hold or release it.
- `supplier_delay` notifies the client once each time it is newly set.
- `HOLD` can't be overridden.

**Tickets:**

- Status machine: open ↔ in_progress, either → resolved or closed, resolved → closed or open, closed → open.
- `sla_due_at = created + 4 h`. Overdue = past the SLA while open or in progress.
- Resolving notifies the client (`ticket_resolved`) and keeps the first `resolved_at` time.
- The bot links a ticket to the client's order when it can.

**Partially implemented:** both SLAs are **wall-clock hours** (`now + 4 h`), while client texts say "4 business hours". There is no automatic escalation beyond the 2-hour unclaimed reminder and the overdue flag.

## 6. Clients

- **Account terms** (`client.terms`: admin or manager) remove the deposit requirement and the deposit request message. Who set it, and when, is stored.
- Any staff member can edit client profile fields.

## 7. Staff accounts

| Rule | Behaviour |
|---|---|
| Remove access | `DELETE /api/staff/:id` **deactivates** the account. The row and history are kept, and the user's token is refused at once. |
| Self | You can't remove yourself or change your own role or access (`SELF`). You can change your own password (current password required). |
| Last admin | Deactivating or demoting the last active admin returns 409 `LAST_ADMIN` (the rows are locked for the check) |
| Reactivate / role / reset password | `PATCH /api/staff/:id` (admin) |
| Tokens | A password change or reset does **not** revoke existing JWTs (they live up to `JWT_EXPIRES_IN`, default 8 h). **Partially implemented.** |
| Notification recipients | Default staff emails go only to active `consultant` accounts |

## 8. Roles and permissions

Defined in `backend/src/core/rbac.js` and exposed to the dashboard via `GET /api/meta`.

| Permission | admin | manager | consultant | Used by |
|---|:-:|:-:|:-:|---|
| `order.override` | ✔ | ✔ | — | Override PROOF_PENDING / DEPOSIT_REQUIRED / BALANCE_DUE |
| `broadcast.send` | ✔ | ✔ | — | `POST /api/broadcasts/*` |
| `staff.manage` | ✔ | — | — | Create, update and deactivate staff |
| `analytics.view` | ✔ | ✔ | — | `/api/analytics/*` |
| `settings.read` / `settings.write` | ✔ | ✔ | — | `/api/settings` |
| `product.write` | ✔ | ✔ | — | Create or update products |
| `po.create` | ✔ | ✔ | — | `POST /api/purchase-orders` |
| `catalog.write` | ✔ | ✔ | — | School catalogue writes |
| `client.terms` | ✔ | ✔ | — | Account terms |

Everything else is open to any authenticated staff member. That includes:

- pricing and sending quotes
- converting quotes to orders
- recording payments
- advancing stages (without override)
- holds
- proofs
- tickets
- replying to and closing any chat

Taking over, assigning and handing back a chat requires being its owner, the chat being unassigned, or being an admin or manager.

---

## 9. Requires manual business verification

Each item below is current behaviour that the business must confirm or change:

1. **Account-terms clients still need a `BALANCE_DUE` override at completion.** Account terms waive only the deposit; `completed` requires `paid_in_full`.
2. **Zero-total orders can never be marked paid without overrides.** Any positive payment is an overpayment, so `DEPOSIT_REQUIRED` and `BALANCE_DUE` must be overridden.
3. **Orders with an unknown total can be marked `paid_in_full` by any balance or full payment**, whatever the amount.
4. **Consultants may record payments**, including a "full" payment that satisfies both guards without a manager. This is now audited (`recorded_by`).
5. **Accepted quotes are not auto-expired for staff conversions.** Staff can create an order at old prices months later. Only the bot and PO paths check validity.
6. **There is no payment reversal, void or refund path.**
7. Direct WhatsApp orders don't apply the auto-quote quantity bounds (whole number, ≤ 5000, sizes summing to the quantity).
8. Catalogue products priced 0 are auto-quoted and ordered at R 0.00.
9. SLAs are wall-clock hours, not business hours.
10. Custom and busy broadcasts carry no template, so clients who haven't written in 24 h won't receive them. Staff may get one "not delivered" email per such recipient who has a stored chat.
11. The supplier-delay broadcast targets only non-retail clients with open orders.
