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
    logger.warn('notification.service: no active consultants found in DB — email skipped');
    return;
  }

  let to = consultants.map((c) => c.email).filter(Boolean);
  if (!to.length) {
    logger.warn('notification.service: active consultants have no email addresses set — email skipped', {
      consultants: consultants.map((c) => c.name),
    });
    return;
  }

  // Allow a single override email (for testing before braquni.com is verified on Resend)
  if (config.resend.overrideEmail) {
    logger.info('notification.service: NOTIFICATION_OVERRIDE_EMAIL set — routing all notifications to override address');
    to = [config.resend.overrideEmail];
  }

  const fromEmail = config.resend.fromEmail;

  // Warn when using Resend's shared test address — only delivers to the account owner
  if (fromEmail === 'onboarding@resend.dev') {
    logger.warn(
      'notification.service: FROM_EMAIL is still onboarding@resend.dev — ' +
      'Resend only delivers from this address to your Resend account owner email. ' +
      'Set NOTIFICATION_OVERRIDE_EMAIL=your@email.com to receive notifications now, ' +
      'or verify braquni.com at resend.com/domains and set FROM_EMAIL=notifications@braquni.com.'
    );
  }

  logger.info('Sending consultant email', { from: fromEmail, to, subject });
  const { data, error } = await resend.emails.send({
    from:    `Braq Connect <${fromEmail}>`,
    to,
    subject,
    text,
  });
  if (error) {
    logger.error('Resend rejected email', {
      error,
      to,
      from: fromEmail,
      hint: fromEmail === 'onboarding@resend.dev'
        ? 'Using test sender — verify braquni.com at resend.com/domains'
        : 'Check RESEND_API_KEY and domain verification',
    });
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

// ── 4. Quotation Accepted by Client ──────────────────────────────────────────
export async function notifyQuotationAccepted(quotation, client) {
  await send(
    `🎉 Quotation Accepted — Ref ${quotation.reference}`,
    `A client has accepted their quotation via WhatsApp!

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? '—'}
Total: R ${Number(quotation.total ?? 0).toFixed(2)} (incl. VAT)
Accepted: ${ts(new Date())}

Next step: collect the 60% deposit and convert to a production order.

👉 View quotation: ${config.dashboardBaseUrl}/quotations/${quotation.id}/build`
  );
}

// ── 5. New WhatsApp Order ─────────────────────────────────────────────────────
export async function notifyNewOrder(order, client) {
  await send(
    `🛒 New WhatsApp Order — Ref ${order.reference}`,
    `A customer has placed an order directly via WhatsApp and needs a consultant assigned.

Client: ${client.name ?? 'Unknown'} (${client.client_type ?? 'unknown'})
WhatsApp: ${client.whatsapp_number ?? '—'}
Deposit due (60%): R ${Number(order.deposit_amount ?? 0).toFixed(2)}
Received: ${ts(order.created_at)}

Next step: collect the 60% deposit to begin production.

👉 View & assign: ${config.dashboardBaseUrl}/orders/${order.id}`
  );
}

// ── 6. Reminder (unclaimed after 2 hours) ─────────────────────────────────────
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
