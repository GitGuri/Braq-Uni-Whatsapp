/**
 * API process boot. Runs NO DDL: it refuses to start while migrations are
 * pending (deploy step: `npm run migrate`). Starts the job worker + scheduler
 * in-process unless WORKER_IN_PROCESS=false (then run `npm run worker`).
 */
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { testConnection } from './core/db.js';
import { assertSchemaUpToDate } from './core/migrate.js';
import { createApp } from './app.js';
import { startWorker } from './workers/loop.js';
import { startScheduler } from './workers/scheduler.js';

async function start() {
  try {
    await testConnection();
    await assertSchemaUpToDate();
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }

  const app = createApp();
  app.listen(config.port, () => {
    logger.info('Braq Connect API running', {
      port: config.port,
      env:  config.env,
      webhook: `${config.apiBaseUrl}/webhook`,
      worker: config.worker.inProcess ? 'in-process' : 'external',
    });
  });

  if (config.worker.inProcess) {
    startWorker();
    startScheduler();
  }
}

start();
