// Bulk orders (schools & companies): repeat the previous order (its line items
// at today's catalogue prices, straight into the order confirmation), new
// uniforms (→ quotation), production / delivery updates (the client's open
// orders — no reference needed), account queries (→ ticket) and "9" for a person.
import { TEMPLATES } from '../templates.js';
import { CONFIRM_RE } from '../intents.js';
import { startQuote } from './quote.js';
import { startTracking, orderTotals } from './order.js';
import { requestConsultant } from './handoff.js';
import { logTicket } from './ticket.js';
import { gateOrProceed } from './registration.js';
import { lastOrderWithItems, isAccountClient } from '../lookups.js';
import { listProducts } from '../../catalog/service.js';
import { priceLineItem } from '../../quotations/service.js';

const notAnOption = (c) => {
  c.setState('corporate_menu');
  return c.say(`Sorry, that's not one of the options. 🙂\n\n${TEMPLATES.CORPORATE_MENU()}`);
};

export async function corporateMenu(c) {
  if (c.intent.type !== 'menu') {
    const { handleFreeText } = await import('../freeText.js');
    return handleFreeText(c, 'corporate');
  }
  switch (c.intent.value) {
    case 1:
      return startRepeatOrder(c);
    case 2:
      // New uniform development → quotation flow
      return startQuote(c);
    case 3:
    case 4:
      return startTracking(c);
    case 5:
      c.setState('corporate_account_query');
      return c.R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_ASK);
    case 6:
      // The old corporate menu numbered "speak to a consultant" 6
      return requestConsultant(c, 'Corporate enquiry');
    default:
      return notAnOption(c);
  }
}

// ── Repeat the previous order ────────────────────────────────────────────────
export function startRepeatOrder(c) {
  return gateOrProceed(c, { purpose: 'order', pendingIntent: 'repeat' }, () => beginRepeatOrder(c));
}

/** Last order's items at today's prices (catalogue items) → the direct-order confirmation. */
export async function beginRepeatOrder(c) {
  const last = await lastOrderWithItems(c.client.id);
  if (!last) {
    c.setState('order_gathering', { orderHistory: [], orderFollowups: 0 });
    return c.R(TEMPLATES.CORPORATE_NO_PREVIOUS_ORDER);
  }
  const products = new Map((await listProducts({ activeOnly: true })).map((p) => [p.id, p]));
  const items = (Array.isArray(last.line_items) ? last.line_items : []).map((item) => {
    const product = item.productId ? products.get(item.productId) : null;
    const repeat = { ...item, priceConfirmed: true };
    if (product) repeat.unitPrice = Number(product.price);
    delete repeat.aiNote;
    return priceLineItem(repeat);
  });
  c.setState('order_confirm_direct', { pendingOrderItems: items, repeatOf: last.reference });
  return c.R(TEMPLATES.CORPORATE_REPEAT_OFFER, {
    reference: last.reference, items, ...orderTotals(items), account: isAccountClient(c.client),
  });
}

// Older conversations waiting for a reference to repeat: offer the last order instead.
export function corporateRepeatOrderAsk(c) {
  if (CONFIRM_RE.test(c.body.trim())) return beginRepeatOrder(c);
  return startRepeatOrder(c);
}

// Older conversations waiting for a reference here: show their open orders instead.
export const corporateRefAsk = (c) => startTracking(c);

export async function corporateAccountQuery(c) {
  const description = c.body.trim();
  if (description.length < 5) return c.R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_ASK);
  await logTicket(c, { category: 'account_query', description });
  return c.R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_LOGGED, { ticketNo: c.turn.lastTicketNo });
}
