# Braq Connect: WhatsApp Flow

This document follows a message from Meta through the webhook, the bot and the outbox, and back to the client. It also covers broadcasts and the scheduled jobs.

Status labels: **Implemented**, **Partially implemented**, **Not implemented**, **Requires external configuration**, **Requires manual business verification**.

```
Meta ──POST /webhook──► verify signature ──► extract events ──► ONE tx: inbound_events + jobs ──► 200
                                                                       │
     inbound.process (queue_key wa:<phone>, FIFO) ◄────────────────────┘
        └─ bot turn: handlers run (AI calls, domain writes) → commit ONE tx:
             inbound message, state/context, replies (whatsapp.send jobs + messages rows),
             staff emails (email.send jobs), inbound_events.processed_at
     whatsapp.send (queue_key out:<phone>, FIFO) ──► Meta Graph API ──► messages.meta_message_id/status
     Meta status webhook ──► message.status ──► messages.status (sent→delivered→read, or failed)
```

---

## 1. Webhook (`modules/webhook/controller.js`)

| Step | Behaviour |
|---|---|
| Verification | `GET /webhook` returns `hub.challenge` when `hub.mode=subscribe` and the token equals `META_WEBHOOK_VERIFY_TOKEN`; otherwise 403. The token is never logged. |
| Signature | `POST /webhook` requires `X-Hub-Signature-256 = sha256=<HMAC-SHA256(raw body, META_APP_SECRET)>`, compared with `timingSafeEqual`. A missing or bad signature returns **401**.<br>**Production refuses unsigned webhooks**: with no secret, every POST is 401, and `assertProductionConfig` already refuses to start without `META_APP_SECRET`.<br>Outside production, a missing secret logs a one-time warning and accepts the request. |
| Extraction | Only `object = whatsapp_business_account` and `field = messages` are read. Each message becomes an event:<br>• **text** (trimmed, non-empty)<br>• **media**: `image`, `video`, `audio`, `document`, `sticker`, `location` or `contacts`<br>Other types are ignored and logged.<br>The sender's WhatsApp profile name is carried along. Status receipts (`sent`, `delivered`, `read`, `failed`, plus the first error code) are collected. |
| Persist | In one transaction:<br>• `INSERT inbound_events … ON CONFLICT (meta_message_id) DO NOTHING`, so a Meta retry is **deduped**<br>• an `inbound.process` job for each new event (`queue_key wa:<phone>`)<br>• a `message.status` job for each receipt (`dedupe status:<id>:<status>`, 3 attempts) |
| Response | **200 only after the commit.** A storage failure returns **500**, and Meta retries. An unreadable payload returns 200 and is ignored. |

## 2. Inbound processing (`workers/handlers/inbound.process.js`)

- Each sender has a FIFO queue (`wa:<phone>`): one message at a time, in order.
- An event that is already processed is skipped. Text goes to `handleInbound`; media goes to `handleInboundMedia` (`modules/bot/router.js`).
- After the turn, `processed_at` is set again as a safety net.

## 3. The bot turn (`modules/bot/reply.js`)

Handlers never write the conversation directly. They record operations on the turn (`reply`, `setState`, `notify`, `onCommit`), and `commit()` applies everything in **one transaction**:

1. **Store the inbound message.** `ON CONFLICT (meta_message_id)`: a duplicate rolls the whole turn back and only marks the event processed.
2. **Lock the conversation and compare its state with the state the turn started from (MSG-1).**
   - If staff changed it during the turn (takeover, handback, proof sent…), **the staff change wins**: the turn's state changes are dropped.
   - If the new state is a human state (`awaiting_consultant` or `consultant_active`), **the turn's replies are dropped too**, so the bot never talks over a consultant who now owns the chat.
3. Apply state and context updates (`context = context || $json`), queue replies, queue staff emails and run the `onCommit` operations, in the order they were recorded.
4. Set `inbound_events.processed_at`.

AI calls and domain writes (quotations, tickets, direct orders) happen **while the handlers run, before the commit** and outside the transaction. They are made replay-safe instead (§5).

If anything throws, `turn.fail()` stores the inbound message and queues a short apology (`GENERIC_ERROR`) in its own transaction. If even that cannot be written, the job throws and is retried.

## 4. Router precedence (`modules/bot/router.js`)

For a text message, the router checks these in order:

