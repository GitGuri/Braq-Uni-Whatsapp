/**
 * Recurring jobs without setInterval-per-instance: every instance inserts the
 * job for the current time bucket with dedupe key `<type>:<bucket>`, so each
 * bucket runs exactly once across all instances (the queue does the rest).
 */
import { pool } from '../core/db.js';
import { logger } from '../core/logger.js';
import { enqueue } from '../core/queue.js';

const THIRTY_MIN = 30 * 60 * 1000;

export const SCHEDULES = [
  { type: 'reminder.scan',    everyMs: THIRTY_MIN },
  { type: 'quotation.expire', everyMs: THIRTY_MIN },
];

/** Enqueue the current bucket's job for every schedule (duplicates are ignored). */
export async function scheduleDue({ now = Date.now(), db = pool, schedules = SCHEDULES } = {}) {
  const enqueued = [];
  for (const { type, everyMs } of schedules) {
    const bucket = Math.floor(now / everyMs);
    const id = await enqueue(db, type, { bucket }, { dedupeKey: `${type}:${bucket}`, maxAttempts: 3 });
    if (id) enqueued.push({ type, bucket, id });
  }
  return enqueued;
}

/** Check for a new bucket every `checkMs` (default 1 min). Returns { stop }. */
export function startScheduler({ checkMs = 60 * 1000 } = {}) {
  const run = () => scheduleDue().catch((err) => logger.error('scheduler failed', { error: err.message }));
  run();
  const timer = setInterval(run, checkMs);
  logger.info('scheduler started', { schedules: SCHEDULES.map((s) => s.type) });
  return { stop: () => clearInterval(timer) };
}
