/**
 * Backfill script — needs_review flag
 *
 * Runs every existing order and quotation through the pure-function validators
 * and stamps needs_review = true on any record that currently fails.
 *
 * Safe to run multiple times — uses UPDATE WHERE id = $1, no deletes.
 *
 * Usage:
 *   node src/db/backfill-needs-review.js
 *   npm run backfill             (from apps/api)
 *   npm run backfill             (from repo root)
 */

import { pool } from './pool.js';
import { validateOrder }     from '../validators/order.validator.js';
import { validateQuotation } from '../validators/quotation.validator.js';
import { logger }            from '../utils/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRows(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

async function setNeedsReview(client, table, id, flag) {
  await client.query(
    `UPDATE ${table} SET needs_review = $1 WHERE id = $2`,
    [flag, id],
  );
}

// ── Backfill orders ───────────────────────────────────────────────────────────

async function backfillOrders(client) {
  const orders = await fetchRows(client, `
    SELECT o.*,
           c.preferred_store_location,
           c.physical_address,
           c.delivery_preference
    FROM orders o
    JOIN clients c ON o.client_id = c.id
    WHERE o.stage NOT IN ('completed', 'cancelled')
  `);

  let flagged = 0;
  let cleared = 0;

  for (const order of orders) {
    // Fetch size entries inline
    const sizeEntries = await fetchRows(client,
      `SELECT * FROM order_size_entries WHERE order_id = $1`,
      [order.id],
    );

    // Fetch linked quotation if present
    let quotation = null;
    if (order.quotation_id) {
      const rows = await fetchRows(client,
        `SELECT * FROM quotations WHERE id = $1`,
        [order.quotation_id],
      );
      quotation = rows[0] ?? null;
    }

    // The client fields were joined onto the order row above
    const client_ = {
      preferred_store_location: order.preferred_store_location,
      physical_address:         order.physical_address,
      delivery_preference:      order.delivery_preference,
    };

    const { complete } = validateOrder(order, { sizeEntries, quotation, client: client_ });
    const shouldFlag   = !complete;

    if (shouldFlag !== order.needs_review) {
      await setNeedsReview(client, 'orders', order.id, shouldFlag);
    }

    if (shouldFlag) flagged++; else cleared++;
  }

  return { total: orders.length, flagged, cleared };
}

// ── Backfill quotations ───────────────────────────────────────────────────────

async function backfillQuotations(client) {
  const quotations = await fetchRows(client, `
    SELECT * FROM quotations
    WHERE status NOT IN ('accepted', 'rejected', 'expired')
  `);

  let flagged = 0;
  let cleared = 0;

  for (const quotation of quotations) {
    // Draft quotations always need review (no PDF, consultant must price them)
    let shouldFlag = quotation.status === 'draft';

    // For sent quotations, also run the completeness validator
    if (!shouldFlag) {
      const { complete } = validateQuotation(quotation);
      shouldFlag = !complete;
    }

    if (shouldFlag !== quotation.needs_review) {
      await setNeedsReview(client, 'quotations', quotation.id, shouldFlag);
    }

    if (shouldFlag) flagged++; else cleared++;
  }

  return { total: quotations.length, flagged, cleared };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const client = await pool.connect();
  try {
    logger.info('Starting needs_review backfill...');

    const orderResult = await backfillOrders(client);
    logger.info('Orders backfill complete', orderResult);

    const quotationResult = await backfillQuotations(client);
    logger.info('Quotations backfill complete', quotationResult);

    const totalFlagged = orderResult.flagged + quotationResult.flagged;
    logger.info(
      `Backfill finished — ${totalFlagged} record(s) flagged for review`,
      {
        orders: orderResult,
        quotations: quotationResult,
      },
    );
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  logger.error('Backfill failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
