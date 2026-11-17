// Consultant notifications (email). Who gets told what. Every email goes
// through the outbox: send() enqueues an 'email.send' job on the caller's
// transaction client, so the email is sent if — and only if — the domain write
// (and the notified_at stamp) commits, and a failed send is retried.
//
// Every notifier takes the db client first: notifyX(tx, ...). Pass the pool
// (or { query }) for a standalone notification.
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { enqueue } from '../../core/queue.js';
import { DEPOSIT_PERCENT } from '../../core/money.js';

/** Dashboard link to a job (a job is identified by its quotation). */
export const jobLink = (quotationId) => `${config.dashboardBaseUrl}/jobs/${quotationId}`;

// ── Fetch active consultants ───────────────────────────────────────────────────
async function getActiveConsultants(db) {
  const { rows } = await db.query(
    `SELECT id, name, email FROM staff WHERE role = 'consultant' AND is_active = true`
  );
  return rows;
}

/**
 * Queue one email to `recipients` (default: every active consultant).
 * @returns {Promise<boolean>} whether an email was queued
 */
async function send(db, subject, text, recipients = null) {
  const people = recipients ?? await getActiveConsultants(db);
  if (!people.length) {
    logger.warn('notifications: no active consultants found in DB — email skipped');
    return false;
  }

  const to = people.map((c) => c.email).filter(Boolean);
  if (!to.length) {
    logger.warn('notifications: recipients have no email addresses set — email skipped', {
      recipients: people.map((c) => c.name),
    });
    return false;
  }

  await enqueue(db, 'email.send', { to, subject, text });
  return true;
}

// ── Template helpers ───────────────────────────────────────────────────────────
function ts(date) {
  return new Date(date ?? Date.now()).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
}

function excerpt(text, len = 150) {
  if (!text) return '—';
  return text.length > len ? text.slice(0, len) + '…' : text;
}

// ── 1. New Quotation Enquiry ───────────────────────────────────────────────────
// Trigger: new quotation created with status = 'draft'
export async function notifyNewQuotation(db, quotation, client) {
  const summary = excerpt(
    Array.isArray(quotation.line_items) && quotation.line_items.length
      ? quotation.line_items.map((i) => `${i.quantity}× ${i.name ?? i.description ?? 'item'}`).join(', ')
      : quotation.notes
  );

  await send(db,
    `🆕 New Quotation Enquiry — Ref ${quotation.reference}`,
    `A new quotation request just came in and needs pricing.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? client.wa_id ?? '—'}
Summary: ${summary}
Received: ${ts(quotation.created_at)}

👉 Claim & view: ${jobLink(quotation.id)}

First consultant to claim it gets it — act fast!`
  );

  await db.query(
    `UPDATE quotations SET notified_at = NOW() WHERE id = $1`,
    [quotation.id]
  );
}

// ── 2. New Support Ticket ─────────────────────────────────────────────────────
// Trigger: new ticket created
export async function notifyNewTicket(db, ticket, client, orderReference = null) {
  const CATEGORY_LABELS = {
    wrong_item: 'Wrong item', defective: 'Defective item',
    missing_item: 'Missing item', account_query: 'Account Query', other: 'Other',
  };

  await send(db,
    `🎫 New Ticket — ${CATEGORY_LABELS[ticket.category] ?? ticket.category}`,
    `A customer has logged a support issue.

Client: ${client.name ?? 'Unknown'}
Category: ${CATEGORY_LABELS[ticket.category] ?? ticket.category}
Description: ${excerpt(ticket.description)}
Order ref (if linked): ${orderReference ?? 'N/A'}
Received: ${ts(ticket.created_at)}

👉 Claim & view: ${config.dashboardBaseUrl}/tickets/${ticket.id}`
  );

  await db.query(
    `UPDATE tickets SET notified_at = NOW() WHERE id = $1`,
    [ticket.id]
  );
}

// ── 3. Consultant Requested / Account Query ───────────────────────────────────
// Trigger: conversation state → awaiting_consultant
export async function notifyConsultantRequested(db, conversation, client, context = 'General enquiry') {
  await send(db,
    `💬 Customer wants to speak to a consultant — ${client.name ?? client.whatsapp_number ?? 'Unknown'}`,
    `A customer has asked to speak with a consultant.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
Context: ${excerpt(context, 200)}
Received: ${ts(conversation.created_at)}

👉 Claim & open chat: ${config.dashboardBaseUrl}/inbox/${conversation.id}`
  );

  await db.query(
    `UPDATE conversations SET notified_at = NOW() WHERE id = $1`,
    [conversation.id]
  );
}

// ── 4. Quotation Accepted by Client ──────────────────────────────────────────
/** The quotation / order owner (assigned staff) as a recipient list, or null → every consultant. */
async function ownerRecipients(db, staffId) {
  if (!staffId) return null;
  const { rows } = await db.query('SELECT id, name, email FROM staff WHERE id = $1 AND is_active = true', [staffId]);
  return rows.length && rows[0].email ? rows : null;
}

