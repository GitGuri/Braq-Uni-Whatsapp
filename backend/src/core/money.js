/**
 * Money and the business numbers that go with it — defined ONCE here.
 * All arithmetic is done in integer cents; rands only at the edges.
 *
 * Prices EXCLUDE VAT: vat = subtotal × 15% (rounded half-up to the cent),
 * total = subtotal + vat. Orders take a 60% deposit of the total; the balance is
 * the remainder so deposit + balance always equals the total exactly.
 */

export const CURRENCY            = 'ZAR';
export const VAT_RATE_BP         = 1500;               // basis points (15.00%)
export const VAT_PERCENT         = VAT_RATE_BP / 100;  // 15
export const DEPOSIT_PERCENT     = 60;
export const QUOTE_VALIDITY_DAYS = 30;
export const TICKET_SLA_HOURS    = 4;
export const QUOTE_SLA_HOURS     = 4;

/** Rands (number | numeric string) → integer cents; invalid/empty → 0. */
export function toCents(n) {
  const c = Math.round(Number(n) * 100);
  return Number.isFinite(c) ? c : 0;
}

/** Like toCents, but null/''/non-numeric → null (for "unknown" amounts). */
export function toCentsOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Integer cents → rands (number). */
export const fromCents = (c) => c / 100;

/** Cents → "1234.50" (two decimals, no currency symbol). */
export const centsToFixed = (c) => (c / 100).toFixed(2);

/** Cents → "R 1234.50". */
export const formatRand = (c) => `R ${centsToFixed(c)}`;

/** VAT on a subtotal, half-up to the cent. */
export const vatCents = (subtotalCents) => Math.round((subtotalCents * VAT_RATE_BP) / 10000);

/** Totals from a list of line totals in cents → { subtotalCents, vatCents, totalCents }. */
export function calcTotals(lineTotalsCents) {
  const subtotalCents = lineTotalsCents.reduce((s, c) => s + c, 0);
  const vat = vatCents(subtotalCents);
  return { subtotalCents, vatCents: vat, totalCents: subtotalCents + vat };
}

/** Deposit/balance split of a total: deposit = round(total × pct), balance = remainder. */
export function splitDeposit(totalCents, percent = DEPOSIT_PERCENT) {
  const depositCents = Math.round((totalCents * percent) / 100);
  return { depositCents, balanceCents: totalCents - depositCents };
}

/** Deposit (in rands) for a total given in rands — for client-facing messages. */
export const depositForTotal = (totalRands) => fromCents(splitDeposit(toCents(totalRands)).depositCents);
