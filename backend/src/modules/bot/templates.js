// ─────────────────────────────────────────────────────────────────────────────
// Braq Connect™ — WhatsApp message templates (customer-facing text).
//
// Conventions:
//  - One main menu, numbered the same everywhere; "9" is always "talk to a
//    person" and "0" is always the menu.
//  - Status notifications (stage updates, receipts, proof, ticket resolved) are
//    sent outside a menu flow, so they carry no menu footer.
//  - Payment details are never sent on WhatsApp — the consultant arranges payment.
// ─────────────────────────────────────────────────────────────────────────────
import { ORDER_STAGES, CLIENT_STAGE_LABELS, nextStage as lifecycleNextStage } from '../lifecycle/machines.js';
import { DEPOSIT_PERCENT, TICKET_SLA_HOURS, QUOTE_SLA_HOURS } from '../../core/money.js';

export const STORE_ADDRESS = '754B Voortrekker Road, Dalview, Brakpan, Gauteng';
export const HOURS_SHORT = 'Mon–Fri 8:00–17:00, Sat 8:00–13:00';
/** WhatsApp rejects text bodies over 4096 characters; stay comfortably below. */
export const MAX_MESSAGE_CHARS = 3800;

// ── Helpers ───────────────────────────────────────────────────────────────────
export function firstName(name) {
  const first = String(name ?? '').trim().split(/\s+/)[0] || '';
  return first;
}

const money = (n) => `R ${Number(n ?? 0).toFixed(2)}`;

/** "19 Nov 2026" in South African time; '' for an empty / invalid date. */
export function fmtDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value).length === 10 ? `${value}T12:00:00+02:00` : value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });
}

/**
 * Keep a long list message under the WhatsApp limit: whole lines are kept until
 * the budget runs out, then `moreHint` is appended.
 */
export function fitMessage(head, lines, tail = '', { max = MAX_MESSAGE_CHARS, moreHint = (n) => `…and ${n} more.` } = {}) {
  let out = head;
  let i = 0;
  for (; i < lines.length; i++) {
    const next = `${lines[i]}\n`;
    if ((out + next + tail).length + 60 > max) break;
    out += next;
  }
  if (i < lines.length) out += `${moreHint(lines.length - i)}\n`;
  return out + tail;
}

const MENU_OPTIONS =
  `1️⃣  School uniforms (parents)\n` +
  `2️⃣  Bulk orders (schools/companies)\n` +
  `3️⃣  Get a quote\n` +
  `4️⃣  Place an order\n` +
  `5️⃣  Track my order\n` +
  `6️⃣  Report a problem\n` +
  `7️⃣  Store hours & location\n` +
  `9️⃣  Talk to a person\n\n` +
  `Reply *0* any time for this menu.`;

const FOOTER = `*9* Talk to a person · *0* Main menu`;

/** Example request per kind of client (parents order a few items; companies order in bulk). */
function exampleRequest(clientType) {
  if (clientType === 'retail') return `"2 Dalview jerseys size 10 and 3 grey shirts size 12"`;
  if (clientType === 'school') return `"120 maroon school jerseys with the crest, sizes 6–16"`;
  return `"50 navy golf shirts, logo embroidered on the chest, S×10 M×20 L×20"`;
}

function lineItemsBlock(items = [], { withTotals = true } = {}) {
  return (Array.isArray(items) ? items : []).map((i) => {
    const colour = i.colour ? ` — ${i.colour}` : '';
    const sizes = Array.isArray(i.sizes) && i.sizes.filter((s) => s.size !== 'TBC').length
      ? '\n   ' + i.sizes.map((s) => `${s.size}×${s.qty}`).join('  ')
      : '';
    const qty = Number(i.quantity ?? 0);
    const total = withTotals ? `  — ${money(i.lineTotal ?? (Number(i.unitPrice ?? i.price ?? 0) * qty))}` : '';
    return `• ${i.name ?? i.description ?? 'Item'}${colour}  ×${qty}${total}${sizes}`;
  }).join('\n');
}

