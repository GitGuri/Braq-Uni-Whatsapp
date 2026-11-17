/**
 * 'broadcast.fanout' — turn one queued broadcast into one 'whatsapp.send' job
 * per recipient.
 *
 * payload: { broadcastId, message: { kind, body?, mediaId?, link?, filename?, caption? },
 *            template?: 'supplier_delay', recipients: [{ clientId, to, reference? }] }
 *
 * Sends are deduped per broadcast and recipient (`broadcast:<id>:<clientId>[:<ref>]`,
 * so a re-run of the fan-out sends nothing twice) and staggered by
 * BROADCAST_RATE_PER_SEC to stay under WhatsApp throughput limits. They have no
 * queue key: a slow broadcast never holds up a client's bot replies. Each send
 * bumps the broadcast's sent_count / failed_count; the last one marks it 'done'.
 */
import { withTransaction } from '../../core/db.js';
import { config } from '../../core/config.js';
import { enqueue, PermanentJobError } from '../../core/queue.js';
import { TEMPLATES } from '../../modules/bot/templates.js';
import { TEMPLATE_FALLBACKS } from '../../modules/notifications/whatsapp.js';

const SEND_MAX_ATTEMPTS = 5;

function messageFor(recipient, { message, template }) {
  if (template === 'supplier_delay') {
    return {
      kind: 'text',
      body: TEMPLATES.SUPPLIER_DELAY({ reference: recipient.reference }),
      // Outside the 24-hour window: the approved order-delay template.
      templateFallback: TEMPLATE_FALLBACKS.orderDelay({ client: { name: recipient.name }, reference: recipient.reference }),
    };
  }
  return message;
}

export default async function broadcastFanout(payload) {
  const { broadcastId, recipients = [] } = payload || {};
  if (!broadcastId) throw new PermanentJobError('broadcast.fanout: payload.broadcastId is required');
  const gapMs = 1000 / config.broadcast.ratePerSec;
  const start = Date.now();

  return withTransaction(async (tx) => {
    const { rows } = await tx.query('SELECT id, status FROM broadcasts WHERE id = $1 FOR UPDATE', [broadcastId]);
    if (!rows.length) throw new PermanentJobError(`broadcast.fanout: broadcast ${broadcastId} not found`);

    let queued = 0;
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const id = await enqueue(tx, 'whatsapp.send',
        { ...messageFor(r, payload), to: r.to, clientId: r.clientId, broadcastId },
        {
          dedupeKey: `broadcast:${broadcastId}:${r.clientId}${r.reference ? `:${r.reference}` : ''}`,
          runAt: new Date(start + Math.round(i * gapMs)),
          maxAttempts: SEND_MAX_ATTEMPTS,
        });
      if (id) queued++;
    }
    await tx.query(
      `UPDATE broadcasts SET status = CASE WHEN recipient_count = 0 THEN 'done' ELSE 'sending' END
       WHERE id = $1 AND status = 'queued'`,
      [broadcastId]
    );
    return { queued, recipients: recipients.length };
  });
}
