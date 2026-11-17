// Ordering on WhatsApp and order tracking.
//
//  Place an order: with a sent / accepted quote on file the client is offered
//  "Order from BRQ-Q-… (R x)? 1 Yes / 2 Something else"; otherwise straight to
//  "What would you like to order?" (AI gathering → catalogue order summary →
//  confirm). Items outside the catalogue turn the request into a quote for a
//  consultant (never a dead end). Confirmations accept 1 / yes / ok / confirm / 👍.
//
//  Track: the client's open orders are listed (stage, "Ready for collection" vs
//  "Dispatched", amount still due, due date); one order → its status directly.
import { query } from '../../../core/db.js';
import { HttpError } from '../../../core/errors.js';
import { toCents, fromCents, calcTotals, depositForTotal } from '../../../core/money.js';
import { parseQuotationRequest } from '../../../integrations/ai.client.js';
import { TEMPLATES, fmtDate } from '../templates.js';
import { gather } from '../gathering.js';
import { carriesDetail, CONFIRM_RE, DECLINE_RE, hasLetters } from '../intents.js';
import { gateOrProceed } from './registration.js';
import { finaliseQuotation } from './quote.js';
import {
  offerableQuote, findQuote, quoteStatus, openOrders, orderSummary, orderStageText, amountDueText,
  isAccountClient, phoneDigits,
} from '../lookups.js';
import { listProducts } from '../../catalog/service.js';
import { placeOrderFromQuotation, placeDirectOrder, orderForEvent } from '../../orders/service.js';
import { notifyNewOrder } from '../../notifications/service.js';

/** Subtotal / VAT / total / deposit (rands) for direct-order line items — cents maths from core/money.js. */
export function orderTotals(items) {
  const subtotalCents = toCents(items.reduce((s, i) => s + Number(i.lineTotal), 0));
  const { vatCents, totalCents } = calcTotals([subtotalCents]);
  return {
    subtotal: fromCents(subtotalCents),
    vat:      fromCents(vatCents),
    total:    fromCents(totalCents),
    deposit:  depositForTotal(fromCents(totalCents)),
  };
}

const ORDER_CONTEXT_RESET = {
  orderHistory: null, orderFollowups: 0, offerQuotationId: null, pendingQuotationId: null, pendingOrderItems: null,
};

const backToMenu = (c) => {
  c.setState('main_menu', ORDER_CONTEXT_RESET);
  return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name });
};

const isConfirm = (c) => CONFIRM_RE.test(c.body.trim());
const isDecline = (c) => DECLINE_RE.test(c.body.trim());

// ── Starting ─────────────────────────────────────────────────────────────────
/** text: the message that asked to order — kept as the request when it names items. */
export function startOrder(c, { text = null } = {}) {
  const detail = text && carriesDetail(text) ? text : null;
  return gateOrProceed(c, { purpose: 'order', pendingIntent: 'order', pendingText: detail },
    () => beginOrder(c, { text: detail }));
}

export async function beginOrder(c, { text = null } = {}) {
  if (text) return orderGathering(c, { text, fresh: true });
  const q = await offerableQuote(c.client.id);
  if (q) {
    c.setState('order_ask_method', { ...ORDER_CONTEXT_RESET, offerQuotationId: q.id });
    return c.R(TEMPLATES.ORDER_OFFER_QUOTE, {
      reference: q.reference,
      items: Array.isArray(q.line_items) ? q.line_items : [],
      total: Number(q.total),
      deposit: depositForTotal(q.total),
      account: isAccountClient(c.client),
    });
  }
  return askItems(c);
}

function askItems(c) {
  c.setState('order_gathering', { ...ORDER_CONTEXT_RESET, orderHistory: [], orderFollowups: 0 });
  return c.R(TEMPLATES.ORDER_ASK_ITEMS, { name: c.client.name, clientType: c.client.client_type });
}

