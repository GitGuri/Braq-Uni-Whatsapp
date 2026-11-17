// Broadcasts: audience selection, queueing and the history log.
//
// A broadcast is never sent inside the HTTP request: the request stores a
// broadcasts row (status 'queued', recipient_count) and enqueues one
// 'broadcast.fanout' job in the same transaction; the worker turns it into one
// rate-limited 'whatsapp.send' per recipient and keeps sent_count /
// failed_count / status ('queued' → 'sending' → 'done') up to date.
import { query, withTransaction } from '../../core/db.js';
import { enqueue } from '../../core/queue.js';
import { uploadMedia } from '../../integrations/whatsapp.client.js';
import { TEMPLATES } from '../bot/templates.js';

/** Upload an image/PDF to WhatsApp's media store → { mediaId, filename, size, type }. */
export async function uploadAttachment(file) {
  const mediaId = await uploadMedia(file.buffer, file.originalname, file.mimetype);
  return {
    mediaId,
    filename: file.originalname,
    size: file.size,
    type: file.mimetype === 'application/pdf' ? 'pdf' : 'image',
  };
}

/** The 50 most recent broadcasts with the sender's name (empty list if the log is unavailable). */
export async function listBroadcasts() {
  try {
    const { rows } = await query(`
      SELECT b.*, s.name AS sent_by_name
      FROM broadcasts b
      LEFT JOIN staff s ON s.id = b.sent_by
      ORDER BY b.created_at DESC
      LIMIT 50
    `);
    return rows;
  } catch {
    return [];
  }
}

const AUDIENCE_SQL = {
  all_clients:   `SELECT DISTINCT ON (c.whatsapp_number) c.id AS client_id, c.whatsapp_number
                  FROM clients c WHERE c.whatsapp_number IS NOT NULL`,
  active_orders: `SELECT DISTINCT ON (c.whatsapp_number) c.id AS client_id, c.whatsapp_number
                  FROM orders o JOIN clients c ON o.client_id = c.id
                  WHERE o.stage NOT IN ('completed') AND c.whatsapp_number IS NOT NULL`,
  corporate:     `SELECT DISTINCT ON (c.whatsapp_number) c.id AS client_id, c.whatsapp_number
                  FROM clients c WHERE c.client_type = 'corporate' AND c.whatsapp_number IS NOT NULL`,
  retail:        `SELECT DISTINCT ON (c.whatsapp_number) c.id AS client_id, c.whatsapp_number
                  FROM clients c WHERE c.client_type = 'retail' AND c.whatsapp_number IS NOT NULL`,
};

/**
 * Store the broadcast and queue its fan-out (one transaction).
 * @returns {{ broadcastId, recipients, status, total, sent, failed }}
 *   `total` / `sent` / `failed` keep the old synchronous response shape for
 *   compatibility: sent = recipients queued, failed = 0 (real outcomes land on
 *   the broadcasts row as the sends complete).
 */
async function queueBroadcast(staffId, { type, body, recipients, message = null, template = null }) {
  return withTransaction(async (tx) => {
    const status = recipients.length ? 'queued' : 'done';
    const { rows } = await tx.query(
      `INSERT INTO broadcasts (sent_by, message_type, body, recipient_count, status, sent_count, failed_count)
       VALUES ($1, $2, $3, $4, $5, 0, 0)
       RETURNING id`,
      [staffId, type, body, recipients.length, status]
    );
    const broadcastId = rows[0].id;
    if (recipients.length) {
      await enqueue(tx, 'broadcast.fanout', { broadcastId, message, template, recipients }, {
        dedupeKey: `broadcast:${broadcastId}:fanout`,
      });
    }
    return { broadcastId, recipients: recipients.length, status, total: recipients.length, sent: recipients.length, failed: 0 };
  });
}

const toRecipients = (rows) => rows
  .filter((r) => r.whatsapp_number)
  .map((r) => ({ clientId: r.client_id, to: r.whatsapp_number, ...(r.reference ? { reference: r.reference } : {}) }));

/**
 * Custom message (text and/or an image/PDF) to an audience
 * (all_clients | active_orders | corporate | retail; unknown → all clients).
 */
export async function sendCustom(staffId, { message, audience, imageUrl, mediaId, mediaType, mediaFilename }) {
  const { rows } = await query(Object.hasOwn(AUDIENCE_SQL, audience ?? '') ? AUDIENCE_SQL[audience] : AUDIENCE_SQL.all_clients);

  const mid = mediaId?.trim();
  const img = imageUrl?.trim();
  const txt = message?.trim();

  let msg;
  if (mid && mediaType === 'pdf') {
    msg = { kind: 'document', mediaId: mid, filename: mediaFilename || 'attachment.pdf', ...(txt ? { caption: txt } : {}) };
  } else if (mid || img) {
    msg = { kind: 'image', ...(mid ? { mediaId: mid } : { link: img }), ...(txt ? { caption: txt } : {}) };
  } else {
    msg = { kind: 'text', body: txt };
  }

  const logBody = [txt, mid ? `[image:${mid}]` : img ? `[image:${img}]` : null].filter(Boolean).join('\n') || '(image only)';
  return queueBroadcast(staffId, {
    type: `custom:${audience || 'all_clients'}`, body: logBody, recipients: toRecipients(rows), message: msg,
  });
}

/** Supplier-delay notice to every non-retail client with an open order (one per order reference). */
export async function sendSupplierDelay(staffId) {
  const { rows } = await query(
    `SELECT DISTINCT c.id AS client_id, c.whatsapp_number, o.reference
     FROM orders o
     JOIN clients c ON o.client_id = c.id
     WHERE o.stage NOT IN ('completed','cancelled')
       AND o.client_type != 'retail'`
  );
  return queueBroadcast(staffId, {
    type: 'delay', body: TEMPLATES.SUPPLIER_DELAY({ reference: '(batch)' }),
    recipients: toRecipients(rows), template: 'supplier_delay',
  });
}

/** High-volume notice to every client with an open order. */
export async function sendBusyNotice(staffId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (c.whatsapp_number) c.id AS client_id, c.whatsapp_number
     FROM orders o JOIN clients c ON o.client_id = c.id
     WHERE o.stage NOT IN ('completed','cancelled')`
  );
  const msg = TEMPLATES.HIGH_VOLUME_NOTICE();
  return queueBroadcast(staffId, { type: 'busy', body: msg, recipients: toRecipients(rows), message: { kind: 'text', body: msg } });
}
