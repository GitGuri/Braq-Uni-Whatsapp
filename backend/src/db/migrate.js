/**
 * `npm run migrate` / `node src/db/migrate.js` — applies pending versioned
 * migrations from src/db/migrations (see core/migrate.js). Non-destructive:
 * safe on a fresh database and on production. Nothing else (server boot
 * included) runs DDL.
 *
 * To wipe everything and start over on a LOCAL dev database use
 * `npm run db:reset` (src/db/reset.js) instead.
 */
import { pathToFileURL } from 'node:url';
import { pool } from '../core/db.js';
import { logger } from '../core/logger.js';
import { migrate } from '../core/migrate.js';

export { migrate };

// Run only when invoked directly (reset.js imports migrate() instead)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .catch((err) => {
      logger.error('Migration failed', { error: err.message });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
