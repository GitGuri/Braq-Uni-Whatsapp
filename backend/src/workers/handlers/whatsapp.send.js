/**
 * 'whatsapp.send' — deliver one WhatsApp message and record it in the inbox.
 *
 * payload: { to, kind: 'text'|'document'|'image'|'template', body?, mediaId?, link?, filename?,
 *            caption?, conversationId?, clientId?, recorded?, broadcastId?,
 *            templateFallback?: { name, params[] }, template?: { name, params[] } }
 *
 *  - recorded: the messages row was written when the job was queued
 *    (queueRecordedText: status 'queued', job_id = this job) → after sending it
 *    gets meta_message_id + status 'sent'; when the job is dead-lettered, 'failed'.
 *  - otherwise the outbound row is inserted after sending, on the given
 *    conversation, else the client's open (or most recent) one; without any
 *    conversation the message is sent but not stored (conversation_id is NOT NULL).
 *  - broadcastId: the broadcast's sent_count / failed_count are bumped and its
 *    status becomes 'done' once every recipient has an outcome.
 *
 * 24-hour customer service window (business-initiated messages):
 *  - templateFallback given and the client's last inbound message is more than
 *    24 hours old (or there is none) → the approved template configured for
 *    templateFallback.name (WHATSAPP_TEMPLATES) is sent instead of the free
 *    text; a document's PDF becomes the template's document header.
 *  - no template configured → the message is marked 'needs_template' and staff
 *    are emailed (notifyUndeliverable) — the job completes, it is NOT retried.
 *  - Meta answers 131047 ("re-engagement message", outside the window) to free
 *    text → treated as permanent: template fallback as above.
 *  - kind 'template': send payload.template directly (logical name, params).
 *
 * Idempotent per job: a messages row with this job_id that is already sent means
 * a retry after a crash between send and complete → skip.
 */
import { query } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { enqueue, PermanentJobError } from '../../core/queue.js';
import {
  sendTextMessage, sendDocument, sendImage, sendTemplate, templateConfig, isReengagementError, windowCheckEnabled,
} from '../../integrations/whatsapp.client.js';
import { notifyUndeliverable } from '../../modules/notifications/service.js';

const KINDS = new Set(['text', 'document', 'image', 'template']);

/** Minutes of safety margin before the 24-hour window closes. */
const WINDOW_MARGIN_MINUTES = 5;

export async function resolveConversation({ to, conversationId, clientId }) {
  if (conversationId) {
    const { rows } = await query('SELECT id, client_id FROM conversations WHERE id = $1', [conversationId]);
    if (rows.length) return rows[0];
  }
  const { rows } = await query(
    `SELECT cv.id, cv.client_id
     FROM conversations cv
     JOIN clients c ON c.id = cv.client_id
     WHERE ${clientId ? 'c.id = $1' : 'c.whatsapp_number = $1'}
     ORDER BY cv.is_open DESC, cv.last_message_at DESC
     LIMIT 1`,
    [clientId || to]
  );
  return rows[0] || null;
}

/** Text stored in the inbox for a non-text message. */
function storedBody(p) {
  if (p.kind === 'text') return p.body;
  if (p.kind === 'template') return p.body || `[template: ${p.template?.name ?? 'message'}]`;
  const label = p.kind === 'document' ? `[document: ${p.filename || 'file'}]` : '[image]';
  return p.caption ? `${label} ${p.caption}` : label;
}

/** Record one broadcast recipient's outcome; the broadcast is done when all have one. */
export async function countBroadcastOutcome(broadcastId, outcome) {
  const col = outcome === 'sent' ? 'sent_count' : 'failed_count';
  await query(
    `UPDATE broadcasts
     SET ${col} = COALESCE(${col}, 0) + 1,
         status = CASE WHEN COALESCE(sent_count, 0) + COALESCE(failed_count, 0) + 1 >= recipient_count
                       THEN 'done' ELSE 'sending' END
     WHERE id = $1`,
    [broadcastId]
  );
}

/**
 * True when free text may NOT be sent: the client's last inbound message (any
 * client row with this WhatsApp number) is older than 24 hours, or there is none.
 */
