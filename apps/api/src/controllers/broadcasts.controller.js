import { query } from '../db/pool.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { TEMPLATES } from '../services/bot.templates.js';
import { logger } from '../utils/logger.js';

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

    await query(
      `INSERT INTO broadcasts (sent_by, message_type, body, recipient_count)
       VALUES ($1, 'delay', $2, $3)`,
      [req.staff.id, TEMPLATES.SUPPLIER_DELAY({ reference: '(batch)' }), sent]
    );

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

    await query(
      `INSERT INTO broadcasts (sent_by, message_type, body, recipient_count)
       VALUES ($1, 'busy', $2, $3)`,
      [req.staff.id, msg, sent]
    );

    res.json({ sent, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast failed' });
  }
}