1. **Pending one-message follow-up** in `context.pending`, valid for 24 h: `refresh_quote` ("Reply 1 to refresh"), `proof_confirm`, `quote_changes`.
2. **Consultant states** (`awaiting_consultant`, `consultant_active`): handled in `states/handoff.js` (§7). "accept" still works.
3. **Stale conversation**: if the client's previous message is more than 24 h old, the conversation resets to `main_menu` ("Welcome back, …") unless the message asks for something. Proof states are exempt.
4. **Escapes**:
   - `0`, "menu" or "cancel" → main menu.
   - "back" → parent state.
   - `9` or "agent" → a consultant. Inside data-collection states only the words count: a bare "9" answering "how many?" is data.
5. **Shortcuts**:
   - "accept" (any state except the confirmation screens) accepts the client's sent quote.
   - `BRQ-Q-…` / `BRQ-O-…` references.
   - Quote status, "changes" to a sent quote, proof answers.
   - Keywords: `track`, `hours`, `layby`, `branding`, `store`, `quote`, `ticket`, `make_order`.
6. **The state's own handler** (`STATE_HANDLERS`). Free text at a menu goes to `freeText.js`, where the AI routes it, answers it, or escalates it.

Other behaviours:

- A **new conversation** first gets `HIGH_VOLUME_NOTICE` (when `busy_mode=true`) or `OUTSIDE_HOURS_ACK` (outside Mon–Fri 8–17, Sat 8–13 SAST, excluding SA public holidays).
- Any turn outside `consultant_active` may also queue one `OVERDUE_QUOTE_REMINDER`, for a draft quote past its 4-hour `sla_remind_at`. It runs once per quote, under a savepoint.

**Main menu** (`templates.js` `MAIN_MENU`, handled in `states/menu.js`):

| Reply | Action |
|---|---|
| 1 | School uniforms (parents) → `retail_menu` |
| 2 | Bulk orders (schools/companies) → `corporate_menu`. A retail client with a known organisation becomes school or corporate. |
| 3 | Get a quote |
| 4 | Place an order |
| 5 | Track my order |
| 6 | Report a problem |
| 7 | Store hours & location |
| 9 | Talk to a person (router). `8` also reaches a person, from the old numbering. |
| 0 | This menu (any time) |

**States** (`lifecycle/machines.js` `BOT_STATES`):

| Group | States |
|---|---|
| Menu | `main_menu` |
| Retail | `retail_menu`, `retail_pricing`, `retail_size_ask`, `retail_layby`, `retail_hours`, `retail_collection_ask`, `retail_school_select` |
| Corporate | `corporate_menu`, `corporate_repeat_order_ask`, `corporate_manufacturing_ask`, `corporate_delivery_ask`, `corporate_account_query` |
| Quotation | `quotation_ask_description`, `quotation_gathering` |
| Order | `order_ask_method`, `order_ask_reference`, `order_gathering`, `order_confirm_quote`, `order_confirm_direct`, `order_tracking_ask` |
| Ticket | `ticket_ask_category`, `ticket_ask_description` |
| Proof | `proof_review`, `proof_revision_describe` |
| Registration | `registration_name`, `registration_org_or_school`, `registration_address` |
| Human | `awaiting_consultant`, `consultant_active` |

**Media messages:**

- A placeholder such as `[image received] caption` is stored (unread), keeping the Meta `media_id`.
- Photos sent while a ticket is being reported, or within 30 min after it was logged, are linked to that ticket.
- In consultant states the bot stays silent.
- Otherwise the client gets `MEDIA_RECEIVED` once per burst, and staff are emailed.

## 5. AI usage and guard rails (`integrations/ai.client.js`)

- The model is Gemini `gemini-2.5-flash`. Every call has a timeout (`AI_TIMEOUT_MS`, default 20 s), uses a JSON response schema, and validates the parsed shape. Any failure falls back safely:

| Call | Purpose | Fallback on failure |
|---|---|---|
| `gatherQuotationInfo` | Ask for the missing details (at most 2 follow-ups) | Proceed with the client's text |
| `parseQuotationRequest` | Match items to catalogue product ids (integer quantity schema) | No items; the whole text is unmatched, so a consultant prices it |
| `suggestLineItemPricing` | Price hints for unmatched items, shown to staff | Lines with `unitPrice 0`, "manual pricing required" |
| `routeFreeText` / `answerFaq` | Route, answer from the provided info, or escalate | "Didn't catch that" with options, or escalate |
| `parseRegistrationDetails`, `classifyTicketCategory` | Profile fields; ticket category | Simple parsing; `other` |

- **Gemini never sets authoritative prices.**
  - Auto-priced lines use `products.price` from the database (`createFromFreeText`).
  - AI price suggestions go only onto **draft** lines (`priceConfirmed:false`, with an `aiNote`) for a consultant to review.
  - A draft's total is **never shown to the client** (`QUOTE_STATUS` hides it; `QUOTATION_DRAFT_ACK` shows no amount).