/** order_ask_method: the "order from your quote?" offer (or the older 1/2 method question). */
export async function orderAskMethod(c) {
  const offerId = c.convo.context.offerQuotationId;
  if (offerId) {
    if (isConfirm(c)) return placeFromQuotation(c, offerId);
    if (isDecline(c)) return askItems(c);
    if (hasLetters(c.body) && carriesDetail(c.body)) return orderGathering(c, { text: c.body, fresh: true });
    c.setState('order_ask_method', { offerQuotationId: offerId });
    const { rows } = await query('SELECT * FROM quotations WHERE id = $1 AND client_id = $2', [offerId, c.client.id]);
    if (!rows.length) return askItems(c);
    return c.R(TEMPLATES.ORDER_OFFER_QUOTE, {
      reference: rows[0].reference, items: rows[0].line_items || [], total: Number(rows[0].total),
      deposit: depositForTotal(rows[0].total), account: isAccountClient(c.client),
    });
  }
  // Older conversations: 1 = I have a quotation reference, 2 = order catalogue items
  if (c.intent.type === 'menu' && c.intent.value === 1) {
    c.setState('order_ask_reference');
    return c.R(TEMPLATES.ORDER_ASK_REFERENCE);
  }
  if (c.intent.type === 'menu' && c.intent.value === 2) return askItems(c);
  return askItems(c);
}

// BRQ-Q ref typed → intercepted by the router; anything else → reprompt
export const orderAskReference = (c) => c.R(TEMPLATES.ORDER_ASK_REFERENCE);

// ── From a quotation ─────────────────────────────────────────────────────────
function quoteConfirmParams(q) {
  return {
    reference: q.reference,
    items: Array.isArray(q.line_items) ? q.line_items : [],
    subtotal: Number(q.subtotal),
    vat: Number(q.vat),
    total: Number(q.total),
    deposit: depositForTotal(q.total),
  };
}

/**
 * Status for ordering: an accepted quote past its validity without an order is
 * treated as expired — the client gets a refresh at today's prices (FIN-2).
 */
const orderableStatus = (q) => (q?.status === 'accepted' && q.past_validity && !q.order_reference ? 'expired' : quoteStatus(q));

/** Why a quote cannot be ordered from, in the client's terms. */
function notReadyReply(c, q) {
  const status = orderableStatus(q);
  if (status === 'expired' && !q.order_reference) {
    c.setState(c.state, { pending: { kind: 'refresh_quote', quotationId: q.id, reference: q.reference } });
  }
  return c.R(TEMPLATES.ORDER_QUOTE_NOT_READY, {
    status, reference: q.reference, orderReference: q.order_reference, expiredOn: fmtDate(q.expires_on),
  });
}

/** A quotation reference typed while ordering → show it for confirmation. */
export async function orderQuoteRefLookup(c, reference) {
  const quotation = await findQuote(c.client.id, { reference });
  if (!quotation) return c.R(TEMPLATES.ORDER_QUOTE_NOT_FOUND);
  if (!['sent', 'accepted'].includes(orderableStatus(quotation)) || quotation.order_reference) return notReadyReply(c, quotation);
  c.setState('order_confirm_quote', { pendingQuotationId: quotation.id });
  return c.R(TEMPLATES.ORDER_CONFIRM_QUOTE, quoteConfirmParams(quotation));
}

async function placeFromQuotation(c, quotationId) {
  let order;
  try {
    order = await placeOrderFromQuotation(c.client.id, quotationId, { conversationId: c.convo.id });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    c.setState('main_menu', ORDER_CONTEXT_RESET);
    const q = await findQuote(c.client.id, { reference: (await query('SELECT reference FROM quotations WHERE id = $1', [quotationId])).rows[0]?.reference });
    if (q) return notReadyReply(c, q);
    return c.R(TEMPLATES.ORDER_QUOTE_NOT_READY, {});
  }
  c.setState('main_menu', ORDER_CONTEXT_RESET);
  c.notify(notifyNewOrder, order, c.client);
  return c.R(TEMPLATES.ORDER_CREATED, { reference: order.reference, deposit: Number(order.deposit_amount), account: isAccountClient(c.client) });
}

