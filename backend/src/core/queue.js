/**
 * Durable Postgres job queue / outbox (table `jobs`, migration 0002).
 *
 *   enqueue(client, type, payload, { runAt, dedupeKey, queueKey, maxAttempts })
 *     Insert a job using the CALLER'S client — pass the transaction client so the
 *     job commits (or rolls back) together with the domain write. A duplicate
 *     dedupeKey is silently ignored (returns null). pg_notify('jobs') wakes
 *     listening workers when the transaction commits.
 *
 *   claimBatch / complete / fail / reclaimStale / prune are used by workers/loop.js.
 *
 * queueKey serialises jobs: a job is only claimed when no older job with the same
 * key is pending or running (e.g. `wa:<phone>` keeps one client's messages in order).
 */
import { config } from './config.js';

export const DEFAULT_MAX_ATTEMPTS = 8;
export const STALE_LOCK_MS = 5 * 60 * 1000;
export const PRUNE_DONE_AFTER_DAYS = 14;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Throw from a handler to dead-letter the job immediately (no retries). */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

/**
 * @param {{ query: Function }} client  transaction client (or the pool for a standalone job)
 * @param {string} type                 handler name, e.g. 'whatsapp.send'
 * @param {object} [payload]
 * @param {{ runAt?: Date|string, dedupeKey?: string, queueKey?: string, maxAttempts?: number }} [opts]
 * @returns {Promise<number|null>} the new job id, or null when dedupeKey already existed
 */
export async function enqueue(client, type, payload = {}, { runAt = null, dedupeKey = null, queueKey = null, maxAttempts = null } = {}) {
  if (!client?.query) throw new TypeError('enqueue(client, …) needs a db client');
  if (!type) throw new TypeError('enqueue: job type is required');
  const { rows } = await client.query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, queue_key, max_attempts)
     VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), $4, $5, COALESCE($6::int, ${DEFAULT_MAX_ATTEMPTS}))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [type, JSON.stringify(payload ?? {}), runAt, dedupeKey, queueKey, maxAttempts]
  );
  await client.query(`SELECT pg_notify('jobs', $1)`, [type]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** Claim up to `limit` ready jobs for `workerId` (FIFO per queue_key, SKIP LOCKED). */
export async function claimBatch(client, workerId, limit = 1) {
  const { rows } = await client.query(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id IN (
       SELECT j.id FROM jobs j
       WHERE j.status = 'pending' AND j.run_at <= now()
         AND (j.queue_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM jobs o
               WHERE o.queue_key = j.queue_key AND o.status IN ('pending', 'running') AND o.id < j.id))
       ORDER BY j.run_at, j.id
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId, limit]
  );
  return rows;
}

/**
 * Mark a job done. lockedBy (the worker that claimed it): only while that worker
 * still holds it — a job reclaimed after a stall and re-run elsewhere is not
 * overwritten by the slow first run (Q-1). Returns false when the lock was lost.
 */
export async function complete(client, jobId, lockedBy = null) {
  const { rowCount } = await client.query(
    `UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE id = $1 AND ($2::text IS NULL OR (locked_by = $2 AND status = 'running'))`,
    [jobId, lockedBy]
  );
  return rowCount > 0;
}

/** Delay before retry n (1-based): min(2^n × base, 1h) + up to 1s jitter. */
export function backoffMs(attempts, baseMs = config.worker.backoffBaseMs) {
  return Math.min(2 ** attempts * baseMs, MAX_BACKOFF_MS) + Math.floor(Math.random() * Math.min(1000, baseMs));
}

/**
 * Record a failed attempt: dead-letter when attempts are used up (or the error
 * is permanent), otherwise back to pending with exponential backoff.
 * @returns {'dead'|'retry'|'lost'} lost: another worker owns the job now (it was reclaimed)
 */
export async function fail(client, job, err) {
  const message = String(err?.stack || err?.message || err).slice(0, 4000);
  const dead = err?.permanent === true || job.attempts >= job.max_attempts;
  // Fenced like complete(): only while this worker still holds the job (Q-1).
  const fence = `AND ($LB::text IS NULL OR (locked_by = $LB AND status = 'running'))`;
  const lockedBy = job.locked_by ?? null;
  if (dead) {
    const { rowCount } = await client.query(
      `UPDATE jobs SET status = 'dead', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = $2
       WHERE id = $1 ${fence.replaceAll('$LB', '$3')}`,
      [job.id, message, lockedBy]
    );
    return rowCount ? 'dead' : 'lost';
  }
  const { rowCount } = await client.query(
    `UPDATE jobs SET status = 'pending', run_at = now() + ($2::int * interval '1 millisecond'),
            locked_at = NULL, locked_by = NULL, last_error = $3
     WHERE id = $1 ${fence.replaceAll('$LB', '$4')}`,
    [job.id, backoffMs(job.attempts), message, lockedBy]
  );
  return rowCount ? 'retry' : 'lost';
}

/** Jobs left 'running' by a crashed worker go back to pending (or dead when out of attempts). */
export async function reclaimStale(client, olderThanMs = STALE_LOCK_MS) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET status     = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         last_error = COALESCE(last_error, 'worker lock expired'),
         locked_at = NULL, locked_by = NULL
     WHERE status = 'running' AND locked_at < now() - ($1::int * interval '1 millisecond')
     RETURNING id`,
    [olderThanMs]
  );
  return rows.length;
}

/** Delete finished jobs older than `days`. */
export async function prune(client, days = PRUNE_DONE_AFTER_DAYS) {
  const { rowCount } = await client.query(
    `DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - ($1::int * interval '1 day')`,
    [days]
  );
  return rowCount;
}
