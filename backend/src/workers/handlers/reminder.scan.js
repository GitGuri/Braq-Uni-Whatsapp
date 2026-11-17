/**
 * 'reminder.scan' — queue emails to consultants about work still unclaimed 2 hours after
 * they were notified (draft quotations, open tickets, consultant requests).
 * Scheduled every 30 minutes by workers/scheduler.js (one job per time bucket
 * across all instances); the advisory lock guards against overlapping runs.
 */
import { query, withTransaction } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { sendReminder } from '../../modules/notifications/service.js';

const UNCLAIMED_AFTER = `NOW() - INTERVAL '2 hours'`;

/** One pass over unclaimed items; a failed reminder never stops the others. */
export async function checkUnclaimed() {
  logger.debug('reminder.scan: checking unclaimed items');

  // Draft quotations notified but not yet claimed or reminded
  const { rows: quotations } = await query(`
    SELECT q.id, q.reference, q.notified_at,
           c.name AS client_name
    FROM quotations q
    LEFT JOIN clients c ON c.id = q.client_id
    WHERE q.assigned_staff_id    IS NULL
      AND q.notified_at          IS NOT NULL
      AND q.staff_reminder_sent_at IS NULL
      AND q.notified_at          < ${UNCLAIMED_AFTER}
      AND q.status               = 'draft'
  `);

  for (const row of quotations) {
    try {
      await withTransaction((tx) => sendReminder(tx, row, 'quotation'));
      logger.info('reminder.scan: sent quotation reminder', { id: row.id });
    } catch (err) {
      logger.error('reminder.scan: failed quotation reminder', { id: row.id, error: err.message });
    }
  }

  // Tickets open/in_progress, notified but not yet claimed or reminded
  const { rows: tickets } = await query(`
    SELECT t.id, t.notified_at,
           c.name AS client_name
    FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.assigned_staff_id IS NULL
      AND t.notified_at        IS NOT NULL
      AND t.reminder_sent_at   IS NULL
      AND t.notified_at        < ${UNCLAIMED_AFTER}
      AND t.status             IN ('open', 'in_progress')
  `);

  for (const row of tickets) {
    try {
      await withTransaction((tx) => sendReminder(tx, { ...row, reference: null }, 'ticket'));
      logger.info('reminder.scan: sent ticket reminder', { id: row.id });
    } catch (err) {
      logger.error('reminder.scan: failed ticket reminder', { id: row.id, error: err.message });
    }
  }

  // Conversations in awaiting_consultant state, notified but not yet claimed or reminded
  const { rows: conversations } = await query(`
    SELECT cv.id, cv.notified_at,
           c.name AS client_name
    FROM conversations cv
    LEFT JOIN clients c ON c.id = cv.client_id
    WHERE cv.assigned_staff_id IS NULL
      AND cv.notified_at        IS NOT NULL
      AND cv.reminder_sent_at   IS NULL
      AND cv.notified_at        < ${UNCLAIMED_AFTER}
      AND cv.state              = 'awaiting_consultant'
  `);

  for (const row of conversations) {
    try {
      await withTransaction((tx) => sendReminder(tx, { ...row, reference: null }, 'conversation'));
      logger.info('reminder.scan: sent conversation reminder', { id: row.id });
    } catch (err) {
      logger.error('reminder.scan: failed conversation reminder', { id: row.id, error: err.message });
    }
  }

  const counts = { quotations: quotations.length, tickets: tickets.length, conversations: conversations.length };
  if (counts.quotations + counts.tickets + counts.conversations > 0) logger.info('reminder.scan: reminders sent', counts);
  return counts;
}

export default async function reminderScan() {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('job:reminder.scan')) AS locked`);
    if (!rows[0].locked) return { skipped: 'another reminder scan is running' };
    return checkUnclaimed();
  });
}
