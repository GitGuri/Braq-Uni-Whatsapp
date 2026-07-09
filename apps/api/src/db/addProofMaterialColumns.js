// Additive migration — safe to re-run.
// Adds digital proof tracking and material/stock notes to orders.
import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const steps = [
  // Digital proof approval
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_url        TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_status     TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_notes      TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_sent_at    TIMESTAMPTZ`,
  // Material / stock notes (flexible JSONB bag)
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS material_notes   JSONB NOT NULL DEFAULT '{}'::jsonb`,
  // Broadcasts history table (if not already created)
  `CREATE TABLE IF NOT EXISTS broadcasts (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     sent_by          UUID REFERENCES staff(id) ON DELETE SET NULL,
     message_type     TEXT NOT NULL,
     body             TEXT NOT NULL,
     recipient_count  INT  NOT NULL DEFAULT 0,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC)`,
];

async function run() {
  const client = await pool.connect();
  try {
    for (const sql of steps) {
      logger.info('Migration step', { sql: sql.slice(0, 120) });
      await client.query(sql);
    }
    logger.info('addProofMaterialColumns migration complete ✓');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  logger.error('Migration failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
