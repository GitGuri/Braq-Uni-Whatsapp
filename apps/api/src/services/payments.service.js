import { query } from '../db/pool.js';
import { sendTextMessage } from './whatsapp.service.js';
import { TEMPLATES } from './bot.templates.js';
import { HttpError } from '../utils/httpError.js';

// ── Set the deposit requirement on an order once its PO has been validated ───
export async function requireDeposit(order, quotation) {
  const depositPercentage = Number(quotation.deposit_percentage || 60);
  const depositAmount = Number(quotation.total) * (depositPercentage / 100);

  const { rows } = await query(
    `UPDATE orders SET deposit_percentage = $1, deposit_amount = $2, payment_status = 'deposit_required', updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [depositPercentage, depositAmount, order.id]
  );

  const clientRow = await query('SELECT whatsapp_number FROM clients WHERE id = $1', [order.client_id]);
  if (clientRow.rows[0]?.whatsapp_number) {
    await sendTextMessage(
      clientRow.rows[0].whatsapp_number,
      TEMPLATES.DEPOSIT_REQUIRED({ amount: depositAmount.toFixed(2), percentage: depositPercentage })
    );
  }

  return rows[0];
}

// ── Record a payment, recompute order payment_status, notify the client ──────
export async function recordPayment(orderId, { amount, type, staffId, notes }) {
  const { rows } = await query(
    `SELECT o.*, c.whatsapp_number FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1`,
    [orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');
  const order = rows[0];

  await query(
    `INSERT INTO payments (order_id, amount, payment_type, recorded_by, notes)
     VALUES ($1,$2,$3,$4,$5)`,
    [orderId, amount, type, staffId || null, notes || null]
  );

  const { rows: sumRows } = await query(
    'SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments WHERE order_id = $1',
    [orderId]
  );
  const totalPaid = Number(sumRows[0].total_paid);

  let quotationTotal = null;
  if (order.quotation_id) {
    const { rows: qRows } = await query('SELECT total FROM quotations WHERE id = $1', [order.quotation_id]);
    quotationTotal = qRows[0] ? Number(qRows[0].total) : null;
  }

  let newStatus = order.payment_status;
  let balance = order.balance_amount;

  if (quotationTotal !== null && totalPaid >= quotationTotal) {
    newStatus = 'paid_in_full';
    balance = 0;
  } else if (order.deposit_amount && totalPaid >= Number(order.deposit_amount)) {
    newStatus = 'balance_outstanding';
    balance = quotationTotal !== null ? quotationTotal - totalPaid : null;
  }

  const { rows: updated } = await query(
    `UPDATE orders SET payment_status = $1, balance_amount = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [newStatus, balance, orderId]
  );

  if (order.whatsapp_number && newStatus !== order.payment_status) {
    const msg = newStatus === 'paid_in_full'
      ? TEMPLATES.PAID_IN_FULL()
      : type === 'deposit'
        ? TEMPLATES.DEPOSIT_RECEIVED({ amount: Number(amount).toFixed(2), balance: balance != null ? balance.toFixed(2) : 'N/A' })
        : TEMPLATES.BALANCE_OUTSTANDING({ amount: balance != null ? balance.toFixed(2) : 'N/A' });
    await sendTextMessage(order.whatsapp_number, msg);
  }

  return updated[0];
}

export async function listPaymentsForOrder(orderId) {
  const { rows } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY received_at ASC',
    [orderId]
  );
  return rows;
}