- **Auto-quote** (`modules/quotations/service.js` and `states/quote.js`) happens only when all of these hold:
  - every line matches an active catalogue product
  - each quantity is a whole number from 1 to `MAX_AUTO_QUANTITY` (5000)
  - any size breakdown sums to the quantity (FIN-4)
  - it is not a replayed turn

  In that case `autoApproveQuotation` sets the quote to `sent` and queues the PDF. Anything else becomes a draft, the chat goes to `awaiting_consultant`, and staff are emailed.
- **Direct catalogue orders** ("Place an order" without a quote) price lines at the catalogue price, and the client confirms a summary with totals before the order is created.

**Partially implemented:** direct orders only check that a product matched and `quantity > 0`. They do not apply the whole-number, `MAX_AUTO_QUANTITY` or size-sum checks used for auto-quotes. **Requires manual business verification.**

**Requires manual business verification:** a product priced `0` (e.g. from `seed-catalog.js`) is auto-quoted at R 0.00.

### Replay idempotency (DAT-2)

A turn can be replayed after a crash, a deploy or a failed commit.

| Record | How a replay is made safe |
|---|---|
| Quotation | `quotations.source_event_id` = the `inbound_events.id`, plus a partial unique index. A replay returns the existing quotation (no second AI call) and never auto-sends a draft again. |
| Ticket | `tickets.source_event_id`, the same way |
| Direct order | Keyed through its accepted quotation's `source_event_id` (`orderForEvent`) and `uniq_orders_quotation`. `placeDirectOrder` removes `pendingOrderItems` from the conversation context **in the order transaction**, so a second "yes" cannot place the order again. |
| Unsent staff email | `reminder.scan` picks up bot-made drafts and tickets whose staff email never went out (`notified_at IS NULL AND source_event_id IS NOT NULL`, after 2 h) (MSG-4). |

### Quote acceptance and ordering

- "accept" marks the latest sent, still-valid quote as `accepted`, emails staff, and tells the client their consultant will confirm. **The order is created by staff.**
- An expired quote offers a refresh at today's prices: "1" emails staff a revision request.
- "Place an order" with a quote reference creates the order through the bot (`bot_accept`).
- **FIN-2:** an **accepted** quote past its validity is refused with `QUOTE_EXPIRED`, and the client is offered a refresh. Staff conversion is unchanged.

## 6. Human handover (`states/handoff.js`)

| State | Bot behaviour |
|---|---|
| `awaiting_consultant` | Entered on "9", unmatched quotes and tickets. Staff are emailed.<br>The first message, and the first after 30 min of silence, gets `CONSULTANT_ACK` with hours. "9" gets "you're in the queue". "0" or "menu" cancels the request. |
| `consultant_active` | Set by takeover, or by a staff reply to an awaiting chat. The **bot is silent**. Only an explicit "0" or "menu" hands the chat back. |

- Sending a quote (`approve`) returns an `awaiting_consultant` chat to `main_menu`, so the client's "accept" is handled.
- **Unanswered-chat reminder (MSG-2, Implemented).** `reminder.scan` emails the chat owner when all of these hold:
  - the chat is `consultant_active`
  - the client's latest inbound message is more than 2 h old
  - there has been no outbound reply since then

  If the owner is inactive or has no email, every active consultant is emailed instead. Each message is reminded about once (`unanswered_reminder_at`).
- **Not implemented:** automatic release of a forgotten `consultant_active` chat.

## 7. Outbound path (`workers/handlers/whatsapp.send.js`, `modules/notifications/whatsapp.js`)

- `queueWhatsAppText` / `queueRecordedText` enqueue `whatsapp.send` on the caller's transaction, with `queue_key out:<phone>`, so each recipient's messages stay in order.
- Recorded texts get an inbox row at once (status `queued`, `job_id`).

