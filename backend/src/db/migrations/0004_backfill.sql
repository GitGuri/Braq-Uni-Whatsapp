-- 0004 backfills. Each UPDATE only touches rows that are still unset, so the
-- file is safe to re-run and resumable after an interruption.

-- orders.total_amount: the linked quotation's total, else what the deposit /
-- balance bookkeeping implies (balance is kept as total - max(paid, deposit)).
UPDATE orders o
SET total_amount = COALESCE(
      (SELECT NULLIF(q.total, 0) FROM quotations q WHERE q.id = o.quotation_id),
      o.balance_amount + GREATEST(
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id), 0),
        COALESCE(o.deposit_amount, 0)))
WHERE o.total_amount IS NULL
  AND (o.quotation_id IS NOT NULL OR o.balance_amount IS NOT NULL);

-- tickets.order_id: link a ticket to its client's order when that client has exactly one.
UPDATE tickets t
SET order_id = only_order.id
FROM (
  SELECT client_id, (array_agg(id))[1] AS id
  FROM orders
  GROUP BY client_id
  HAVING COUNT(*) = 1
) only_order
WHERE t.order_id IS NULL
  AND t.client_id = only_order.client_id;
