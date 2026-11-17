/**
 * Process-level handlers shared by the API (index.js) and the worker (worker.js).
 *
 *  - SIGTERM / SIGINT: run drain() once (stop intake, finish running jobs, close
 *    the pool), then exit 0. A second signal, or a drain that hangs past
 *    drainMs + 5 s, exits 1 at once.
 *  - unhandledRejection / uncaughtException: logged with the stack through the
 *    app logger, then the process exits 1 so the platform restarts it from a
 *    clean state (Node's default, but now visible in the logs). Route handlers
 *    never get here — app.js routes every handler error to errorMiddleware.
 */
import { config } from './config.js';
import { logger } from './logger.js';

export function installProcessHandlers({ name, drain, exit = (code) => process.exit(code) }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      logger.warn(`${name}: second ${signal} — exiting now`);
      return exit(1);
    }
    shuttingDown = true;
    logger.info(`${name}: ${signal} received — draining`);
    const hardStop = setTimeout(() => {
      logger.error(`${name}: drain did not finish in time — exiting`);
      exit(1);
    }, config.worker.drainMs + 5000);
    hardStop.unref?.();
    try {
      await drain();
      logger.info(`${name}: stopped cleanly`);
      exit(0);
    } catch (err) {
      logger.error(`${name}: drain failed`, { error: err.message });
      exit(1);
    } finally {
      clearTimeout(hardStop);
    }
  };

  const fatal = (kind) => (err) => {
    logger.error(`${name}: ${kind}`, { error: err?.message ?? String(err), stack: err?.stack });
    exit(1);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', fatal('unhandled promise rejection'));
  process.on('uncaughtException', fatal('uncaught exception'));
  return { shutdown };
}
