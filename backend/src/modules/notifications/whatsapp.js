/**
 * Queue client-facing WhatsApp messages (the outbox). Always pass the
 * transaction client of the domain write so the message is sent if — and only
 * if — the write commits. Messages to one recipient are delivered in order
 * (queue key `out:<phone>`); the whatsapp.send handler also stores each sent
 * message in the inbox.
 *
 * 24-hour window: WhatsApp only allows free text within 24 hours of the
 * client's last message. Business-initiated messages (stage updates, receipts,
 * proof ready, ticket resolved, quote ready, consultant replies) should carry a
 * `templateFallback` ({ name, params }) — see TEMPLATE_FALLBACKS below. The
 * whatsapp.send handler sends the free text inside the window and the approved
 * template (WHATSAPP_TEMPLATES) outside it; with no template configured the
 * message is marked 'needs_template' and staff are emailed instead.
 */
import { enqueue } from '../../core/queue.js';

export const outboundQueueKey = (to) => `out:${to}`;

/** A valid { name, params } fallback, or null. */
function cleanFallback(templateFallback) {
  if (!templateFallback || typeof templateFallback !== 'object' || !templateFallback.name) return null;
  return {
    name: String(templateFallback.name),
    params: Array.isArray(templateFallback.params) ? templateFallback.params.map((p) => String(p ?? '')) : [],
  };
}

/**
 * @param {{ query: Function }} tx
 * @param {{ to: string, body: string, clientId?: string|null, conversationId?: string|null,
 *           templateFallback?: { name: string, params?: string[] }|null }} msg
 * @param {{ dedupeKey?: string }} [opts]
 * @returns {Promise<number|null>} job id (null when skipped: no number, or duplicate dedupeKey)
 */
export async function queueWhatsAppText(tx, { to, body, clientId = null, conversationId = null, templateFallback = null }, { dedupeKey = null } = {}) {
  if (!to || !body) return null;
  const fallback = cleanFallback(templateFallback);
  return enqueue(tx, 'whatsapp.send', { to, kind: 'text', body, clientId, conversationId, ...(fallback ? { templateFallback: fallback } : {}) }, {
    dedupeKey, queueKey: outboundQueueKey(to),
  });
}

/**
 * Queue a text AND record it in the conversation right away (messages row,
 * outbound, status 'queued', job_id = the job) — the inbox shows it at once;
 * the whatsapp.send handler fills in meta_message_id / status 'sent' after
 * delivery, 'needs_template' when it may not be sent as free text, or status
 * 'failed' when the job is dead-lettered.
 *
 * created_at uses clock_timestamp() so rows written in one transaction (the
 * client's message, then the bot's replies) keep their order.
 *
 * @returns {Promise<{ jobId: number|null, messageId: string|null }>}
 */
export async function queueRecordedText(tx, { to, body, clientId, conversationId, templateFallback = null }, { dedupeKey = null } = {}) {
  if (!to || !body) return { jobId: null, messageId: null };
  const fallback = cleanFallback(templateFallback);
  const jobId = await enqueue(tx, 'whatsapp.send', {
    to, kind: 'text', body, clientId, conversationId, recorded: true, ...(fallback ? { templateFallback: fallback } : {}),
  }, {
    dedupeKey, queueKey: outboundQueueKey(to),
  });
  if (!jobId || !conversationId || !clientId) return { jobId, messageId: null };
  const { rows } = await tx.query(
    `INSERT INTO messages (conversation_id, client_id, body, direction, is_read_by_staff, job_id, status, created_at)
     VALUES ($1, $2, $3, 'outbound', true, $4, 'queued', clock_timestamp())
     RETURNING id`,
    [conversationId, clientId, body, jobId]
  );
  return { jobId, messageId: rows[0].id };
}

/**
 * One helper for business-initiated messages to a client: free text inside the
 * 24-hour window, the template outside it (see the module comment).
 *
 *   await queueClientMessage(tx, client, {
 *     text: TEMPLATES.STAGE_IN_PRODUCTION({ ... }),
 *     templateFallback: TEMPLATE_FALLBACKS.orderStage({ client, reference, status: 'In production' }),
 *     conversationId, dedupeKey: `order:${id}:stage:${h.id}`,
 *   });
 *
 * @param {{ query: Function }} tx
 * @param {{ id?: string, whatsapp_number?: string, name?: string }} client
 * @param {{ to?: string, text: string, templateFallback?: object|null, conversationId?: string|null,
 *           dedupeKey?: string|null, recorded?: boolean }} msg  recorded: write the inbox row now
 */
export async function queueClientMessage(tx, client, { to = null, text, templateFallback = null, conversationId = null, dedupeKey = null, recorded = false }) {
  const msg = { to: to || client?.whatsapp_number, body: text, clientId: client?.id ?? null, conversationId, templateFallback };
  if (recorded && msg.clientId && conversationId) return (await queueRecordedText(tx, msg, { dedupeKey })).jobId;
  return queueWhatsAppText(tx, msg, { dedupeKey });
}

// ── Template fallbacks (logical name + body parameters, in template order) ────
// The logical names map to approved Meta templates via WHATSAPP_TEMPLATES; the
// body texts to register are in README "WhatsApp message templates".
const first = (client) => String(client?.name ?? '').trim().split(/\s+/)[0] || 'there';
const rand = (n) => Number(n ?? 0).toFixed(2);

export const TEMPLATE_FALLBACKS = {
  /** {{1}} first name, {{2}} order ref, {{3}} status, {{4}} next step / extra. */
  orderStage: ({ client, reference, status, extra = '' }) =>
    ({ name: 'order_stage', params: [first(client), reference, status, extra || 'We will keep you updated.'] }),
  /** {{1}} first name, {{2}} amount, {{3}} order ref, {{4}} balance sentence. */
  paymentReceived: ({ client, amount, reference, balanceText = '' }) =>
    ({ name: 'payment_received', params: [first(client), rand(amount), reference, balanceText || 'Thank you!'] }),
  /** {{1}} first name, {{2}} order ref, {{3}} proof link. */
  proofReady: ({ client, reference, proofUrl }) =>
    ({ name: 'proof_ready', params: [first(client), reference, proofUrl] }),
  /** {{1}} first name, {{2}} order ref or "your enquiry", {{3}} resolution note. */
  ticketResolved: ({ client, reference, note = '' }) =>
    ({ name: 'ticket_resolved', params: [first(client), reference || 'your enquiry', note || 'Thank you for your patience.'] }),
  /** Document header = the PDF. {{1}} first name, {{2}} quote ref, {{3}} total, {{4}} valid until. */
  quoteReady: ({ client, reference, total, validUntil }) =>
    ({ name: 'quote_ready', params: [first(client), reference, rand(total), validUntil || '30 days'] }),
  /** {{1}} first name, {{2}} quote ref, {{3}} expiry date. */
  quoteExpiring: ({ client, reference, expiresOn }) =>
    ({ name: 'quote_expiring', params: [first(client), reference, expiresOn] }),
  /** {{1}} first name, {{2}} consultant name, {{3}} message excerpt. */
  consultantReply: ({ client, staffName, text }) =>
    ({ name: 'consultant_reply', params: [first(client), staffName || 'Your consultant', String(text ?? '').slice(0, 300)] }),
  /** {{1}} first name, {{2}} order ref. */
  orderDelay: ({ client, reference }) =>
    ({ name: 'order_delay', params: [first(client), reference] }),
};
