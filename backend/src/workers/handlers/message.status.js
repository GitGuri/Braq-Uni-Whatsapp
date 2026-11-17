/**
 * 'message.status' — apply a Meta delivery receipt (sent / delivered / read /
 * failed) to the outbound messages row with that meta_message_id.
 *
 * payload: { metaMessageId, status, errorCode? }
 *
 * A 'failed' receipt with Meta error 131047 (free text sent outside the client's
 * 24-hour window) hands the message to its template fallback, or marks it
 * 'needs_template' and emails staff (whatsapp.send handleReengagementFailure).
 *
 * A status never moves backwards (a late 'delivered' does not undo 'read');
 * 'failed' always applies. A receipt can arrive before the whatsapp.send
 * handler has stored the row → retried a couple of times, then dropped
 * (messages we never stored, e.g. broadcasts to contacts without a chat).
 */
import { query } from '../../core/db.js';
import { PermanentJobError } from '../../core/queue.js';
import { handleReengagementFailure } from './whatsapp.send.js';
import { REENGAGEMENT_CODES } from '../../integrations/whatsapp.client.js';

const KNOWN = new Set(['sent', 'delivered', 'read', 'failed']);

export default async function messageStatus(payload, { job }) {
  const { metaMessageId, status, errorCode = null } = payload || {};
  if (!metaMessageId || !KNOWN.has(status)) throw new PermanentJobError('message.status: metaMessageId and a known status are required');

  const rank = (expr) => `(CASE ${expr} WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 9 ELSE 0 END)`;
  const { rowCount } = await query(
    `UPDATE messages SET status = $2::text
     WHERE meta_message_id = $1
       AND ($2::text = 'failed' OR ${rank("COALESCE(status, 'sent')")} < ${rank('$2::text')})`,
    [metaMessageId, status]
  );
  if (rowCount) {
    if (status === 'failed' && REENGAGEMENT_CODES.has(Number(errorCode))) {
      return { updated: true, reengagement: await handleReengagementFailure(metaMessageId) };
    }
    return { updated: true };
  }

  const { rows } = await query('SELECT 1 FROM messages WHERE meta_message_id = $1', [metaMessageId]);
  if (rows.length) return { updated: false, reason: 'status is not newer' };
  if (job.attempts < job.max_attempts) throw new Error(`message ${metaMessageId} not stored yet`);
  return { updated: false, reason: 'unknown message' };
}