| Concern | Behaviour |
|---|---|
| 24-hour window | For a message with a `templateFallback`, the handler checks the client's last inbound message (any client row with that number). If it is older than 24 h minus 5 min, or there is none, the approved template from **`WHATSAPP_TEMPLATES`** is sent instead; a document becomes the template header. `quotation.pdf.send` applies the same rule with `quote_ready`. |
| No template configured | The message is marked **`needs_template`**, and staff are emailed (`notifyUndeliverable`). The job completes and is **not retried**. **Requires external configuration:** without `WHATSAPP_TEMPLATES`, business-initiated messages outside 24 h are **not delivered**. |
| Meta 131047 | Synchronous: the template fallback is sent, or the message is marked `needs_template` with an email. Via a `failed` receipt: `message.status` → `handleReengagementFailure` queues the template, or marks the message `needs_template` with an email. |
| Permanent errors (MSG-3) | HTTP **400/404** from Graph, except retryable codes (4, 80007, 130429, 131048, 131056, 131000, 131016, 190, 2) and 131047, becomes a `PermanentJobError`: dead-lettered at once instead of blocking the client's queue. Other errors retry with backoff (8 attempts; 5 for broadcast sends). |
| Clipping | Text is clipped to 4096 characters and captions to 1024 (code points, ending in "…"). Bot list messages stay under 3800. Template parameters are whitespace-collapsed and capped at 900. |
| Idempotency | A `messages` row with this `job_id` already sent means a crash happened between send and complete, so the job skips. Dead-lettered sends mark the row `failed` (also `settleDeadSends`). |

Logical templates (`TEMPLATE_FALLBACKS`) and where they are used:

| Template | Used for |
|---|---|
| `order_stage` | Stage updates, deposit request |
| `payment_received` | Payment receipts |
| `proof_ready` | Proof sent to the client |
| `ticket_resolved` | Ticket resolved |
| `quote_ready` | Quote PDF |
| `consultant_reply` | Staff replies |
| `order_delay` | Supplier delay (hold + delay broadcast) |
| `quote_expiring` | Defined, but **no code sends it (Not implemented)** |

**Messages with no fallback are always sent as free text:**

- bot replies (always inside the window)
- custom and busy broadcasts
- takeover and handback notices

Outside the window, Meta refuses them with 131047. When the message has an inbox row, it ends as `needs_template` with a staff email per message. A broadcast to a client with no chat isn't stored, so its failure is never seen. **Requires manual business verification** for broadcasts to inactive clients.

`quotation.pdf.send` doesn't apply the permanent-error rule. A 4xx on upload or send retries until it is dead-lettered.

## 8. Delivery receipts (`message.status`)

- Statuses only move forward (`queued` < `sent` < `delivered` < `read`). `failed` always applies.
- A receipt for a row that isn't stored yet is retried (3 attempts), then dropped.

## 9. Broadcasts

| Step | Behaviour |
|---|---|
| Request | The route stores a `broadcasts` row (`queued`, `recipient_count`) and enqueues one `broadcast.fanout` job (`dedupe broadcast:<id>:fanout`) in one transaction, then returns 202. |
| Audiences | `custom` requires `audience` ∈ `all_clients`, `active_orders`, `corporate`, `retail` (one recipient per WhatsApp number).<br>`delay` sends one message per open order of **non-retail** clients.<br>`busy` goes to every client with an open order. |
| Fan-out | One `whatsapp.send` per recipient:<br>• `dedupe broadcast:<id>:<clientId>[:<ref>]`, so a re-run sends nothing twice<br>• staggered `run_at` at `BROADCAST_RATE_PER_SEC` (default 20/s)<br>• no queue key<br>• 5 attempts<br>The broadcast becomes `sending`. |
| Counting (MSG-5) | Each send's outcome is inserted into `broadcast_outcomes` (PK `job_id`), and `sent_count`/`failed_count` are bumped in the same statement, so a send is never counted twice. The broadcast becomes `done` once every recipient has an outcome. `settleDeadSends` counts sends that were dead-lettered by `reclaimStale`. |
| Window | Only `delay` carries a template fallback (`order_delay`). The first-name parameter is always "there", because recipients carry no name. |

## 10. Reminders and expiry (scheduled every 30 min)

**`reminder.scan`** (advisory-locked). Each reminder is stamped first, only if the item is still unclaimed (Q-3):

| Item | Condition | Email to |
|---|---|---|
| Draft quotation | Unclaimed 2 h after `notified_at`. Also bot drafts with no `notified_at` (MSG-4). | Active consultants |
| Open / in-progress ticket | Same rule | Active consultants |
| `awaiting_consultant` conversation | Unclaimed 2 h after `notified_at` | Active consultants |
| `consultant_active` chat | Unanswered for 2 h (MSG-2) | The owner (fallback: consultants) |

Staff notification emails go to **active staff with role `consultant`** unless a specific owner is targeted. Admins and managers aren't on the default list. `NOTIFICATION_OVERRIDE_EMAIL` routes all email to one inbox.

**`quotation.expire`** (advisory-locked) persists `status='expired'` on **sent** quotes whose validity date (South African calendar) has passed. Reads already treat such quotes as expired. Accepted quotes are never auto-expired.
