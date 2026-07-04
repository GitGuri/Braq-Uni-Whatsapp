import { query } from '../db/pool.js';
import { sendReminder } from '../services/notification.service.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS  = 30 * 60 * 1000; // every 30 minutes
const UNCLAIMED_AFTER = `NOW() - INTERVAL '2 hours'`;

async function checkUnclaimed() {
  logger.debug('reminder.job: checking unclaimed items');

  try {
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
        await sendReminder(row, 'quotation');
        logger.info('reminder.job: sent quotation reminder', { id: row.id });
      } catch (err) {
        logger.error('reminder.job: failed quotation reminder', { id: row.id, error: err.message });
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
        await sendReminder({ ...row, reference: null }, 'ticket');
        logger.info('reminder.job: sent ticket reminder', { id: row.id });
      } catch (err) {
        logger.error('reminder.job: failed ticket reminder', { id: row.id, error: err.message });
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
        await sendReminder({ ...row, reference: null }, 'conversation');
        logger.info('reminder.job: sent conversation reminder', { id: row.id });
      } catch (err) {
        logger.error('reminder.job: failed conversation reminder', { id: row.id, error: err.message });
      }
    }

    if (quotations.length + tickets.length + conversations.length > 0) {
      logger.info('reminder.job: reminders sent', {
        quotations: quotations.length,
        tickets: tickets.length,
        conversations: conversations.length,
      });
    }
  } catch (err) {
    logger.error('reminder.job: check failed', { error: err.message });
  }
}

export function startReminderJob() {
  // First check shortly after startup
  setTimeout(checkUnclaimed, 10_000);
  setInterval(checkUnclaimed, INTERVAL_MS);
  logger.info('reminder.job started', { intervalMinutes: INTERVAL_MS / 60_000 });
}
