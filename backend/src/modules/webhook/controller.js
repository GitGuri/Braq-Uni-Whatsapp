import crypto from 'node:crypto';
import { config } from '../../core/config.js';
import { withTransaction } from '../../core/db.js';
import { enqueue } from '../../core/queue.js';
import { logger } from '../../core/logger.js';

// ── GET /webhook — Meta verification handshake ────────────────────────────────
export function verify(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.meta.webhookVerify) {
    logger.info('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  // Never log the submitted token — it may be a near-miss of the real secret
  logger.warn('Webhook verification failed', { mode });
  return res.sendStatus(403);
}

// ── Signature check (X-Hub-Signature-256) ─────────────────────────────────────
let warnedNoSecret = false;

function hasValidSignature(req) {
  const secret = config.meta.appSecret;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      logger.warn('META_APP_SECRET is not set — webhook signatures are NOT being verified');
    }
    return true;
  }

  const header = req.get('x-hub-signature-256');
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;

  // express.json keeps the exact bytes in req.rawBody; express.raw (non-JSON types) puts them in req.body
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : Buffer.isBuffer(req.body) ? req.body
    : Buffer.alloc(0);

  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  let received;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Non-text message types we keep in the conversation (staff can see them in the inbox)
export const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts']);
// Delivery receipts we track on messages.status
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * Pull the inbound messages and status receipts out of a Meta webhook body.
 * payload: text → { body, profileName? }; media → { media, profileName? }.
 * @returns {{ messages: { metaMessageId, phone, kind, payload }[], statuses: { metaMessageId, status, errorCode? }[] }}
 */
export function extractEvents(body) {
  const messages = [];
  const statuses = [];
  if (!body || Buffer.isBuffer(body) || body.object !== 'whatsapp_business_account') return { messages, statuses };

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change.value;
      if (!value || typeof value !== 'object') continue;

      // WhatsApp profile names of the senders (used as the client's name until they give one)
      const profiles = new Map();
      for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
        const name = c?.profile?.name;
        if (typeof c?.wa_id === 'string' && typeof name === 'string' && name.trim()) profiles.set(c.wa_id, name.trim().slice(0, 200));
      }

      for (const msg of Array.isArray(value.messages) ? value.messages : []) {
        const phone = msg?.from;
        if (!phone || typeof phone !== 'string') continue;
        const profileName = profiles.get(phone) ?? null;
        if (msg.type === 'text') {
          const raw = msg.text?.body;
          const text = typeof raw === 'string' ? raw.trim() : '';
          if (!text) continue;
          messages.push({ metaMessageId: msg.id || null, phone, kind: 'text', payload: { body: text, ...(profileName ? { profileName } : {}) } });
        } else if (MEDIA_TYPES.has(msg.type)) {
          const media = msg[msg.type];
          messages.push({ metaMessageId: msg.id || null, phone, kind: msg.type, payload: { media: media && typeof media === 'object' ? media : {}, ...(profileName ? { profileName } : {}) } });
        } else {
          logger.info('Unsupported message type received, ignoring', { type: msg?.type });
        }
      }

      for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof st?.id !== 'string' || !STATUSES.has(st.status)) continue;
        const errorCode = Array.isArray(st.errors) && st.errors[0]?.code != null ? Number(st.errors[0].code) : null;
        statuses.push({ metaMessageId: st.id, status: st.status, ...(errorCode != null ? { errorCode } : {}) });
      }
    }
  }
  return { messages, statuses };
}

/**
 * Store the events durably and queue their processing — one transaction.
 * A message seen before (Meta retry / duplicate delivery) is not queued again.
 * Processing is FIFO per sender (queue key wa:<phone>).
 * @returns {Promise<{ queued: number, duplicates: number, statuses: number }>}
 */
export async function persistEvents({ messages, statuses }) {
  if (!messages.length && !statuses.length) return { queued: 0, duplicates: 0, statuses: 0 };
  return withTransaction(async (tx) => {
    let queued = 0;
    for (const m of messages) {
      const { rows } = await tx.query(
        `INSERT INTO inbound_events (meta_message_id, phone, kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (meta_message_id) DO NOTHING
         RETURNING id`,
        [m.metaMessageId, m.phone, m.kind, JSON.stringify(m.payload)]
      );
      if (!rows.length) continue;
      await enqueue(tx, 'inbound.process', { eventId: Number(rows[0].id) }, { queueKey: `wa:${m.phone}` });
      queued++;
    }
    for (const s of statuses) {
      await enqueue(tx, 'message.status', s, { dedupeKey: `status:${s.metaMessageId}:${s.status}`, maxAttempts: 3 });
    }
    return { queued, duplicates: messages.length - queued, statuses: statuses.length };
  });
}

// ── POST /webhook — incoming messages and status updates ──────────────────────
// 200 only once the events are committed; 500 when they could not be stored, so
// Meta retries the delivery (duplicates are dropped by meta_message_id).
export async function receive(req, res) {
  if (!hasValidSignature(req)) {
    logger.warn('Webhook POST rejected: missing or invalid X-Hub-Signature-256', { ip: req.ip });
    return res.sendStatus(401);
  }

  let events;
  try {
    events = extractEvents(req.body);
  } catch (err) {
    logger.error('Webhook payload could not be read — ignored', { error: err.message });
    return res.sendStatus(200);
  }

  try {
    const result = await persistEvents(events);
    if (result.queued || result.statuses) logger.debug('Webhook events queued', result);
    return res.sendStatus(200);
  } catch (err) {
    logger.error('Webhook events could not be stored — Meta will retry', { error: err.message });
    return res.sendStatus(500);
  }
}