export async function outsideCustomerWindow({ clientId = null, to }) {
  if (!windowCheckEnabled()) return false;
  const { rows } = await query(
    `SELECT MAX(m.created_at) IS NULL
            OR NOW() - MAX(m.created_at) > INTERVAL '24 hours' - INTERVAL '${WINDOW_MARGIN_MINUTES} minutes' AS outside
     FROM messages m JOIN clients c ON c.id = m.client_id
     WHERE m.direction = 'inbound' AND (m.client_id = $1::uuid OR c.whatsapp_number = $2)`,
    [clientId, to]
  );
  return rows[0]?.outside !== false;
}

async function deliver(p) {
  if (p.kind === 'text') return sendTextMessage(p.to, p.body);
  if (p.kind === 'document') return sendDocument(p.to, { mediaId: p.mediaId, url: p.link, filename: p.filename, caption: p.caption });
  return sendImage(p.to, { mediaId: p.mediaId, url: p.link, caption: p.caption });
}

/**
 * Send the approved template for `logical` ({ name, params }).
 * @returns {{ metaMessageId?: string|null, needsTemplate?: boolean, template: string }}
 */
async function deliverTemplate(p, logical) {
  const cfg = templateConfig(logical?.name);
  if (!cfg) return { needsTemplate: true, template: logical?.name ?? null };
  const document = p.kind === 'document' && (p.mediaId || p.link)
    ? { mediaId: p.mediaId, url: p.link, filename: p.filename }
    : null;
  const metaMessageId = await sendTemplate(p.to, { name: cfg.name, language: cfg.language, params: logical.params || [], document });
  return { metaMessageId, template: cfg.name };
}

async function clientFor(p) {
  const { rows } = await query(
    `SELECT id, name, whatsapp_number FROM clients WHERE ${p.clientId ? 'id = $1' : 'whatsapp_number = $1'} LIMIT 1`,
    [p.clientId || p.to]
  );
  return rows[0] || { whatsapp_number: p.to };
}

/** The message may not go out as free text and there is no template: record it and tell staff. */
async function markNeedsTemplate(p, job, { template, reason }) {
  const body = storedBody(p);
  if (p.recorded) {
    await query(`UPDATE messages SET status = 'needs_template' WHERE job_id = $1`, [job.id]);
  } else {
    await recordOutbound({ ...p, body, metaMessageId: null, jobId: job.id, status: 'needs_template' });
  }
  if (p.broadcastId) await countBroadcastOutcome(p.broadcastId, 'failed');
  const client = await clientFor(p);
  const convo = await resolveConversation(p).catch(() => null);
  await notifyUndeliverable({ query }, { client, conversationId: convo?.id ?? null, body, template, reason });
  logger.warn('whatsapp.send: outside the 24-hour window and no template — staff notified', { jobId: job.id, to: p.to, template });
  return { needsTemplate: true, template };
}