export const TEMPLATES = {

  // ── WELCOME / MENUS ────────────────────────────────────────────────────────

  MAIN_MENU: ({ name, welcomeBack = false } = {}) => {
    const first = firstName(name);
    const head = welcomeBack && first
      ? `Welcome back, *${first}* 👋\n\nHow can we help today? Reply with a number:\n\n`
      : first
        ? `Hi *${first}* 👋 Welcome to *Braq Uni* — your uniform stylist.\n\nHow can we help? Reply with a number:\n\n`
        : `Welcome to *Braq Uni* — your uniform stylist. 👋\n\nHow can we help? Reply with a number:\n\n`;
    return head + MENU_OPTIONS;
  },

  RETAIL_MENU: () =>
    `👕 *Braq Uni Shop — school uniforms*\n\n` +
    `Type your school's name (e.g. _Dalview_) to see its uniforms and prices, or reply:\n\n` +
    `1️⃣  Price list\n` +
    `2️⃣  Choose my school from a list\n` +
    `3️⃣  Store hours\n` +
    `4️⃣  Is my order ready?\n` +
    `5️⃣  Lay-by\n` +
    `6️⃣  Sizes & availability\n\n` +
    FOOTER,

  CORPORATE_MENU: () =>
    `🏢 *Bulk orders — schools & companies*\n\n` +
    `Thanks for your bulk order enquiry. Reply with a number:\n\n` +
    `1️⃣  Repeat a previous order\n` +
    `2️⃣  New uniforms / get a quote\n` +
    `3️⃣  Production update on my order\n` +
    `4️⃣  Delivery or collection update\n` +
    `5️⃣  Account or invoice query\n\n` +
    FOOTER,

  UNKNOWN_INTENT: () =>
    `Sorry, I didn't quite catch that. 🤔\n\n` +
    `Reply with a number below, or type your question in a few words:\n\n` +
    MENU_OPTIONS,

  /** An AI answer to a free-text question. */
  FREE_TEXT_ANSWER: ({ text }) =>
    `${String(text ?? '').trim()}\n\n` +
    `Anything else? Just ask, or reply *0* for the menu · *9* to talk to a person.`,

  /** The AI could not answer: the question is handed to a consultant. */
  FAQ_ESCALATED: () =>
    `Good question — that's one for our team. 🙋 I've passed it to a consultant, who will reply here ` +
    `(${HOURS_SHORT}).\n\nYou don't need to send anything else. Reply *0* to cancel and go back to the menu.`,

  THANKS_REPLY: ({ name } = {}) =>
    `You're welcome${firstName(name) ? `, *${firstName(name)}*` : ''}! 😊 Reply *0* any time for the menu.`,

  // ── BUSINESS HOURS / BUSY MODE ─────────────────────────────────────────────

  OUTSIDE_HOURS_ACK: () =>
    `Thanks for reaching out to Braq Uni! 🌙\n\n` +
    `It's currently outside our trading hours (${HOURS_SHORT}), so a person will only reply once we open. ` +
    `I can still help with most things right now.`,

  HIGH_VOLUME_NOTICE: () =>
    `Thank you for contacting Braq Uni.\n\n` +
    `We are currently experiencing a high volume of enquiries and production orders.\n\n` +
    `Response times may be slightly delayed. A consultant will assist you as soon as possible.\n\n` +
    `In the meantime, here's how we can help:`,

  // ── RETAIL ─────────────────────────────────────────────────────────────────

  RETAIL_PRODUCT_LIST: ({ products }) => {
    if (!products || !products.length) {
      return `Our product catalog is currently being updated. Reply *9* and a consultant will send you our prices.\n\nReply *0* to return to the main menu.`;
    }
    const CATEGORY_ORDER = ['knitwear', 'medical_wear', 'outdoor_wear', 'corporate_wear', 'safety_wear'];
    const formatCat = (key) =>
      key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const byCategory = {};
    for (const p of products) {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    }
    const orderedKeys = [
      ...CATEGORY_ORDER.filter((k) => byCategory[k]),
      ...Object.keys(byCategory).filter((k) => !CATEGORY_ORDER.includes(k) && k !== 'school_wear'),
    ];
    const lines = [];
    for (const key of orderedKeys) {
      lines.push(`*${formatCat(key)}*`);
      for (const item of byCategory[key]) {
        lines.push(`• ${item.name} — R ${Number(item.price).toFixed(2)}` +
          (Array.isArray(item.sizes) && item.sizes.length ? `\n  Sizes: ${item.sizes.join(', ')}` : ''));
      }
      lines.push('');
    }
    return fitMessage(
      `🛍️ *Braq Uni — Product Pricing*\n\n`,
      lines,
      `To order, type *order* (e.g. _order 3 polo shirts size L_).\n` +
      `Reply *back* for the shop menu · ${FOOTER}`,
      { moreHint: (n) => `…and ${n} more items — type an item name to ask about it.` },
    );
  },

  RETAIL_SCHOOL_SELECT: ({ schools }) =>
    fitMessage(
      `🏫 *School Uniform Information*\n\nReply with the number, or type your school's name:\n\n`,
      (schools || []).map((s, i) => `${i + 1}. ${s}`),
      `\nReply *back* for the shop menu · *0* for the main menu.`,
      { moreHint: (n) => `…and ${n} more — type your school's name.` },
    ),

  RETAIL_SCHOOL_UNIFORMS: ({ schoolName, uniforms }) => {
    const lines = (uniforms || []).map((u) =>
      `• *${u.name}* — R ${Number(u.price).toFixed(2)}` +
      (Array.isArray(u.sizes) && u.sizes.length ? `\n  Sizes: ${u.sizes.join(', ')}` : '') +
      (u.description ? `\n  ${u.description}` : ''));
    return fitMessage(
      `🏫 *${schoolName} — Available Uniforms*\n\n`,
      lines,
      `\nTo order, type *order* (e.g. _order 2 jerseys size 10_).\n` +
      `Reply *back* for the school list · ${FOOTER}`,
    );
  },

  RETAIL_SCHOOL_NO_CATALOG: ({ schoolName }) =>
    `🏫 *${schoolName}*\n\n` +
    `We supply uniforms for ${schoolName}. Reply *9* and a consultant will send you the full price list, ` +
    `or type *order* and tell us what you need.\n\n` +
    `Reply *back* to view another school.`,

  RETAIL_SCHOOL_NOT_FOUND: () =>
    `Sorry, we don't have that school in our catalog yet.\n\n` +
    `Reply *9* to talk to a consultant who can assist you, or *back* to try another school.`,

  RETAIL_SIZE_ASK: () =>
    `👕 *Size Availability*\n\n` +
    `Ask me about size availability for any of our products — just type your question.\n\n` +
    `_Example: "Do you have polo shirts in size XL?"_\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_SIZE_ANSWER: ({ text }) =>
    `${String(text ?? '').trim()}\n\n` +
    `Feel free to ask about another product, or reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_SIZE_UNKNOWN: () =>
    `I couldn't find size information for that product in our catalog. 😊\n\n` +
    `Type *consultant* to talk to a person, or try a different product.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_HOURS: () =>
    `🕐 *Braq Uni — Trading Hours*\n\n` +
    `Mon – Fri: *8:00 AM – 5:00 PM*\n` +
    `Saturday:  *8:00 AM – 1:00 PM*\n` +
    `Sunday & Public Holidays: *Closed*\n\n` +
    `📍 ${STORE_ADDRESS}\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_LAYBY: () =>
    `We offer lay-by on selected items.\n\n` +
    `A *30% deposit* is required to secure your items. The balance is due before collection.\n\n` +
    `To start a lay-by, reply *9* to talk to a consultant.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_COLLECTION_ASK: () =>
    `Please share your *order reference number* and we will check the status for you right away.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_COLLECTION_READY: ({ reference }) =>
    `✅ *Good news!*\n\n` +
    `Your order *${reference}* is ready for collection at our store.\n\n` +
    `📍 ${STORE_ADDRESS}\n\n` +
    `Please bring your order reference number when collecting.`,

  RETAIL_COLLECTION_NOT_READY: ({ reference, stage }) =>
    `Your order *${reference}* is currently in progress.\n\n` +
    `Current stage: *${stageLabel(stage)}*\n\n` +
    `We will notify you as soon as it is ready for collection.`,

  // ── CORPORATE / BULK ───────────────────────────────────────────────────────

  CORPORATE_REPEAT_ORDER_ASK: () =>
    `Please share the *order reference number* of the previous order you'd like to repeat.`,

  /** The previous order's items, ready to confirm (same answers as ORDER_CONFIRM_DIRECT). */
  CORPORATE_REPEAT_OFFER: ({ reference, ...summary }) =>
    `🔁 *Repeat of order ${reference}* (today's prices)\n\n` +
    TEMPLATES.ORDER_CONFIRM_DIRECT(summary).replace(/^🛒 \*Your Order Summary\*\n\n/, ''),

  CORPORATE_NO_PREVIOUS_ORDER: () =>
    `I couldn't find a previous order on your account to repeat. 🤔\n\n` +
    `Tell me what you'd like to order and I'll put it together for you.`,

  CORPORATE_MANUFACTURING_ASK: () =>
    `Please share your *order reference number* and we will check the manufacturing status for you.`,

  CORPORATE_DELIVERY_ASK: () =>
    `Please share your *order reference number* and we will check the delivery schedule for you.`,

  CORPORATE_DELIVERY_STATUS: ({ reference, stage, trackingNumber }) =>
    `Your order *${reference}* is currently at: *${stageLabel(stage)}*\n\n` +
    (trackingNumber ? `*Tracking number: ${trackingNumber}*\n\n` : ``) +
    `We will notify you of any further updates.`,

  CORPORATE_ACCOUNT_QUERY_ASK: () =>
    `What is your account query about?\n\n` +
    `_e.g. invoice, payment, statement or anything else — just describe it and we'll follow up._\n\n` +
    `Reply *back* or *0* for the main menu.`,

  CORPORATE_ACCOUNT_QUERY_LOGGED: ({ ticketNo } = {}) =>
    `Thank you. Your account query has been logged${ticketNo ? ` as ticket *#${ticketNo}*` : ''} 🎫 ` +
    `and a consultant will reply here within *${TICKET_SLA_HOURS} business hours* (${HOURS_SHORT}).`,

  // ── QUOTATION FLOW ─────────────────────────────────────────────────────────

  QUOTATION_ASK_DESCRIPTION: ({ name, clientType, thanks = false } = {}) => {
    const first = firstName(name);
    const greeting = thanks
      ? `Thanks${first ? `, *${first}*` : ''}! ✅`
      : `Hi${first ? ` *${first}*` : ''}! 😊`;
    return (
      `${greeting}\n\n` +
      `Please describe what you need a quotation for — items, quantities, colours, sizes and any logo or branding. ` +
      `Write it however you like, for example:\n\n` +
      `_${exampleRequest(clientType)}_\n\n` +
      `I'll check for anything missing before we prepare your quote.`
    );
  },

  QUOTATION_DRAFT_ACK: ({ reference, unmatched = [], fromOrder = false }) => {
    const unmatchedBlock = unmatched.length > 0
      ? `Some items need to be checked and priced by our team:\n` +
        unmatched.map((t) => `• ${t}`).join('\n') + `\n\n`
      : '';
    return (
      `📋 *Quotation received — Ref: ${reference}*\n\n` +
      (fromOrder
        ? `Some of what you asked for isn't in our standard catalogue, so I've turned your order into a quote request.\n\n`
        : '') +
      unmatchedBlock +
      `A consultant will price it and send your quote here. We aim to do this within ` +
      `*${QUOTE_SLA_HOURS} business hours* (${HOURS_SHORT}) — you don't need to send anything else.`
    );
  },

  QUOTATION_AUTO_APPROVED: ({ reference }) =>
    `🤖✅ *Instant Quotation Generated — Ref: ${reference}*\n\n` +
    `All the items you requested are in our catalog, so we've prepared your quotation automatically!\n\n` +
    `📄 Your PDF quotation has been sent to this WhatsApp.\n\n` +
    `Reply *accept* to go ahead, *changes* to request edits, or *9* to talk to us.`,

  OVERDUE_QUOTE_REMINDER: ({ name, reference }) =>
    `Hi *${firstName(name) || 'there'}*! 😊\n\n` +
    `Just a quick update — your quotation *(Ref: ${reference})* is taking a little longer than usual. ` +
    `Your consultant is finalising it and will send it here as soon as it's ready.`,

  QUOTE_ACCEPTED: ({ reference }) =>
    `✅ *Quotation Accepted — Ref: ${reference}*\n\n` +
    `Thanks! Your consultant will confirm your order and send the deposit details shortly.`,

  QUOTE_EXPIRED: ({ reference, expiredOn }) =>
    `⌛ Quote *${reference}* expired${expiredOn ? ` on ${expiredOn}` : ''}.\n\n` +
    `Reply *1* and we'll refresh it at today's prices.`,

  QUOTE_REFRESH_REQUESTED: ({ reference }) =>
    `👍 Done — I've asked your consultant to refresh quote *${reference}* at today's prices. ` +
    `They'll send the updated quote here.`,

  NO_PENDING_QUOTE: () =>
    `Hmm, I couldn't find an open quotation to accept on your account. 🤔\n\n` +
    `If you have a reference, send *accept* followed by it (e.g. _accept BRQ-Q-00012_).\n\n` +
    `Reply *3* to request a new quote | *9* to talk to a person.`,

  QUOTE_STATUS: ({ reference, status, total, validUntil, expiredOn, orderReference, resent = false }) => {
    // A draft's total is unreviewed (it may hold AI price suggestions): never shown to the client (FIN-3).
    const showTotal = status !== 'draft' && total != null && Number(total) > 0;
    const head = `📋 *Quote ${reference}*${showTotal ? ` — ${money(total)} incl. VAT` : ''}\n\n`;
    switch (status) {
      case 'draft':
        return head + `Our team is still pricing this quote — your consultant will send it here as soon as it's ready.`;
      case 'sent':
        return head +
          (resent ? `I've sent the PDF again (see above). ` : '') +
          (validUntil ? `It's valid until *${validUntil}*.\n\n` : '\n\n') +
          `Reply *accept* to go ahead, *changes* to request edits, or *9* to talk to us.`;
      case 'accepted':
        return head + (orderReference
          ? `You accepted this quote and it's now order *${orderReference}*. Type *track* to see how it's going.`
          : `You accepted this quote — your consultant will confirm your order and send the deposit details shortly.`);
      case 'expired':
        return head + `This quote expired${expiredOn ? ` on ${expiredOn}` : ''}. Reply *1* and we'll refresh it at today's prices.`;
      case 'rejected':
        return head + `This quote was declined. Reply *3* for a new quote or *9* to talk to a person.`;
      default:
        return head + `Reply *9* if you have any questions about it.`;
    }
  },

  NO_QUOTES: () =>
    `I couldn't find any quotes on your account yet. Reply *3* to request one, or *9* to talk to a person.`,

  QUOTE_CHANGES_ASK: ({ reference }) =>
    `✏️ What would you like to change on quote *${reference}*? Describe it in one message ` +
    `(e.g. _make it 40 shirts and add embroidery on the back_).`,

  QUOTE_CHANGES_LOGGED: ({ reference }) =>
    `👍 Thanks — I've passed your changes for quote *${reference}* to your consultant. ` +
    `They'll send an updated quote here (${HOURS_SHORT}).`,

  // ── MAKE ORDER FLOW ────────────────────────────────────────────────────────

  ORDER_ASK_METHOD: () =>
    `🛒 *Make an Order*\n\n` +
    `How would you like to place your order?\n\n` +
    `1️⃣  I have a quotation reference (BRQ-Q-...)\n` +
    `2️⃣  Order catalog items directly\n\n` +
    `Reply *back* or *0* for the main menu.`,

  ORDER_OFFER_QUOTE: ({ reference, items = [], total, deposit, account = false }) =>
    `🛒 *Place an order*\n\n` +
    `Would you like to order from your quote *${reference}*?\n\n` +
    (items.length ? lineItemsBlock(items) + `\n\n` : '') +
    `*Total: ${money(total)}* (incl. VAT)\n` +
    (account ? '' : `💳 Deposit to start production (${DEPOSIT_PERCENT}%): ${money(deposit)}\n`) +
    `\n1️⃣  Yes, place this order\n` +
    `2️⃣  Something else`,

  ORDER_ASK_REFERENCE: () =>
    `Please share your *quotation reference number* (e.g. *BRQ-Q-20250101-0001*).\n\n` +
    `You can find it in the PDF we sent to this WhatsApp.\n\n` +
    `Reply *back* to go back.`,

  ORDER_QUOTE_NOT_FOUND: () =>
    `We couldn't find a quotation with that reference on your account. 🔍\n\n` +
    `Please double-check the reference and try again, or reply *9* to talk to a consultant.`,

  ORDER_QUOTE_NOT_READY: ({ status, reference, orderReference, expiredOn } = {}) => {
    const ref = reference ? `Quote *${reference}*` : 'This quotation';
    if (status === 'draft') {
      return `${ref} is still being reviewed by our team. 🕐\n\n` +
        `We'll send you the PDF here as soon as it's ready — you don't need to do anything.`;
    }
    if (status === 'expired') {
      return `${ref} is no longer available — it expired${expiredOn ? ` on ${expiredOn}` : ''}.\n\n` +
        `Reply *1* and we'll refresh it at today's prices.`;
    }
    if (orderReference) {
      return `${ref} is no longer available to order — it has already been converted to order *${orderReference}*.\n\n` +
        `Type *track* to see how it's going.`;
    }
    return `${ref} has already been converted to an order or is no longer available.\n\n` +
      `Type *track* to see your orders, or reply *3* for a new quote.`;
  },

  ORDER_CONFIRM_QUOTE: ({ reference, items = [], subtotal, vat, total, deposit }) =>
    `📋 *Quotation: ${reference}*\n\n` +
    lineItemsBlock(items) + `\n\n` +
    `Subtotal:  ${money(subtotal)}\n` +
    `VAT (15%): ${money(vat)}\n` +
    `*Total:    ${money(total)}*\n\n` +
    `💳 *Deposit required (${DEPOSIT_PERCENT}%): ${money(deposit)}*\n\n` +
    `Ready to place this order?\n` +
    `1️⃣  Yes, confirm order\n` +
    `2️⃣  No, cancel`,

  ORDER_ASK_ITEMS: ({ name, clientType } = {}) =>
    `Great! What would you like to order${firstName(name) ? `, *${firstName(name)}*` : ''}? 😊\n\n` +
    `Describe the items, colours and sizes you need, for example:\n\n` +
    `_${exampleRequest(clientType)}_\n\n` +
    `If something isn't in our catalogue, I'll turn it into a quote for you.`,

  ORDER_NOTHING_IDENTIFIED: () =>
    `I couldn't pick out any items from that. 😊\n\n` +
    `Please describe what you'd like to order — item types, quantities, colours and sizes.`,

  ORDER_CONFIRM_DIRECT: ({ items = [], subtotal, vat, total, deposit, account = false }) =>
    `🛒 *Your Order Summary*\n\n` +
    lineItemsBlock(items) + `\n\n` +
    `Subtotal:  ${money(subtotal)}\n` +
    `VAT (15%): ${money(vat)}\n` +
    `*Total:    ${money(total)}*\n\n` +
    (account ? '' : `💳 *Deposit required (${DEPOSIT_PERCENT}%): ${money(deposit)}*\n\n`) +
    `Ready to place this order?\n` +
    `1️⃣  Yes, place order\n` +
    `2️⃣  No, cancel`,

  ORDER_CREATED: ({ reference, deposit, account = false }) =>
    `✅ *Order Placed — Ref: ${reference}*\n\n` +
    `Your order has been received! 🎉\n\n` +
    (account
      ? `Your consultant will confirm the details and schedule production.\n\n`
      : `A consultant will contact you shortly to arrange your *${DEPOSIT_PERCENT}% deposit of ${money(deposit)}* — production starts once it's in.\n\n`) +
    `Track your order at any time by typing *track* or sending your reference: *${reference}*`,

  // ── ORDER TRACKING ─────────────────────────────────────────────────────────

  ORDER_TRACKING_ASK: () =>
    `Please share your *order reference number* (e.g. BRQ-O-00001) and we'll give you a live update.\n\n` +
    `Reply *back* or *0* for the main menu.`,

  ORDER_TRACKING_NONE: () =>
    `You don't have any open orders with us right now. 📦\n\n` +
    `If you have an order reference (BRQ-O-…), send it here. Reply *4* to place an order or *0* for the menu.`,

  ORDER_TRACKING_LIST: ({ orders = [] } = {}) =>
    fitMessage(
      `📦 *Your open orders*\n\n`,
      orders.map((o, i) => `${i + 1}. *${o.reference}* — ${o.label}${o.due ? ` · ${o.due}` : ''}`),
      `\nReply with the number (or the reference) for details · *0* Main menu`,
    ),

  ORDER_TRACKING_RESULT: ({ reference, stage, label, trackingNumber, estimatedCompletion, amountDue, onHold = false }) =>
    `📦 *Order Status — ${reference}*\n\n` +
    `Current stage: *${label || stageLabel(stage)}*\n\n` +
    (onHold ? `⏸️ This order is temporarily on hold — your consultant will be in touch.\n\n` : '') +
    (estimatedCompletion ? `Estimated completion: *${estimatedCompletion}*\n\n` : ``) +
    (trackingNumber ? `Tracking number: *${trackingNumber}*\n\n` : ``) +
    (amountDue ? `${amountDue}\n\n` : '') +
    `Reply *0* for the main menu or *9* to talk to a consultant.`,

  // ── REGISTRATION ──────────────────────────────────────────────────────────

  /**
   * One message asking for everything still missing.
   * missing: subset of ['name', 'org', 'fulfilment', 'address'];
   * orgKind: 'school' (parents) | 'company' (bulk) | 'either'.
   */
  REGISTRATION_ASK_DETAILS: ({ missing = [], purpose = null, orgKind = 'either', retry = false } = {}) => {
    const LABELS = {
      name:       `your *full name*`,
      org:        orgKind === 'school' ? `the *school* the uniforms are for (or _N/A_)`
        : orgKind === 'company' ? `your *company or school* name`
        : `your *school or company*`,
      fulfilment: `*collect* in store, or your *delivery address*`,
      address:    `your *delivery address*`,
    };
    const head = retry
      ? `Thanks! I still need`
      : purpose === 'quote' ? `To prepare your quote, please reply with`
      : purpose === 'order' ? `To place your order, please reply with`
      : `Before we continue, please reply with`;
    const items = missing.map((m) => LABELS[m]).filter(Boolean);
    if (items.length <= 1) return `${head} ${items[0] ?? LABELS.name}. 📝`;
    const example = missing.map((m) => ({
      name: 'Thabo Mokoena',
      org: orgKind === 'company' ? 'Acme Security' : 'Dalview Primary',
      fulfilment: 'collect',
      address: '12 Main Rd, Brakpan',
    }[m])).join(', ');
    return `${head}:\n\n` + items.map((t, i) => `${i + 1}) ${t}`).join('\n') +
      `\n\n_e.g. "${example}"_`;
  },

  // ── TICKETS / COMPLAINTS ──────────────────────────────────────────────────

  TICKET_ASK_CATEGORY: () =>
    `We're sorry to hear there's an issue. Please select the category that best fits ` +
    `(or just describe what happened):\n\n` +
    `1️⃣  Wrong item received\n` +
    `2️⃣  Defective item\n` +
    `3️⃣  Missing item\n` +
    `4️⃣  Other\n\n` +
    `Reply *back* or *0* for the main menu.`,

  TICKET_ASK_DESCRIPTION: () =>
    `Please describe what happened — which item and what's wrong — and include your order reference if you have one. ` +
    `You can also send photos. 📷`,

  TICKET_LOGGED: ({ ticketNo } = {}) =>
    `Thank you for letting us know. 🎫 Your issue has been logged${ticketNo ? ` as ticket *#${ticketNo}*` : ''}.\n\n` +
    `A consultant will reply here within *${TICKET_SLA_HOURS} business hours* (${HOURS_SHORT}). ` +
    `If you have photos of the problem, send them now and we'll add them to the ticket.`,

  TICKET_PHOTO_BEFORE_LOG: () =>
    `📎 Thanks — I'll add that to your report. Please also describe what's wrong in a message (which item and what happened).`,

  TICKET_PHOTO_ADDED: ({ ticketNo } = {}) =>
    `📎 Thanks — added to your ticket${ticketNo ? ` *#${ticketNo}*` : ''}. Send more photos if you like.`,

  TICKET_RESOLVED: ({ reference, note } = {}) =>
    `✅ *Your issue has been resolved*${reference ? ` — Order ${reference}` : ''}\n\n` +
    (note ? `${note}\n\n` : '') +
    `Thank you for your patience. If anything is still not right, just reply here.`,

  TICKET_NEEDS_MORE_DETAIL: () =>
    `That description is a bit brief. Please include:\n\n` +
    `• *Which item* has the issue (e.g. blue polo shirt, size L)\n` +
    `• *What exactly is wrong* (e.g. wrong size, seam split, missing from parcel)\n\n` +
    `_Example: "5 of the 20 blue polo shirts have split seams."_`,

  // ── PAYMENTS ────────────────────────────────────────────────────────────────

  DEPOSIT_REQUIRED: ({ amount, percentage }) =>
    `💰 *Payment required*\n\n` +
    `A *${percentage}% deposit* of *R ${amount}* is required before production can begin. ` +
    `Your consultant will send you the payment details.`,

  DEPOSIT_RECEIVED: ({ amount, balance }) =>
    `✅ *Deposit received — thank you!*\n\nAmount: R ${amount}\n` +
    (balance && balance !== '0.00'
      ? `Remaining balance: R ${balance} (due before completion).`
      : `Your order is fully paid.`),

  BALANCE_OUTSTANDING: ({ amount }) =>
    `Reminder: a balance of *R ${amount}* remains outstanding on your order. ` +
    `Please settle this before collection/delivery.`,

  PAID_IN_FULL: () =>
    `✅ *Payment complete — thank you!* Your order is now fully paid.`,

  // ── ORDER STAGE NOTIFICATIONS (no menu footers) ───────────────────────────

  STAGE_DEPOSIT_PENDING: ({ reference, items = [], deposit, account = false }) => {
    const lines = formatItemsSummary(items);
    return (
      `✅ *Order Received — Ref: ${reference}*\n\n` +
      (lines ? `Your order:\n${lines}\n\n` : '') +
      (account
        ? `Your consultant will confirm the details and schedule production.`
        : `💳 *${DEPOSIT_PERCENT}% Deposit required: ${money(deposit)}*\n\n` +
          `A consultant will contact you shortly to arrange payment — production starts once the deposit is in.`)
    );
  },

  STAGE_IN_PRODUCTION: ({ reference, items = [], estimatedCompletion }) => {
    const lines = formatItemsSummary(items);
    return (
      `🏭 *In Production — Ref: ${reference}*\n\n` +
      `Your garments are now in production! 🎉\n\n` +
      (lines ? `In production:\n${lines}\n\n` : '') +
      (estimatedCompletion ? `📅 *Estimated completion: ${estimatedCompletion}*\n\n` : '') +
      `We'll let you know as soon as your order is ready.`
    );
  },

  STAGE_READY_COLLECTION: ({ reference, items = [], balance }) => {
    const lines = formatItemsSummary(items);
    const due = Number(balance ?? 0);
    return (
      `✅ *Ready for Collection — Ref: ${reference}*\n\n` +
      `Your order has passed quality inspection and is ready for collection! 🎉\n\n` +
      (lines ? lines + '\n\n' : '') +
      `📍 *${STORE_ADDRESS}*\n` +
      `🕐 ${HOURS_SHORT} (closed Sundays & public holidays)\n\n` +
      (due > 0 ? `💳 *Balance due: ${money(due)}* — payable before collection.\n\n` : '') +
      `Please bring your order reference when collecting.`
    );
  },

  STAGE_READY_DELIVERY: ({ reference, items = [], trackingNumber, balance }) => {
    const lines = formatItemsSummary(items);
    const due = Number(balance ?? 0);
    return (
      `🚚 *Order Dispatched — Ref: ${reference}*\n\n` +
      `Your order is on its way! 🎉\n\n` +
      (lines ? lines + '\n\n' : '') +
      (trackingNumber ? `📦 *Tracking number: ${trackingNumber}*\n\n` : '') +
      (due > 0 ? `💳 *Balance due: ${money(due)}*\n\n` : '') +
      `Reply here if you need anything.`
    );
  },

  STAGE_COMPLETED: ({ reference }) =>
    `✅ *Order Complete — Ref: ${reference}*\n\n` +
    `Thank you for choosing Braq Uni! We hope you love your new uniforms. 🙏`,

  // ── MISC NOTIFICATIONS ─────────────────────────────────────────────────────

  SUPPLIER_DELAY: ({ reference }) =>
    `⚠️ *Order update — ${reference}*\n\n` +
    `We are currently awaiting fabric allocation from our supplier.\n\n` +
    `Your order remains active and production will continue immediately upon receipt of materials.\n\n` +
    `We appreciate your patience and understanding.`,

  CONSULTANT_ASSIGNED: ({ consultantName }) =>
    `👋 *${consultantName || 'A consultant'}* from Braq Uni is now helping you. Reply here any time.`,

  AWAITING_CONSULTANT: ({ withinHours = true } = {}) =>
    `👤 A consultant will reply here — ${HOURS_SHORT}.` +
    (withinHours ? '' : ` We're closed right now, so it will be once we open.`) +
    `\n\nYou don't need to send anything else. Reply *0* to cancel and go back to the menu.`,

  CONSULTANT_ACK: ({ withinHours = true } = {}) =>
    `Thanks — your message is with our team. 📩 A consultant will reply here (${HOURS_SHORT})` +
    (withinHours ? '.' : `; we're closed right now, so it will be once we open.`) +
    ` You don't need to send anything else.`,

  CONSULTANT_QUEUE: () =>
    `You're in the queue ⏳ — a consultant will reply here as soon as they're free (${HOURS_SHORT}).\n\n` +
    `Reply *0* to cancel the request.`,

  CONSULTANT_CANCELLED: () =>
    `OK — I've cancelled your request to talk to a person. 👍\n\n` +
    `How else can we help? Reply with a number:\n\n` + MENU_OPTIONS,

  GENERIC_ERROR: () =>
    `Sorry, something went wrong on our side. 😔\n\n` +
    `Please try again in a moment, or reply *9* to talk to a consultant.`,

  MEDIA_RECEIVED: () =>
    `Thanks, we've received your attachment. 📎\n\n` +
    `I can only read text messages, so I've passed it to our team — a consultant will look at it.\n\n` +
    `Reply *0* for the menu.`,

  ORDER_NOT_FOUND: () =>
    `We couldn't find an order with that reference number. ` +
    `Please double-check and try again, or reply *9* to talk to a consultant.`,

  BRANDING_INFO: () =>
    `We offer the following branding services:\n\n` +
    `🧵 *Embroidery* — logos, names, and crests\n` +
    `🖨️ *Sublimation printing* — full-colour designs\n` +
    `🖋️ *Screen printing* — large quantity runs\n` +
    `🏷️ *Heat transfer* — name badges and numbers\n\n` +
    `Reply *3* to request a quote or *9* to talk to a consultant.`,

  STORE_INFO: () =>
    `📍 *Braq Uni — Store Information*\n\n` +
    `*754B Voortrekker Road*\n` +
    `Dalview, Brakpan, Gauteng\n\n` +
    `🕐 *Trading Hours*\n` +
    `Mon – Fri: 8:00 AM – 5:00 PM\n` +
    `Saturday:  8:00 AM – 1:00 PM\n` +
    `Sunday & Public Holidays: Closed\n\n` +
    `Reply *0* to return to the main menu.`,

  // ── DIGITAL PROOF APPROVAL ─────────────────────────────────────────────────

  PROOF_SENT: ({ reference, proofUrl, notes }) =>
    `🎨 *Design Proof Ready — Ref: ${reference}*\n\n` +
    (notes ? `${notes}\n\n` : '') +
    `Please review your design proof:\n${proofUrl}\n\n` +
    `Reply *approve* if you're happy, or *changes* and tell us what to change ` +
    `(e.g. _changes: make the logo bigger_).\n\n` +
    `We'll hold production until you confirm.`,

  PROOF_CONFIRM: ({ reference }) =>
    `Approve this design for order *${reference}*? Reply *approve* or *changes*.`,

  PROOF_APPROVED: ({ reference, depositPaid = false, account = false } = {}) =>
    `✅ *Proof Approved — Ref: ${reference}*\n\n` +
    (depositPaid || account
      ? `Thank you! Your design has been approved and we're moving into production. 🎉 We'll let you know when your order is ready.`
      : `Thank you! Your design has been approved — we'll start production as soon as your deposit is received.`),

  PROOF_REVISION_REQUESTED: ({ reference }) =>
    `✏️ *Revision Noted — Ref: ${reference}*\n\n` +
    `Thank you for your feedback. Our design team will make the requested changes and send you an updated proof here.`,

  PROOF_REVISION_ASK: ({ reference }) =>
    `Please describe the changes you'd like made to the design for order *${reference}*.\n\n` +
    `Reply *back* to cancel.`,
};

