import { query } from '../db/pool.js';

// ── Monthly revenue (last 12 months) ─────────────────────────────────────────
export async function getRevenueByMonth() {
  const { rows } = await query(`
    SELECT
      TO_CHAR(p.created_at, 'YYYY-MM') AS month,
      SUM(p.amount)                    AS revenue,
      COUNT(DISTINCT p.order_id)       AS orders
    FROM payments p
    WHERE p.created_at >= NOW() - INTERVAL '12 months'
    GROUP BY month
    ORDER BY month ASC
  `);
  return rows;
}

// ── Top clients by total spend ────────────────────────────────────────────────
export async function getTopClients(limit = 10) {
  const { rows } = await query(`
    SELECT
      c.id,
      c.name,
      c.organisation,
      c.whatsapp_number,
      COUNT(DISTINCT o.id)   AS total_orders,
      COALESCE(SUM(p.amount), 0) AS total_spent
    FROM clients c
    LEFT JOIN orders   o ON o.client_id = c.id
    LEFT JOIN payments p ON p.order_id  = o.id
    GROUP BY c.id, c.name, c.organisation, c.whatsapp_number
    ORDER BY total_spent DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

// ── Best-selling products (by qty across accepted quotation line items) ────────
export async function getBestSellingProducts(limit = 10) {
  const { rows } = await query(`
    SELECT
      item->>'name'                    AS product,
      SUM((item->>'quantity')::numeric) AS total_qty,
      COUNT(*)                          AS appearances
    FROM quotations q,
         LATERAL jsonb_array_elements(
           CASE jsonb_typeof(q.line_items)
             WHEN 'array' THEN q.line_items
             ELSE '[]'::jsonb
           END
         ) AS item
    WHERE q.status IN ('accepted')
    GROUP BY product
    ORDER BY total_qty DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

// ── Quotation conversion rate ─────────────────────────────────────────────────
export async function getQuotationConversionRate() {
  const { rows } = await query(`
    SELECT
      COUNT(*)                                             AS total,
      COUNT(*) FILTER (WHERE status = 'accepted')         AS accepted,
      COUNT(*) FILTER (WHERE status = 'sent')             AS sent,
      COUNT(*) FILTER (WHERE status = 'draft')            AS draft,
      COUNT(*) FILTER (WHERE status = 'rejected')         AS rejected,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'accepted')
        / NULLIF(COUNT(*) FILTER (WHERE status IN ('sent','accepted','rejected')), 0),
        1
      )                                                    AS conversion_pct
    FROM quotations
  `);
  return rows[0];
}

// ── Revenue summary (current month vs last month) ─────────────────────────────
export async function getRevenueSummary() {
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(amount) FILTER (
        WHERE created_at >= DATE_TRUNC('month', NOW())
      ), 0)                                           AS this_month,
      COALESCE(SUM(amount) FILTER (
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
          AND created_at  < DATE_TRUNC('month', NOW())
      ), 0)                                           AS last_month,
      COALESCE(SUM(amount), 0)                        AS all_time
    FROM payments
  `);
  return rows[0];
}

// ── Order stage breakdown ─────────────────────────────────────────────────────
export async function getOrderStageBreakdown() {
  const { rows } = await query(`
    SELECT stage, COUNT(*) AS count
    FROM orders
    WHERE stage != 'completed'
    GROUP BY stage
    ORDER BY stage
  `);
  return rows;
}