export async function orderConfirmQuote(c) {
  const quotationId = c.convo.context.pendingQuotationId;
  if (!quotationId) return backToMenu(c);
  if (isConfirm(c)) return placeFromQuotation(c, quotationId);
  if (isDecline(c)) return backToMenu(c);
  // Re-show the confirmation
  const { rows } = await query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
  if (!rows.length) return backToMenu(c);
  return c.R(TEMPLATES.ORDER_CONFIRM_QUOTE, quoteConfirmParams(rows[0]));
}

// ── Direct catalog order ─────────────────────────────────────────────────────
export function orderGathering(c, { text = null, fresh = false } = {}) {
  return gather(c, {
    state: 'order_gathering',
    historyKey: 'orderHistory',
    followupsKey: 'orderFollowups',
    finalise: finaliseDirectOrder,
    text,
    fresh,
  });
}

/** Catalogue line item for a direct order (priced at today's catalogue price). */
export function catalogLine(product, { quantity, colour = '', sizes = null }) {
  const unitPrice = Number(product.price);
  return {
    productId:          product.id,
    name:               product.name,
    category:           product.category,
    colour:             colour || '',
    sizes:              Array.isArray(sizes) && sizes.length ? sizes : [{ size: 'TBC', qty: quantity }],
    quantity,
    unitPrice,
    brandingSurcharge:  0,
    effectiveUnitPrice: unitPrice,
    branding:           { type: 'none', position: '', detail: '' },
    lineTotal:          fromCents(Math.round(quantity * toCents(unitPrice))),
    priceConfirmed:     true,
  };
}

async function finaliseDirectOrder(c, consolidatedText) {
  const products     = await listProducts({ activeOnly: true });
  const parsed       = (await parseQuotationRequest(consolidatedText, { products })) || {};
  const productsById = new Map(products.map((p) => [p.id, p]));

  const unmatchedItems = Array.isArray(parsed.unmatchedText) ? [...parsed.unmatchedText] : [];
  const lineItems      = [];

  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    const product = productsById.get(item.productId);
    if (!product || !item.quantity || item.quantity <= 0) {
      unmatchedItems.push(item.description || 'unrecognised item');
      continue;
    }
    lineItems.push(catalogLine(product, { quantity: item.quantity, colour: item.colour, sizes: item.sizes }));
  }

  // Not (all) in the catalogue → a quote request for a consultant instead of a dead end
  const letters = (consolidatedText.match(/\p{L}/gu) || []).length;
  if (unmatchedItems.length > 0 || (!lineItems.length && letters >= 10)) {
    return finaliseQuotation(c, consolidatedText, { fromOrder: true });
  }
  if (!lineItems.length) {
    c.setState('order_gathering', { orderHistory: [], orderFollowups: 0 });
    return c.R(TEMPLATES.ORDER_NOTHING_IDENTIFIED);
  }

  c.setState('order_confirm_direct', { ...ORDER_CONTEXT_RESET, pendingOrderItems: lineItems });
  return c.R(TEMPLATES.ORDER_CONFIRM_DIRECT, { items: lineItems, ...orderTotals(lineItems), account: isAccountClient(c.client) });
}

export async function orderConfirmDirect(c) {
  const pendingItems = c.convo.context.pendingOrderItems || [];
  // A replay of the turn that already placed this order: confirm it again, place nothing (DAT-2).
  const earlier = await orderForEvent(c.turn.eventId);
  if (earlier) {
    c.setState('main_menu', ORDER_CONTEXT_RESET);
    c.notify(notifyNewOrder, earlier, c.client);
    return c.R(TEMPLATES.ORDER_CREATED, { reference: earlier.reference, deposit: Number(earlier.deposit_amount), account: isAccountClient(c.client) });
  }
  if (!pendingItems.length) return backToMenu(c);
  if (isConfirm(c)) {
    const order = await placeDirectOrder(c.client.id, pendingItems, { conversationId: c.convo.id, sourceEventId: c.turn.eventId });
    c.setState('main_menu', ORDER_CONTEXT_RESET);
    c.notify(notifyNewOrder, order, c.client);
    return c.R(TEMPLATES.ORDER_CREATED, { reference: order.reference, deposit: Number(order.deposit_amount), account: isAccountClient(c.client) });
  }
  if (isDecline(c)) return backToMenu(c);
  // Re-show the confirmation
  return c.R(TEMPLATES.ORDER_CONFIRM_DIRECT, { items: pendingItems, ...orderTotals(pendingItems), account: isAccountClient(c.client) });
}

