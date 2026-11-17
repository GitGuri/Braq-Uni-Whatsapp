/**
 * Standalone job worker: `npm run worker`.
 * Runs the same loop as the API's in-process worker — start the API with
 * WORKER_IN_PROCESS=false when workers run separately. Any number of workers
 * can run at once (jobs are claimed with SKIP LOCKED; schedules are deduped).
 */
import { logger } from './core/logger.js';
import { pool, testConnection } from './core/db.js';
import { assertSchemaUpToDate } from './core/migrate.js';
import { startWorker } from './workers/loop.js';
import { startScheduler } from './workers/scheduler.js';

async function main() {
  await testConnection();
  await assertSchemaUpToDate();
  const worker = startWorker();
  const scheduler = startScheduler();

  const shutdown = async (signal) => {
    logger.info(`worker: ${signal} received, draining`);
    scheduler.stop();
    await worker.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Worker failed to start', { error: err.message });
  process.exit(1);
});
