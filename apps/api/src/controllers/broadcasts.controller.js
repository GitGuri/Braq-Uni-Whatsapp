import { query } from '../db/pool.js';
import { sendTextMessage, sendImage, sendDocument, uploadMedia } from '../services/whatsapp.service.js';
import { TEMPLATES } from '../services/bot.templates.js';
import { logger } from '../utils/logger.js';
import { uploadAttachment } from '../middleware/upload.js';

// ── POST /broadcasts/upload-attachment — upload image or PDF to WhatsApp ──────
export function uploadBroadcastAttachment(req, res) {
  uploadAttachment(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    try {
      const mediaId = await uploadMedia(req.file.buffer, req.file.originalname, req.file.mimetype);
      const isPdf   = req.file.mimetype === 'application/pdf';
      res.json({
        mediaId,
        filename: req.file.originalname,
        size: req.file.size,
        type: isPdf ? 'pdf' : 'image',
      });
    } catch (uploadErr) {
      logger.error('Attachment upload to WhatsApp failed', { error: uploadErr.message });
      res.status(500).json({ error: 'Failed to upload file to WhatsApp. Check API credentials.' });
    }
  });
}

// Safe DB log — never lets a missing/failing table surface as a send failure
async function logBroadcast(sentBy, type, body, count) {
  try {
    await query(
      `INSERT INTO broadcasts (sent_by, message_type, body, recipient_count)
       VALUES ($1, $2, $3, $4)`,
      [sentBy, type, body, count]
    );
  } catch (err) {
    logger.warn('Broadcast log failed (table may not exist yet — run migrate:proof)', { error: err.message });
  }
}

// ── GET /broadcasts — list recent broadcasts ──────────────────────────────────
export async function list(req, res) {
  try {
    const { rows } = await query(`
      SELECT b.*, s.name AS sent_by_name
      FROM broadcasts b
      LEFT JOIN staff s ON s.id = b.sent_by
      ORDER BY b.created_at DESC
      LIMIT 50
    `);
    res.json({ broadcasts: rows });
  } catch (err) {
    // Table doesn't exist yet — return empty list gracefully
    res.json({ broadcasts: [] });
  }
}

// ── POST /broadcasts/custom — send a custom message to a target audience ──────
export async function custom(req, res) {
  const { message, audience, imageUrl, mediaId, mediaType, mediaFilename } = req.body;
  if (!message?.trim() && !imageUrl?.trim() && !mediaId?.trim()) {
    return res.status(400).json({ error: 'message or attachment is required' });
  }

  try {
    let queryText = `SELECT DISTINCT c.whatsapp_number, c.name FROM clients c WHERE c.whatsapp_number IS NOT NULL`;

    if (audience === 'active_orders') {
      queryText = `
        SELECT DISTINCT c.whatsapp_number, c.name
        FROM orders o JOIN clients c ON o.client_id = c.id
        WHERE o.stage NOT IN ('completed') AND c.whatsapp_number IS NOT NULL
      `;
    } else if (audience === 'corporate') {
      queryText = `SELECT DISTINCT c.whatsapp_number, c.name FROM clients c WHERE c.client_type = 'corporate' AND c.whatsapp_number IS NOT NULL`;
    } else if (audience === 'retail') {
      queryText = `SELECT DISTINCT c.whatsapp_number, c.name FROM clients c WHERE c.client_type = 'retail' AND c.whatsapp_number IS NOT NULL`;
    }

    const { rows } = await query(queryText);

    let sent = 0;
    const mid      = mediaId?.trim();
    const img      = imageUrl?.trim();
    const txt      = message?.trim();
    const isPdf    = mediaType === 'pdf';
    const filename = mediaFilename || 'attachment.pdf';

    for (const row of rows) {
      if (!row.whatsapp_number) continue;
      try {
        if (mid && isPdf) {
          await sendDocument(row.whatsapp_number, { mediaId: mid, filename, caption: txt });
        } else if (mid || img) {
          await sendImage(row.whatsapp_number, { mediaId: mid, url: img, caption: txt });
        } else {
          await sendTextMessage(row.whatsapp_number, txt);
        }
        sent++;
      } catch (err) {
        logger.warn('Custom broadcast send failed', { number: row.whatsapp_number, error: err.message });
      }
    }

    // Log after sending — failure here must not affect the response
    const logBody = [txt, mid ? `[image:${mid}]` : img ? `[image:${img}]` : null].filter(Boolean).join('\n') || '(image only)'
    await logBroadcast(req.staff.id, `custom:${audience || 'all_clients'}`, logBody, sent);

    res.json({ sent, total: rows.length });
  } catch (err) {
    logger.error('Custom broadcast failed', { error: err.message });
    res.status(500).json({ error: 'Broadcast failed' });
  }
}

// ── POST /broadcasts/delay — send supplier delay to all active corporate clients
export async function delay(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT c.whatsapp_number, o.reference
       FROM orders o
       JOIN clients c ON o.client_id = c.id
       WHERE o.stage NOT IN ('completed','cancelled')
         AND o.client_type != 'retail'`
    );

    let sent = 0;
    for (const row of rows) {
      try {
        const msg = TEMPLATES.SUPPLIER_DELAY({ reference: row.reference });
        await sendTextMessage(row.whatsapp_number, msg);
        sent++;
      } catch (err) {
        logger.warn('Broadcast send failed', { number: row.whatsapp_number, error: err.message });
      }
    }

    await logBroadcast(req.staff.id, 'delay', TEMPLATES.SUPPLIER_DELAY({ reference: '(batch)' }), sent);
    res.json({ sent, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast failed' });
  }
}

// ── POST /broadcasts/busy — high volume notice to all clients with open orders
export async function busy(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT c.whatsapp_number
       FROM orders o JOIN clients c ON o.client_id = c.id
       WHERE o.stage NOT IN ('completed','cancelled')`
    );

    let sent = 0;
    const msg = TEMPLATES.HIGH_VOLUME_NOTICE();
    for (const row of rows) {
      try {
        await sendTextMessage(row.whatsapp_number, msg);
        sent++;
      } catch { /* continue */ }
    }

    await logBroadcast(req.staff.id, 'busy', msg, sent);
    res.json({ sent, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast failed' });
  }
}
