/**
 * 'quotation.expire' — persist status 'expired' on sent quotations past their
 * validity (reads already report them as expired). Scheduled by workers/scheduler.js.
 */
import { withTransaction } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { expireStaleQuotations } from '../../modules/quotations/service.js';

export default async function quotationExpire() {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('job:quotation.expire')) AS locked`);
    if (!rows[0].locked) return { skipped: 'another expiry run is in progress' };
    const expired = await expireStaleQuotations();
    if (expired) logger.info('quotation.expire: marked quotations expired', { count: expired });
    return { expired };
  });
}
