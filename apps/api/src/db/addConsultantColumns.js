// Additive migration — safe to run on an existing database.
// Adds claim/notify tracking columns to quotations, tickets, and conversations.
import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const steps = [
  // quotations — assigned_staff_id for claim ownership
  // NOTE: quotations already has reminder_sent_at (used for client SLA WhatsApp reminder).
  //       We use staff_reminder_sent_at for the consultant email reminder to avoid collision.
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS claimed_at          TIMESTAMPTZ`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS notified_at         TIMESTAMPTZ`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS staff_reminder_sent_at TIMESTAMPTZ`,

  // tickets — add assigned_staff_id (IF NOT EXISTS covers new schema where it already exists)
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`,

  // conversations — add assigned_staff_id (IF NOT EXISTS covers new schema where it already exists)
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`,

  // indexes for the reminder job's unclaimed queries
  `CREATE INDEX IF NOT EXISTS idx_quotations_unclaimed     ON quotations(notified_at)     WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_unclaimed        ON tickets(notified_at)        WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_unclaimed  ON conversations(notified_at)  WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL`,
];

async function run() {
  const client = await pool.connect();
  try {
    for (const sql of steps) {
      logger.info('Migration step', { sql: sql.slice(0, 100) });
      await client.query(sql);
    }
    logger.info('addConsultantColumns migration complete ✓');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  logger.error('Migration failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