// The client accepted on WhatsApp. The order is NOT created automatically: the
// job shows on the dashboard as "Client accepted — create order".
export async function notifyQuotationAccepted(db, quotation, client) {
  await send(db,
    `🎉 Quotation Accepted — Ref ${quotation.reference} — client accepted, create the order`,
    `A client has accepted their quotation via WhatsApp (Quotation Accepted).

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? '—'}
Total: R ${Number(quotation.total ?? 0).toFixed(2)} (incl. VAT)
Accepted: ${ts(new Date())}

The client was told: "Your consultant will confirm your order and send the deposit details shortly."
Next step: create the order and send the client the ${DEPOSIT_PERCENT}% deposit details.

👉 View job: ${jobLink(quotation.id)}`,
    await ownerRecipients(db, quotation.assigned_staff_id)
  );
}

// ── 4b. Client asks for a refreshed / changed quotation ──────────────────────
/** kind: 'refresh' (expired quote, today's prices) | 'changes' (edits to a sent quote). */
export async function notifyQuoteRevisionRequested(db, quotation, client, { kind = 'changes', notes = null } = {}) {
  const refresh = kind === 'refresh';
  await send(db,
    refresh
      ? `🔄 Refresh expired quote — Ref ${quotation.reference}`
      : `✏️ Quote changes requested — Ref ${quotation.reference}`,
    `${refresh
      ? 'The client tried to accept an expired quotation and asked for it to be refreshed at current prices.'
      : 'The client asked for changes to their quotation on WhatsApp.'}

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? '—'}
Quote: ${quotation.reference} — R ${Number(quotation.total ?? 0).toFixed(2)} (incl. VAT)
${notes ? `Requested changes: ${excerpt(notes, 500)}
` : ''}Received: ${ts(new Date())}

Next step: revise the quote and send it again.

👉 Open the job: ${jobLink(quotation.id)}`,
    await ownerRecipients(db, quotation.assigned_staff_id)
  );
}

// ── 4c. Attachment received (photo, document, voice note…) ───────────────────
/** The bot cannot read attachments — tell the chat's owner (or the consultants). */
export async function notifyMediaReceived(db, conversation, client, { placeholder, ticketNo = null } = {}) {
  await send(db,
    `📎 Attachment from ${client.name ?? client.whatsapp_number ?? 'a client'}${ticketNo ? ` — ticket #${ticketNo}` : ''}`,
    `A client sent an attachment on WhatsApp (e.g. a proof of payment or a photo of a problem).

Client: ${client.name ?? 'Unknown'}
WhatsApp: ${client.whatsapp_number ?? '—'}
Attachment: ${excerpt(placeholder, 200)}
${ticketNo ? `Linked to ticket: #${ticketNo}
` : ''}Received: ${ts(new Date())}

👉 Open the chat: ${config.dashboardBaseUrl}/inbox/${conversation.id}`,
    await ownerRecipients(db, conversation.assigned_staff_id)
  );
}

// ── 4d. A WhatsApp message could not be delivered (24-hour window) ───────────
/**
 * A business-initiated message could not go out: the client last wrote more
 * than 24 hours ago and no approved WhatsApp template is configured for it.
 */
export async function notifyUndeliverable(db, { client = {}, conversationId = null, body, template = null, reason }) {
  await send(db,
    `⚠️ WhatsApp not delivered — ${client.name ?? client.whatsapp_number ?? 'client'}`,
    `A WhatsApp message to a client could not be delivered and needs a person to follow up.

Client: ${client.name ?? 'Unknown'}
WhatsApp: ${client.whatsapp_number ?? '—'}
Reason: ${reason}
${template ? `Template needed: ${template} (configure it in WHATSAPP_TEMPLATES once Meta approves it)
` : ''}Message: ${excerpt(body, 500)}

${conversationId ? `👉 Open the chat: ${config.dashboardBaseUrl}/inbox/${conversationId}` : 'Please contact the client another way (phone or email).'}`
  );
}

// ── 5. New WhatsApp Order ─────────────────────────────────────────────────────
export async function notifyNewOrder(db, order, client) {
  await send(db,
    `🛒 New WhatsApp Order — Ref ${order.reference}`,
    `A customer has placed an order directly via WhatsApp and needs a consultant assigned.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? '—'}
Deposit due (${DEPOSIT_PERCENT}%): R ${Number(order.deposit_amount ?? 0).toFixed(2)}
Received: ${ts(order.created_at)}

Next step: collect the ${DEPOSIT_PERCENT}% deposit to begin production.

👉 View & assign: ${order.quotation_id ? jobLink(order.quotation_id) : `${config.dashboardBaseUrl}/orders/${order.id}`}`
  );
}

