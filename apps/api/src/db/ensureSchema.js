/**
 * Safe, additive schema patches — run automatically on server start.
 * Every statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it
 * is safe to run on a fully-migrated DB as well as a fresh one.
 */
import { query } from './pool.js';
import { logger } from '../utils/logger.js';

const patches = [
  // Broadcasts history table
  `CREATE TABLE IF NOT EXISTS broadcasts (
     id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     sent_by          UUID        REFERENCES staff(id) ON DELETE SET NULL,
     message_type     TEXT        NOT NULL,
     body             TEXT        NOT NULL,
     recipient_count  INT         NOT NULL DEFAULT 0,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC)`,

  // Digital proof columns on orders
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_url      TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_status   TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_notes    TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_sent_at  TIMESTAMPTZ`,

  // Material / stock notes on orders
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS material_notes JSONB NOT NULL DEFAULT '{}'::jsonb`,

  // auto_quoted flag on quotations (added in earlier session)
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS auto_quoted BOOLEAN NOT NULL DEFAULT false`,
];

export async function ensureSchema() {
  for (const sql of patches) {
    try {
      await query(sql);
    } catch (err) {
      // Log but never crash startup — a missing column is better than a dead server
      logger.warn('ensureSchema patch failed', { sql: sql.slice(0, 80), error: err.message });
    }
  }
  logger.info('ensureSchema complete ✓');
}
