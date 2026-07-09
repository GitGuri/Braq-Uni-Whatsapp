import { Resend } from 'resend';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const resend = new Resend(config.resend.apiKey);

// ── Fetch active consultants ───────────────────────────────────────────────────
async function getActiveConsultants() {
  const { rows } = await query(
    `SELECT id, name, email FROM staff WHERE role = 'consultant' AND is_active = true`
  );
  return rows;
}

async function send(subject, text) {
  const consultants = await getActiveConsultants();
  if (!consultants.length) {
    logger.warn('notification.service: no active consultants, email skipped');
    return;
  }
  const to = consultants.map((c) => c.email);
  logger.info('Sending consultant email', { from: config.resend.fromEmail, to, subject });
  const { data, error } = await resend.emails.send({
    from: `Braq Connect <${config.resend.fromEmail}>`,
    to,
    subject,
    text,
  });
  if (error) {
    logger.error('Resend rejected email', { error, to, from: config.resend.fromEmail });
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
  logger.info('Consultant notification sent', { subject, recipients: to.length, messageId: data?.id });
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
export async function notifyNewQuotation(quotation, client) {
  const summary = excerpt(
    Array.isArray(quotation.line_items) && quotation.line_items.length
      ? quotation.line_items.map((i) => `${i.quantity}× ${i.name ?? i.description ?? 'item'}`).join(', ')
      : quotation.notes
  );

  await send(
    `🆕 New Quotation Enquiry — Ref ${quotation.reference}`,
    `A new quotation request just came in and needs pricing.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? client.wa_id ?? '—'}
Summary: ${summary}
Received: ${ts(quotation.created_at)}

👉 Claim & view: ${config.dashboardBaseUrl}/quotations/${quotation.id}

First consultant to claim it gets it — act fast!`
  );

  await query(
    `UPDATE quotations SET notified_at = NOW() WHERE id = $1`,
    [quotation.id]
  );
}

// ── 2. New Support Ticket ─────────────────────────────────────────────────────
// Trigger: new ticket created
export async function notifyNewTicket(ticket, client, orderReference = null) {
  const CATEGORY_LABELS = {
    wrong_item: 'Wrong item', defective: 'Defective item',
    missing_item: 'Missing item', account_query: 'Account Query', other: 'Other',
  };

  await send(
    `🎫 New Ticket — ${CATEGORY_LABELS[ticket.category] ?? ticket.category}`,
    `A customer has logged a support issue.

Client: ${client.name ?? 'Unknown'}
Category: ${CATEGORY_LABELS[ticket.category] ?? ticket.category}
Description: ${excerpt(ticket.description)}
Order ref (if linked): ${orderReference ?? 'N/A'}
Received: ${ts(ticket.created_at)}

👉 Claim & view: ${config.dashboardBaseUrl}/tickets/${ticket.id}`
  );

  await query(
    `UPDATE tickets SET notified_at = NOW() WHERE id = $1`,
    [ticket.id]
  );
}

// ── 3. Consultant Requested / Account Query ───────────────────────────────────
// Trigger: conversation state → awaiting_consultant
export async function notifyConsultantRequested(conversation, client, context = 'General enquiry') {
  await send(
    `💬 Customer wants to speak to a consultant — ${client.name ?? client.whatsapp_number ?? 'Unknown'}`,
    `A customer has asked to speak with a consultant.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
Context: ${excerpt(context, 200)}
Received: ${ts(conversation.created_at)}

👉 Claim & open chat: ${config.dashboardBaseUrl}/inbox/${conversation.id}`
  );

  await query(
    `UPDATE conversations SET notified_at = NOW() WHERE id = $1`,
    [conversation.id]
  );
}

// ── 4. Reminder (unclaimed after 2 hours) ─────────────────────────────────────
export async function sendReminder(item, type) {
  const TYPE_LABELS = { quotation: 'Quotation', ticket: 'Ticket', conversation: 'Consultant Request' };
  const link = type === 'quotation'
    ? `${config.dashboardBaseUrl}/quotations/${item.id}`
    : type === 'ticket'
    ? `${config.dashboardBaseUrl}/tickets/${item.id}`
    : `${config.dashboardBaseUrl}/inbox/${item.id}`;

  const hoursAgo = Math.round((Date.now() - new Date(item.notified_at).getTime()) / 3_600_000);

  await send(
    `⏰ Reminder — still unclaimed: ${item.reference ?? item.client_name ?? 'Unknown'}`,
    `This is still waiting for a consultant, ${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} after it came in:

Type: ${TYPE_LABELS[type] ?? type}
Client: ${item.client_name ?? '—'}
Reference: ${item.reference ?? 'N/A'}

👉 Claim & view: ${link}

Please pick this up as soon as you can — the customer is waiting.`
  );

  // Mark reminder sent using the correct column per table
  const reminderCol = type === 'quotation' ? 'staff_reminder_sent_at' : 'reminder_sent_at';
  const table = type === 'quotation' ? 'quotations' : type === 'ticket' ? 'tickets' : 'conversations';
  await query(`UPDATE ${table} SET ${reminderCol} = NOW() WHERE id = $1`, [item.id]);
}