// ── 6. Reminder (unclaimed after 2 hours) ─────────────────────────────────────
export async function sendReminder(db, item, type) {
  const TYPE_LABELS = { quotation: 'Quotation', ticket: 'Ticket', conversation: 'Consultant Request' };

  // Mark the reminder first, only while the item is still unclaimed and unreminded:
  // a claim that landed after the scan read the row means no email (Q-3).
  const reminderCol = type === 'quotation' ? 'staff_reminder_sent_at' : 'reminder_sent_at';
  const table = type === 'quotation' ? 'quotations' : type === 'ticket' ? 'tickets' : 'conversations';
  const { rows: still } = await db.query(
    `UPDATE ${table} SET ${reminderCol} = NOW()
     WHERE id = $1 AND assigned_staff_id IS NULL AND ${reminderCol} IS NULL RETURNING id`,
    [item.id]
  );
  if (!still.length) return false;

  const link = type === 'quotation'
    ? jobLink(item.id)
    : type === 'ticket'
    ? `${config.dashboardBaseUrl}/tickets/${item.id}`
    : `${config.dashboardBaseUrl}/inbox/${item.id}`;

  const hoursAgo = Math.round((Date.now() - new Date(item.notified_at).getTime()) / 3_600_000);

  await send(db,
    `⏰ Reminder — still unclaimed: ${item.reference ?? item.client_name ?? 'Unknown'}`,
    `This is still waiting for a consultant, ${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} after it came in:

Type: ${TYPE_LABELS[type] ?? type}
Client: ${item.client_name ?? '—'}
Reference: ${item.reference ?? 'N/A'}

👉 Claim & view: ${link}

Please pick this up as soon as you can — the customer is waiting.`
  );
  return true;
}

// ── 6b. A consultant-owned chat whose client is waiting for an answer (MSG-2) ─
/**
 * Stamp the reminder (only if this inbound message was not reminded about yet and
 * no reply went out meanwhile), then email the chat's owner — or every active
 * consultant when the owner is inactive or has no email.
 * @param {{ id, assigned_staff_id, client_name, last_inbound_at }} chat
 * @returns {Promise<boolean>} whether a reminder was queued
 */
export async function sendUnansweredChatReminder(db, chat) {
  const { rows: still } = await db.query(
    `UPDATE conversations SET unanswered_reminder_at = NOW()
     WHERE id = $1 AND state = 'consultant_active'
       AND (unanswered_reminder_at IS NULL OR unanswered_reminder_at < $2)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = $1 AND m.direction = 'outbound' AND m.created_at > $2)
     RETURNING id`,
    [chat.id, chat.last_inbound_at]
  );
  if (!still.length) return false;
  const { rows: owner } = chat.assigned_staff_id
    ? await db.query('SELECT id, name, email FROM staff WHERE id = $1 AND is_active = true', [chat.assigned_staff_id])
    : { rows: [] };
  const hoursAgo = Math.max(1, Math.round((Date.now() - new Date(chat.last_inbound_at).getTime()) / 3_600_000));
  await send(db,
    `⏰ Client waiting for your reply — ${chat.client_name ?? 'Unknown'}`,
    `${chat.client_name ?? 'A client'} wrote ${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago in a chat you took over, and has had no reply.
The bot stays silent while a consultant owns the chat — reply, or hand it back to the bot.

👉 Open the chat: ${config.dashboardBaseUrl}/inbox/${chat.id}`,
    owner[0]?.email ? owner : null
  );
  return true;
}

// ── 7. Proof feedback from the client (approve / changes requested) ─────────
/**
 * Tell the order's owner (assigned staff) — or, when nobody owns it, every
 * active consultant — that the client approved the proof or asked for changes.
 */
export async function notifyProofFeedback(db, order, client, { status, notes = null } = {}) {
  const { rows: owner } = order.assigned_staff_id
    ? await db.query('SELECT id, name, email FROM staff WHERE id = $1 AND is_active = true', [order.assigned_staff_id])
    : { rows: [] };
  const approved = status === 'approved';
  const link = order.quotation_id ? jobLink(order.quotation_id) : `${config.dashboardBaseUrl}/orders/${order.id}`;

  return send(db,
    approved
      ? `✅ Proof approved — Order ${order.reference}`
      : `✏️ Proof changes requested — Order ${order.reference}`,
    `${approved ? 'The client approved the proof on WhatsApp.' : 'The client asked for changes to the proof on WhatsApp.'}

Client: ${client?.name ?? 'Unknown'}
Order: ${order.reference}
${approved ? 'Next step: start production once the deposit is in.' : `Requested changes: ${excerpt(notes, 500)}

Next step: update the design and send a new proof.`}
Received: ${ts(new Date())}

👉 Open the job: ${link}`,
    owner.length && owner[0].email ? owner : null
  );
}
