# Braq Connect™: System Q&A

Answers to five questions about the system. Each answer is based on the code in `backend/` and `frontend/`.
For setup and the API reference, see [README.md](README.md). For a plain-language summary, see
[OVERVIEW.md](OVERVIEW.md).

---

## 1. What does the system actually do?

Braq Connect runs **Braq Uni's sales and after-sales on WhatsApp**. Braq Uni is a South African supplier
of school uniforms and branded workwear.

- A **WhatsApp bot** answers customers 24/7. It handles menus, uniform prices by school, store hours,
  AI-answered questions, quote requests, orders, order tracking and complaints. When a customer asks
  for a person, it hands the chat over.
- A **staff dashboard** (React) is where consultants price and send quotes, create orders, record
  payments, send design proofs, move orders through production, handle tickets and reply to customers
  in a shared inbox.
- A **background worker** sends every WhatsApp message and email, processes incoming messages, expires
  old quotes and reminds staff about work nobody has picked up.

The system holds the business rules for the job. Prices are excluding VAT, with VAT at 15%. Orders take
a 60% deposit with the 40% balance due later. Quotes are valid for 30 days. Production can't start
without a deposit and an approved design proof, and an order can't be completed until it's paid in full.

---

## 2. Who uses it?

| User | Channel | What they do |
|---|---|---|
| **Parents** (retail clients) | WhatsApp | Look up school uniforms, ask about sizes, order a few items, track orders |
| **Bulk clients**: schools, companies, hospitality, churches, security, government, resellers | WhatsApp | Request quotes for branded items in bulk, accept quotes, approve design proofs, send POs |
| **Consultants** | Dashboard | Price and send quotes, run orders, record payments, answer chats, resolve tickets |
| **Managers** | Dashboard | Everything consultants do, plus overriding order rules (with a reason), broadcasts, analytics, pricing, POs, account terms |
| **Admins** | Dashboard | Everything, plus staff accounts |

Roles and permissions are defined in one place, `backend/src/core/rbac.js`.

---

## 3. What are the core flows?

### a) An inbound WhatsApp message

```
Meta webhook → verify signature → store event (deduped by Meta message id)
  → queue 'inbound.process' (one queue per phone number, processed in order)
  → bot turn: detect intent → state handler → replies + state changes
  → ONE transaction commits everything → replies go out via 'whatsapp.send'
```

### b) Quote to cash (the main business flow)

```
Client describes need ("50 navy golf shirts, logo on chest")
  → AI asks up to 2 follow-up questions for anything still missing
  → Draft quotation (BRQ-Q-YYYYMMDD-NNNN)
       ├─ every item matched the catalogue → priced and the PDF is sent automatically
       └─ otherwise → a consultant claims, prices and sends it
  → Client replies "accept" (or sends a Purchase Order, recorded by a manager)
  → Order created (BRQ-O-NNNNN): deposit_pending
  → Deposit recorded → design proof sent → client replies "approve"
  → in_production → ready → balance recorded → completed
```

The client receives a WhatsApp message at each step. Each stage change is written to
`order_stage_history`.

### c) Complaint or return

Client picks "Report a problem". AI classifies it (wrong item, defective, missing item, account query or
other) and opens a ticket. Staff are emailed. Staff resolve it, and the client is notified. The SLA is
4 hours, and tickets past it show as overdue.

### d) Human handover

Client sends "9" or "talk to a person". The chat moves to `awaiting_consultant` and staff are emailed.
Once a consultant takes it (`consultant_active`), the bot stays silent until the client sends "0" or
"menu". "Accept" still works during this time.

### e) Messages the business starts

Stage updates, receipts, proofs and broadcasts go out as free text if the client wrote in the last
24 hours. After that, they go out as Meta-approved templates. If no template is configured, the message
is marked `needs_template` and staff are emailed to follow up by hand.

### f) Scheduled work (every 30 minutes)

- Expire quotes past their validity.
- Email staff about quotes, tickets or handover requests nobody has claimed for 2 hours.

---

## 4. What could go wrong?

### Operational and launch risks (most likely)

