/**
 * Job worker loop: claims ready jobs, runs their handlers, completes / retries /
 * dead-letters them, reclaims stale locks and prunes old jobs.
 *
 * Wake-ups: LISTEN 'jobs' on a dedicated direct connection when
 * DATABASE_DIRECT_URL is set (Supabase's transaction pooler drops LISTEN), plus a
 * poll every WORKER_POLL_MS as a safety net (the only mechanism without a direct URL).
 */
import os from 'node:os';
import crypto from 'node:crypto';
import { pool, connectDirect, hasDirectUrl } from '../core/db.js';
import { config } from '../core/config.js';
import { logger, runWithContext } from '../core/logger.js';
import { claimBatch, complete, fail, reclaimStale, prune, PermanentJobError } from '../core/queue.js';
import { pruneRateLimits } from '../core/rateLimitStore.js';
import { handlers as defaultHandlers } from './handlers/index.js';

const MAINTENANCE_MS = 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * @param {{ handlers?: object, concurrency?: number, pollMs?: number, listen?: boolean, id?: string }} [opts]
 * @returns {{ id: string, stop: () => Promise<void>, kick: () => void, idle: () => Promise<void> }}
 */
export function startWorker({
  handlers = defaultHandlers,
  concurrency = config.worker.concurrency,
  pollMs = config.worker.pollMs,
  listen = hasDirectUrl(),
  id = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
} = {}) {
  let stopping = false;
  let inflight = 0;
  let ticking = false;
  let again = false;
  let pollTimer = null;
  let maintTimer = null;
  let listenClient = null;
  let lastPrune = 0;
  const idleWaiters = [];

  const settleIdle = () => {
    if (inflight === 0 && !ticking) idleWaiters.splice(0).forEach((r) => r());
  };

  async function runJob(job) {
    const handler = handlers[job.type];
    const started = Date.now();
    try {
      if (!handler) throw new PermanentJobError(`No handler for job type "${job.type}"`);
      await runWithContext({ jobId: job.id }, () => handler(job.payload || {}, { job }));
      await complete(pool, job.id);
      logger.debug('job done', { jobId: job.id, type: job.type, ms: Date.now() - started });
    } catch (err) {
      try {
        const outcome = await fail(pool, job, err);
        const log = outcome === 'dead' ? logger.error : logger.warn;
        log.call(logger, `job ${outcome === 'dead' ? 'dead-lettered' : 'failed, will retry'}`, {
          jobId: job.id, type: job.type, attempt: job.attempts, error: err?.message,
        });
      } catch (e) {
        logger.error('job failure could not be recorded (lock will be reclaimed)', { jobId: job.id, error: e.message });
      }
    }
  }

  async function tick() {
    if (stopping) return;
    if (ticking) { again = true; return; }
    ticking = true;
    try {
      do {
        again = false;
        const free = concurrency - inflight;
        if (free <= 0) break;
        const jobs = await claimBatch(pool, id, free);
        for (const job of jobs) {
          inflight++;
          runJob(job).finally(() => {
            inflight--;
            settleIdle();
            if (!stopping) setImmediate(tick);
          });
        }
        if (jobs.length === free) again = true; // there may be more waiting
      } while (again && !stopping);
    } catch (err) {
      if (!stopping) logger.error('worker claim failed', { error: err.message });
    } finally {
      ticking = false;
      settleIdle();
    }
  }

  async function maintenance() {
    try {
      const reclaimed = await reclaimStale(pool);
      if (reclaimed) logger.warn('worker reclaimed stale jobs', { count: reclaimed });
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        const pruned = await prune(pool);
        if (pruned) logger.info('worker pruned finished jobs', { count: pruned });
        await pruneRateLimits(pool);
      }
    } catch (err) {
      if (!stopping) logger.error('worker maintenance failed', { error: err.message });
    }
  }

  async function startListening() {
    try {
      listenClient = await connectDirect();
      listenClient.on('notification', () => tick());
      listenClient.on('error', (err) => {
        logger.warn('worker LISTEN connection lost — polling only', { error: err.message });
        listenClient = null;
      });
      await listenClient.query('LISTEN jobs');
      logger.info('worker listening for job notifications');
    } catch (err) {
      logger.warn('worker could not LISTEN — polling only', { error: err.message });
      listenClient = null;
    }
  }

  const schedulePoll = () => {
    if (stopping) return;
    pollTimer = setTimeout(async () => { await tick(); schedulePoll(); }, pollMs);
  };

  maintenance().then(() => tick());
  schedulePoll();
  maintTimer = setInterval(maintenance, MAINTENANCE_MS);
  if (listen) startListening();
  logger.info('worker started', { id, concurrency, pollMs, listen });

  return {
    id,
    /** Run a claim pass now (tests / after enqueue in-process). */
    kick: () => { tick(); },
    /** Resolves when nothing is running. */
    idle: () => new Promise((r) => { idleWaiters.push(r); settleIdle(); }),
    async stop({ timeoutMs = 10000 } = {}) {
      stopping = true;
      clearTimeout(pollTimer);
      clearInterval(maintTimer);
      if (listenClient) await listenClient.end().catch(() => {});
      const deadline = Date.now() + timeoutMs;
      while ((inflight > 0 || ticking) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      logger.info('worker stopped', { id });
    },
  };
}