export default async function whatsappSend(payload, { job }) {
  const p = { kind: 'text', ...payload };
  try {
    if (!p.to) throw new PermanentJobError('whatsapp.send: payload.to is required');
    if (!KINDS.has(p.kind)) throw new PermanentJobError(`whatsapp.send: unknown kind "${p.kind}"`);
    if (p.kind === 'text' && !p.body) throw new PermanentJobError('whatsapp.send: text message needs a body');
    if (p.kind === 'template' && !p.template?.name) throw new PermanentJobError('whatsapp.send: template message needs template.name');
    if (['document', 'image'].includes(p.kind) && !p.mediaId && !p.link) throw new PermanentJobError(`whatsapp.send: ${p.kind} needs mediaId or link`);

    const { rows: existing } = await query('SELECT id, status FROM messages WHERE job_id = $1', [job.id]);
    const recordedRow = p.recorded ? existing[0] : null;
    if (existing.length && !(recordedRow && ['queued', 'failed'].includes(recordedRow.status))) {
      return { skipped: 'already sent' };
    }

    let metaMessageId;
    let template = null;
    if (p.kind === 'template') {
      const r = await deliverTemplate(p, p.template);
      if (r.needsTemplate) return markNeedsTemplate(p, job, { template: r.template, reason: 'No approved WhatsApp template is configured for this message.' });
      ({ metaMessageId, template } = r);
    } else if (p.templateFallback && await outsideCustomerWindow(p)) {
      const r = await deliverTemplate(p, p.templateFallback);
      if (r.needsTemplate) {
        return markNeedsTemplate(p, job, { template: r.template, reason: 'The client last messaged more than 24 hours ago, so WhatsApp only allows an approved template.' });
      }
      ({ metaMessageId, template } = r);
    } else {
      try {
        metaMessageId = await deliver(p);
      } catch (err) {
        if (!isReengagementError(err)) throw err;
        // 131047: outside the window after all — never retry the free text.
        const r = p.templateFallback ? await deliverTemplate(p, p.templateFallback) : { needsTemplate: true, template: null };
        if (r.needsTemplate) {
          return markNeedsTemplate(p, job, { template: r.template, reason: 'WhatsApp refused the message (error 131047: more than 24 hours since the client last replied).' });
        }
        ({ metaMessageId, template } = r);
      }
    }
    if (template) logger.info('whatsapp.send: sent as template (outside the 24-hour window)', { jobId: job.id, template });

    let stored;
    if (recordedRow) {
      await query(
        `UPDATE messages SET meta_message_id = $2, status = 'sent' WHERE job_id = $1`,
        [job.id, metaMessageId || null]
      );
      stored = true;
    } else {
      stored = await recordOutbound({ ...p, body: storedBody(p), metaMessageId, jobId: job.id });
    }
    if (p.broadcastId) await countBroadcastOutcome(p.broadcastId, 'sent');
    return { metaMessageId, stored, ...(template ? { template } : {}) };
  } catch (err) {
    const final = err?.permanent === true || job.attempts >= job.max_attempts;
    if (final) {
      // Dead-lettered: show the failure in the inbox and count it on the broadcast.
      try {
        if (p.recorded) await query(`UPDATE messages SET status = 'failed' WHERE job_id = $1 AND status = 'queued'`, [job.id]);
        if (p.broadcastId) await countBroadcastOutcome(p.broadcastId, 'failed');
      } catch (e) {
        logger.error('whatsapp.send: could not record the failed send', { jobId: job.id, error: e.message });
      }
    }
    throw err;
  }
}

/**
 * Store a sent message in the inbox (messages, direction outbound) on the given
 * conversation, else the client's open / most recent one. No conversation → not
 * stored (messages.conversation_id is NOT NULL). Returns whether it was stored.
 */
export async function recordOutbound({ to, conversationId, clientId, body, metaMessageId, jobId, status = 'sent' }) {
  const convo = await resolveConversation({ to, conversationId, clientId });
  if (!convo) return false;
  await query(
    `INSERT INTO messages (conversation_id, client_id, body, direction, meta_message_id, is_read_by_staff, job_id, status)
     VALUES ($1, $2, $3, 'outbound', $4, true, $5, $6)
     ON CONFLICT DO NOTHING`,
    [convo.id, convo.client_id, body, metaMessageId || null, jobId ?? null, status]
  );
  return true;
}

/**
 * A delivery receipt said 'failed' with error 131047 (the free text arrived
 * outside the 24-hour window): send the message's template fallback instead,
 * or mark it 'needs_template' and tell staff. Called by message.status.
 * @returns {Promise<'template_queued'|'needs_template'|'ignored'>}
 */
export async function handleReengagementFailure(metaMessageId) {
  const { rows } = await query(
    `SELECT m.id, m.job_id, m.body, m.client_id, m.conversation_id, j.payload
     FROM messages m LEFT JOIN jobs j ON j.id = m.job_id
     WHERE m.meta_message_id = $1 AND m.direction = 'outbound'`,
    [metaMessageId]
  );
  const row = rows[0];
  if (!row) return 'ignored';
  const p = row.payload || {};
  const fallback = p.templateFallback;
  if (fallback && templateConfig(fallback.name) && p.to) {
    await enqueue({ query }, 'whatsapp.send', {
      to: p.to, kind: 'template', template: fallback, body: row.body,
      clientId: row.client_id, conversationId: row.conversation_id,
    }, { dedupeKey: `reengage:${metaMessageId}`, queueKey: `out:${p.to}` });
    return 'template_queued';
  }
  await query(`UPDATE messages SET status = 'needs_template' WHERE id = $1`, [row.id]);
  const client = await clientFor({ clientId: row.client_id, to: p.to });
  await notifyUndeliverable({ query }, {
    client, conversationId: row.conversation_id, body: row.body, template: fallback?.name ?? null,
    reason: 'WhatsApp could not deliver the message (error 131047: more than 24 hours since the client last replied).',
  });
  return 'needs_template';
}
