/**
 * express-rate-limit store backed by Postgres (table rate_limits, migration
 * 0008) so a limit holds across every API instance. Keys are SHA-256 hashed —
 * the table never holds IP addresses or email addresses.
 *
 * Used for the login brute-force guard; the general API limiter stays in memory.
 */
import crypto from 'node:crypto';
import { query } from './db.js';

const hash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

export class PgRateLimitStore {
  /** @param {{ prefix?: string, db?: { query: Function } }} [opts] */
  constructor({ prefix = 'rl:', db = { query } } = {}) {
    this.prefix = prefix;
    this.db = db;
    this.windowMs = 60 * 1000;
    // Counts are shared between instances, not local to this process
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(k) {
    return `${this.prefix}${hash(k)}`;
  }

  async get(k) {
    const { rows } = await this.db.query(
      'SELECT count, reset_at FROM rate_limits WHERE key = $1 AND reset_at > now()', [this.key(k)]);
    return rows[0] ? { totalHits: rows[0].count, resetTime: new Date(rows[0].reset_at) } : undefined;
  }

  async increment(k) {
    // A window that has run out starts over at 1.
    const { rows } = await this.db.query(
      `INSERT INTO rate_limits (key, count, reset_at)
       VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
      [this.key(k), this.windowMs]
    );
    return { totalHits: rows[0].count, resetTime: new Date(rows[0].reset_at) };
  }

  async decrement(k) {
    await this.db.query(
      'UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE key = $1 AND reset_at > now()', [this.key(k)]);
  }

  async resetKey(k) {
    await this.db.query('DELETE FROM rate_limits WHERE key = $1', [this.key(k)]);
  }

  async resetAll() {
    await this.db.query('DELETE FROM rate_limits WHERE key LIKE $1', [`${this.prefix}%`]);
  }
}

/** Delete windows that ended more than a day ago (worker maintenance). */
export async function pruneRateLimits(db = { query }) {
  const { rowCount } = await db.query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`);
  return rowCount;
}
