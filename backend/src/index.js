/**
 * API process boot. Runs NO DDL: it refuses to start while migrations are
 * pending (deploy step: `npm run migrate`). Starts the job worker + scheduler
 * in-process unless WORKER_IN_PROCESS=false (then run `npm run worker`).
 *
 * Shutdown (SIGTERM / SIGINT, e.g. a deploy): stop accepting requests, let the
 * in-process worker finish the jobs it is running (up to WORKER_DRAIN_MS), close
 * the pool, exit. A bot turn cut off anyway is replayed safely (DAT-2).
 */
import { config, assertProductionConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { pool, testConnection } from './core/db.js';
import { assertSchemaUpToDate } from './core/migrate.js';
import { createApp } from './app.js';
import { startWorker } from './workers/loop.js';
import { startScheduler } from './workers/scheduler.js';
import { installProcessHandlers } from './core/process.js';

async function start() {
  try {
    assertProductionConfig();
    await testConnection();
    await assertSchemaUpToDate();
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('Braq Connect API running', {
      port: config.port,
      env:  config.env,
      webhook: `${config.apiBaseUrl}/webhook`,
      worker: config.worker.inProcess ? 'in-process' : 'external',
    });
  });

  let worker = null;
  let scheduler = null;
  if (config.worker.inProcess) {
    worker = startWorker();
    scheduler = startScheduler();
  }

  installProcessHandlers({
    name: 'api',
    async drain() {
      await new Promise((resolve) => server.close(() => resolve()));
      scheduler?.stop();
      await worker?.stop({ timeoutMs: config.worker.drainMs });
      await pool.end().catch(() => {});
    },
  });
}

start();