// ── Tracking ─────────────────────────────────────────────────────────────────
/**
 * Fetch an order by reference — only ever the sender's own orders. References
 * are sequential (guessable), so an order is only disclosed when it belongs to
 * this client, or to another client row registered under the same phone number
 * (e.g. a dashboard-created client stored as 082… / +27 82…).
 */
export async function findOrder(reference, clientId, phoneNumber) {
  const { rows } = await query(
    `SELECT o.*, c.name AS client_name
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.reference = $1 AND o.client_id = $2`,
    [reference, clientId]
  );
  if (rows.length) return rows[0];

  // Fallback: same reference on a client row with the sender's phone number
  // (digits only, local 0… normalised to 27…). Never matches other people's orders.
  const senderDigits = phoneDigits(phoneNumber);
  if (!senderDigits) return null;
  const { rows: fallback } = await query(
    `SELECT o.*, c.name AS client_name
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.reference = $1
       AND regexp_replace(regexp_replace(c.whatsapp_number, '[^0-9]', '', 'g'), '^0', '27') = $2`,
    [reference, senderDigits]
  );
  return fallback[0] || null;
}

function replyOrderStatus(c, order) {
  return c.R(TEMPLATES.ORDER_TRACKING_RESULT, {
    reference: order.reference,
    stage: order.stage,
    label: orderStageText(order),
    trackingNumber: order.tracking_number,
    estimatedCompletion: fmtDate(order.estimated_completion_date) || null,
    amountDue: order.stage === 'completed' ? '' : amountDueText(order, { account: isAccountClient(c.client) }),
    onHold: Boolean(order.is_on_hold),
  });
}

/** "5" / "track": the client's open orders (one → its status at once). */
export async function startTracking(c) {
  const orders = await openOrders(c.client.id, c.phone);
  if (!orders.length) {
    c.setState('main_menu', { trackList: null });
    return c.R(TEMPLATES.ORDER_TRACKING_NONE);
  }
  if (orders.length === 1) {
    c.setState('main_menu', { trackList: null });
    return replyOrderStatus(c, orders[0]);
  }
  c.setState('order_tracking_ask', { trackList: orders.map((o) => o.reference) });
  return c.R(TEMPLATES.ORDER_TRACKING_LIST, { orders: orders.map(orderSummary) });
}

/** Order status for a typed reference. */
export async function trackOrder(c, reference) {
  const order = await findOrder(reference, c.client.id, c.phone);
  if (!order) return c.R(TEMPLATES.ORDER_NOT_FOUND);
  c.setState('main_menu', { trackList: null });
  return replyOrderStatus(c, order);
}

/** True when `text` picks an order from the tracking list (so "9" is order 9, not "consultant"). */
export function ownsTrackingNumber(c, text) {
  return c.state === 'order_tracking_ask'
    && /^\d+$/.test(text)
    && Number(text) >= 1
    && Number(text) <= (c.convo.context.trackList || []).length;
}

/** order_tracking_ask: a number from the list; anything else is handled as at the main menu. */
export async function orderTrackingAsk(c) {
  const list = c.convo.context.trackList || [];
  const n = Number(c.body.trim());
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return trackOrder(c, list[n - 1]);
  c.setState('main_menu', { trackList: null });
  const { mainMenu } = await import('./menu.js');
  return mainMenu(c);
}