| Risk | Effect | Mitigation / status |
|---|---|---|
| **`WHATSAPP_TEMPLATES` not configured** (it currently isn't set in `.env`) | Every update sent more than 24 hours after the client's last message is undelivered. That covers stage changes, receipts, quote-ready and delays: most of the order lifecycle. | Register the 8 templates in WhatsApp Manager and map them (see README). |
| **Catalogue prices still placeholders (0)** | Auto-quotes are wrong or never sent automatically, so consultants end up pricing everything. | Load real prices and school catalogues before launch. |
| **Gemini slow, down or out of quota** | Free-text questions and quote gathering degrade. | Calls time out after 20 seconds and fall back to "a consultant will help", so nothing crashes. But more work lands on staff. |
| **Meta token expires or the number is rate-limited** | Outbound sends fail. | Retried with backoff (up to 8 attempts), then marked failed in the inbox. Someone needs to watch for dead jobs. |
| **`META_APP_SECRET` unset** | Webhook signatures aren't checked, so anyone could post fake inbound messages. | The app logs a warning and carries on. It should be required in production. |
| **No direct DB URL (`DATABASE_DIRECT_URL`)** | Migrations and the worker's LISTEN/NOTIFY may misbehave through Supabase's transaction pooler. | Set it for production. |
| **Email reminders go to the wrong place** | `NOTIFICATION_OVERRIDE_EMAIL` reroutes staff emails. | Confirm it's unset (or intended) in production. |

### Process risks

- **A chat stuck with a consultant.** In `consultant_active` the bot is silent until the client sends
  "0". If a consultant forgets a chat, the client gets no replies. As far as the code shows, the 24-hour
  "welcome back" reset doesn't apply to consultant-owned chats.
- **Overrides become routine.** Managers can bypass the deposit, proof and balance checks with a reason
  (at least 5 characters). The overrides are logged, but nothing reports on them.
- **Unclaimed work.** Quotes needing pricing depend on consultants claiming them. Reminders fire after
  2 hours, but only by email.
- **AI misreads a request.** A quote is auto-sent only when every item matches the catalogue. Even then,
  the AI's quantity or size reading could be wrong, and the client sees the quote first.

### Technical risks to keep an eye on

- **Turn atomicity has one gap.** A bot turn commits replies and state in one transaction. But domain
  writes, such as creating a quotation or ticket, happen *before* that transaction. If the commit fails
  and the job retries, it's worth checking that duplicate quotes or tickets can't be created.
- **Public quote PDF links.** `GET /api/quotations/:id/pdf` has no login, because Meta has to fetch it.
  Anyone holding the link can see the client's name, number and prices. Drafts are protected.
- **Staff JWT in `localStorage`.** This is standard, but an XSS bug in the dashboard would expose
  sessions.
- **Two copies of the job-state logic.** Job state is derived both in JavaScript (`lifecycle/derive.js`)
  and in SQL (`lifecycle/sql.js`). Tests compare them, but every rule change has to be made in both.
- **The `jobs` table grows.** Finished jobs are pruned after 14 days, but dead-lettered jobs stay until
  someone handles them.
- **Real production data.** The local `.env` points at the live Supabase database. Run scripts only
  through the throwaway-DB test harness. `db:reset` refuses to run against Supabase.

---

## 5. What are the complex patterns?

1. **Transactional outbox and durable job queue.** `core/queue.js` is a Postgres `jobs` table, not
   Redis. Jobs are inserted in the same transaction as the business change, so a message is only queued
   if the change committed. Workers claim jobs with `FOR UPDATE SKIP LOCKED`. Failed jobs retry with
   exponential backoff and jitter, then dead-letter. Jobs left running by a crashed worker are
   reclaimed after 5 minutes. `pg_notify` wakes workers at once.

2. **Per-customer ordering with a queue key.** Jobs that share a `queueKey` (`wa:<phone>`) run strictly
   one at a time, in order. A customer's messages are never processed in parallel or out of order.
   Broadcasts use no queue key, so they don't hold up bot replies.

3. **Idempotency at every layer.**
   - Inbound events are deduped by Meta message ID.
   - Jobs take a `dedupeKey` (status receipts, broadcast recipients, re-engagement retries).
   - `whatsapp.send` checks whether this job's message was already sent, which covers a crash between
     sending and marking the job done.
   - The scheduler uses time buckets, so several instances don't double-run a task.

4. **The bot as a state machine with a "turn" object.** Handlers never write to the database or send
   directly. They *record* replies, state changes and notifications on the turn (`bot/reply.js`), which
   commits them all at once. On top of that, `bot/router.js` applies a precedence order: pending
   follow-ups, then handover states, then the stale-chat reset, then escapes (0, back, 9), then global
   intents, then the state's own handler. Keywords are turned off while collecting data, so a bare "9"
   answering "how many?" stays a number.

5. **Lifecycle as data.** `lifecycle/machines.js` defines every state machine as plain data: quote
   statuses, order stages, proof and payment statuses, bot states and derived job states. Guards
   (`guards.js`) are pure functions that return every blocker, each marked overridable or not.
   `nextActions.js` suggests the next step on the dashboard. A "job" (quote, order and tickets) has no
   stored status. It's derived from the underlying records.

6. **The WhatsApp 24-hour window.** Each business-initiated message carries a `templateFallback`. The
   sender checks the window (with a 5-minute margin) and switches to the approved template. Meta error
   131047 also triggers the switch, whether it comes back at send time or later in a delivery receipt.
   If no template is configured, staff are told by email and the job is not retried.

7. **AI with guard rails.** Every Gemini call has a timeout, a JSON schema and a shape check, plus a
   deterministic fallback. AI calls never run inside a database transaction. Quote gathering stops after
   2 follow-up questions and hands over whatever it has.

8. **Money in integer cents.** All calculations use cents (`core/money.js`), with half-up VAT rounding.
   The balance is "total minus deposit", so deposit plus balance always equals the total exactly.
   Client-supplied line totals are recalculated, never trusted.

9. **South African time everywhere.** Business hours, public holidays (including Easter-based ones and
   observed Mondays), quote reference dates and "today" are all computed in `Africa/Johannesburg`,
   whatever time zone the server is in.

10. **Safe schema migrations.** Migrations are versioned SQL files. Each runs once under an advisory lock
    in its own transaction, and checksums are verified. The API runs no DDL and refuses to start while
    migrations are pending.
