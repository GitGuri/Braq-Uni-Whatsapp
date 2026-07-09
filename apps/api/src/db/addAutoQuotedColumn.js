import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'quotations' AND column_name = 'auto_quoted'
        ) THEN
          ALTER TABLE quotations ADD COLUMN auto_quoted BOOLEAN NOT NULL DEFAULT false;
          RAISE NOTICE 'Added auto_quoted column to quotations';
        ELSE
          RAISE NOTICE 'auto_quoted column already exists — skipping';
        END IF;
      END $$;
    `);
    logger.info('Migration complete: auto_quoted column');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
