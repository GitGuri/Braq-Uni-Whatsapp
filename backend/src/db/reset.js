/**
 * DESTRUCTIVE: drops every Braq Connect table and type (including the
 * migration history, job queue and inbound event log), then re-applies every
 * versioned migration.
 * Local development only.
 *
 * Refuses to run unless ALL of the following hold:
 *   • the --yes-wipe-everything flag is passed (npm run db:reset passes it)
 *   • NODE_ENV is not 'production'
 *   • the database is not hosted on Supabase (production lives there)
 *   • the database host is local, or --allow-remote-host is also passed
 *
 * Usage (from backend/):
 *   npm run db:reset
 *   npm run seed
 */
import { pathToFileURL } from 'node:url';
import { config } from '../core/config.js';
import { pool } from '../core/db.js';
import { migrate } from '../core/migrate.js';
import { logger } from '../core/logger.js';

const DROP_STATEMENTS = [
`DROP TABLE IF EXISTS
  order_stage_history, order_size_entries, broadcasts, purchase_orders,
  school_catalog, payments, tickets, quotations, orders, messages,
  conversations, products, clients, staff, settings, sequence_counters,
  schema_migrations, jobs, inbound_events
  CASCADE`,

`DROP TYPE IF EXISTS
  order_stage, session_state, purchase_order_status, payment_status,
  client_type, message_direction, message_status, quotation_status,
  staff_role, ticket_category, ticket_status, payment_type, product_category
  CASCADE`,
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function targetHost() {
  if (!config.db.url) return config.db.host;
  try { return new URL(config.db.url).hostname; } catch { return ''; }
}

function refusal(argv) {
  if (!argv.includes('--yes-wipe-everything')) {
    return 'Refusing to wipe the database: pass --yes-wipe-everything (or use `npm run db:reset`).';
  }
  if (config.env === 'production') {
    return 'Refusing to wipe the database: NODE_ENV is production.';
  }
  const host = targetHost();
  if (/supabase\.(co|com|net)$/i.test(host) || /supabase/i.test(config.db.url)) {
    return `Refusing to wipe the database: ${host || 'target'} is a Supabase host (production). Point DATABASE_URL at a local Postgres.`;
  }
  if (!LOCAL_HOSTS.has(host) && !argv.includes('--allow-remote-host')) {
    return `Refusing to wipe the database on non-local host "${host}": pass --allow-remote-host as well if you really mean it.`;
  }
  return null;
}

export async function reset(argv = process.argv.slice(2)) {
  const reason = refusal(argv);
  if (reason) throw new Error(reason);

  logger.warn(`Wiping database on ${targetHost()} — dropping all tables and types...`);
  for (const sql of DROP_STATEMENTS) await pool.query(sql);
  await migrate();
  logger.info('Database reset complete. Run `npm run seed` to create the admin user.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reset()
    .catch((err) => {
      logger.error('Reset failed', { error: err.message });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