// ── Items summary formatter for stage notifications ───────────────────────────
function formatItemsSummary(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((i) => {
    const name   = i.name ?? i.description ?? 'Item';
    const colour = i.colour ? ` — ${i.colour}` : '';
    const qty    = i.quantity ?? 0;
    const activeSizes = Array.isArray(i.sizes)
      ? i.sizes.filter((s) => s.size !== 'TBC' && s.qty > 0)
      : [];
    const sizeStr = activeSizes.length
      ? '\n   ' + activeSizes.map((s) => `${s.size}×${s.qty}`).join('  ')
      : '';
    return `• ${name}${colour}  ×${qty}${sizeStr}`;
  }).join('\n');
}

// ── Stage label helper ────────────────────────────────────────────────────────
// Customer-facing names for the 4 current stages plus legacy stage keys that may
// still be stored on older orders (lifecycle/machines.js CLIENT_STAGE_LABELS).
// Raw snake_case keys are never shown to clients.
export function stageLabel(stage) {
  if (CLIENT_STAGE_LABELS[stage]) return CLIENT_STAGE_LABELS[stage];
  if (stage == null || stage === '') return 'Processing';
  // Unknown key — humanise it rather than leaking snake_case
  return String(stage)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── 4-stage order pipeline (defined in lifecycle/machines.js) ─────────────────
export const STAGE_ORDER = ORDER_STAGES;

export function nextStage(current) {
  return ORDER_STAGES.includes(current) ? lifecycleNextStage(current) : null;
}

// ── Map order stage → WhatsApp notification template key ──────────────────────
export function templateForStage(stage) {
  const map = {
    deposit_pending: 'STAGE_DEPOSIT_PENDING',
    in_production:   'STAGE_IN_PRODUCTION',
    ready:           'STAGE_READY_COLLECTION',
    completed:       'STAGE_COMPLETED',
  };
  return map[stage] || null;
}
