/**
 * Standalone job worker: `npm run worker`.
 * Runs the same loop as the API's in-process worker — start the API with
 * WORKER_IN_PROCESS=false when workers run separately. Any number of workers
 * can run at once (jobs are claimed with SKIP LOCKED; schedules are deduped).
 */
import { config, assertProductionConfig } from './core/config.js';
import { installProcessHandlers } from './core/process.js';
import { logger } from './core/logger.js';
import { pool, testConnection } from './core/db.js';
import { assertSchemaUpToDate } from './core/migrate.js';
import { startWorker } from './workers/loop.js';
import { startScheduler } from './workers/scheduler.js';

async function main() {
  assertProductionConfig();
  await testConnection();
  await assertSchemaUpToDate();
  const worker = startWorker();
  const scheduler = startScheduler();

  installProcessHandlers({
    name: 'worker',
    async drain() {
      scheduler.stop();
      await worker.stop({ timeoutMs: config.worker.drainMs });
      await pool.end().catch(() => {});
    },
  });
}

main().catch((err) => {
  logger.error('Worker failed to start', { error: err.message });
  process.exit(1);
});
