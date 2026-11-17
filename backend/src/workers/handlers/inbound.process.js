/**
 * 'inbound.process' — run the bot for one stored webhook event (inbound_events).
 *
 * payload: { eventId }   queue key wa:<phone> → one sender's messages are
 * processed strictly in order, one at a time.
 *
 * Skips events already processed. The bot turn stores the message, its state
 * changes and queued replies and sets processed_at in one transaction; when
 * even the apology for a failed turn cannot be written the job throws and is
 * retried.
 */
import { query } from '../../core/db.js';
import { PermanentJobError } from '../../core/queue.js';
import { handleInbound, handleInboundMedia } from '../../modules/bot/router.js';

export default async function inboundProcess(payload) {
  const eventId = payload?.eventId;
  if (!eventId) throw new PermanentJobError('inbound.process: payload.eventId is required');

  const { rows } = await query('SELECT * FROM inbound_events WHERE id = $1', [eventId]);
  const event = rows[0];
  if (!event) throw new PermanentJobError(`inbound.process: event ${eventId} not found`);
  if (event.processed_at) return { skipped: 'already processed' };

  const profileName = typeof event.payload?.profileName === 'string' ? event.payload.profileName : null;
  const msg = { phoneNumber: event.phone, metaMessageId: event.meta_message_id, eventId: Number(event.id), profileName };
  if (event.kind === 'text') {
    await handleInbound({ ...msg, body: event.payload?.body ?? '' });
  } else {
    await handleInboundMedia({ ...msg, type: event.kind, payload: event.payload?.media ?? {} });
  }
  // Safety net — the turn normally sets it inside its own transaction.
  await query('UPDATE inbound_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL', [event.id]);
  return { processed: true };
}
