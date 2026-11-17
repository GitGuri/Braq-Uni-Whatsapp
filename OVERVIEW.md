# Braq Connect™: Overview

## What it is

Braq Connect is the WhatsApp sales and service platform for **Braq Uni**, a South African uniform and
branded-clothing supplier. Customers do everything on WhatsApp: browse, get quotes, place and track
orders, and report problems. Braq Uni staff run the same work from a web dashboard.

It has two parts:

1. **A WhatsApp assistant (the bot)**, which customers chat with on Braq Uni's WhatsApp number.
2. **A staff dashboard**, where consultants, managers and admins handle quotes, orders, payments,
   complaints and customer conversations.

## Who it serves

- **Parents** buying a few school-uniform items (retail).
- **Bulk buyers** such as schools, companies, hospitality, churches, security firms, government and
  resellers. They order large quantities, often with logos or crests.
- **Braq Uni staff:** consultants (day-to-day client work), managers and admins (pricing, purchase
  orders, staff, reporting).

## What customers can do on WhatsApp

The bot shows a numbered menu. Customers can also type in plain language, and AI works out what they mean.

| # | Option | What happens |
|---|---|---|
| 1 | School uniforms | Pick or type a school to see its uniform items and prices |
| 2 | Bulk orders | A guided flow for schools and companies |
| 3 | Get a quote | The customer describes what they need, e.g. *"50 navy golf shirts, logo on the chest"*. AI turns this into a quotation. If every item matches the catalogue, the quote PDF goes out automatically. Otherwise a consultant prices it first. |
| 4 | Place an order | Start an order |
| 5 | Track my order | See which stage the order is at |
| 6 | Report a problem | Opens a ticket (wrong item, defective, missing item, and so on) |
| 7 | Store hours & location | |
| 9 | Talk to a person | Hands the chat to a consultant |

Customers also get **automatic updates**: quote ready or about to expire, payment received, design proof
ready to approve, order stage changes, delays, and resolved tickets. They reply *accept*, *approve* or
*changes* right in the chat.

## How a job flows

```
Enquiry → Quotation (PDF, valid for a limited time) → Accepted / client Purchase Order
       → Order created (60% deposit / 40% balance)
       → deposit_pending → in_production → ready → completed
```

Rules the system enforces:

- If a design proof was sent, production can't start until the client approves it.
- Orders can be put **on hold** (for example, a supplier fabric delay), and the client is told.
- Every stage change is recorded, and the client gets a WhatsApp update.
- Payment details are never sent over WhatsApp. A consultant arranges payment directly.

## What staff do in the dashboard

- **Jobs board:** each job in one place (conversation, quote, order, payments, tickets and history) with
  suggested next actions.
- **Inbox:** live WhatsApp conversations, so staff can take over from the bot.
- **Clients:** customer profiles and order history (CRM).
- **Products and School catalogue:** prices and school-specific uniform lists.
- **Purchase orders:** record a client's PO against a quote to create the order.
- **Tickets:** complaints and returns, with overdue tracking.
- **Broadcasts:** bulk messages to customers (delay notices, busy-period notices, custom messages).
- **Analytics:** revenue and KPIs.
- **Staff:** user accounts and roles (admin, manager, consultant).
- **Bulk size rosters:** upload a spreadsheet of sizes and print a size run sheet for production.

## Behind the scenes

- **Reminders:** consultants are emailed about quotes, tickets or chat requests nobody has picked up after 2 hours.
- **Quote expiry:** expired quotations are closed automatically.
- **The WhatsApp 24-hour rule:** outside the 24-hour reply window, the system switches to
  Meta-approved message templates. If no template exists for a message, it flags the message for staff.
- **Needs review:** quotes and orders missing information are flagged for a person to check.

## The goal

Move Braq Uni's customer communication and order handling onto one channel customers already use
(WhatsApp), with one place for staff to manage it. The aims are:

- **Faster responses:** the bot handles routine questions and simple quotes around the clock.
- **Fewer dropped requests:** every enquiry, quote and complaint is tracked and assigned, and reminders
  chase anything left unclaimed.
- **Customers kept informed** without staff having to message each one by hand.
- **Visibility for management:** pipeline, revenue and workload in one dashboard.

## Technology (short version)

Node.js/Express API, PostgreSQL (hosted on Supabase), React dashboard (Vite), Meta WhatsApp Cloud API,
Google Gemini for AI, Resend for email. See [README.md](README.md) for setup, the API reference and testing.
