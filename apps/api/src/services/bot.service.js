import { query } from '../db/pool.js';
import { sendTextMessage } from './whatsapp.service.js';
import { TEMPLATES } from './bot.templates.js';
import { answerFaq, gatherQuotationInfo, parseQuotationRequest } from './ai.service.js';
import { listProducts, listSchoolNames, listProductsBySchool } from './catalog.service.js';
import { createFromFreeText, autoApproveQuotation, acceptQuotationByClient, getQuotationByReference } from './quotations.service.js';
import { createOrderFromBot } from './orders.service.js';
import { createTicket } from './tickets.service.js';
import { getOrCreateClientByWhatsapp, updateClientProfile } from './clients.service.js';
import { isWithinBusinessHours } from '../utils/businessHours.js';
import { logger } from '../utils/logger.js';
import {
  notifyNewQuotation,
  notifyNewTicket,
  notifyConsultantRequested,
  notifyQuotationAccepted,
  notifyNewOrder,
} from './notification.service.js';

// Fire-and-forget wrapper — notifications never block the bot response
function notifyAsync(fn, ...args) {
  fn(...args).catch((err) =>
    logger.warn('Notification failed', { fn: fn.name, error: err.message })
  );
}

// Canonical school list — always shown even before catalog is populated
const SCHOOLS = [
  'Laerskool Dalview',
  'Hoerskool Stoffberg',
  'Laerskool Brakpan Oos',
  'Tsakane Secondary',
  'Dalpark Primary',
  'Dalpark Secondary',
  'Anzac Primary',
  'Sonneveld Akademie',
  'Exed Privaat Skool',
  'Laerskool Die Arend',
  'Brakpan Educational Centre',
  'Brakpan Educational Primary',
];

// Parent state for "back" navigation
const PARENT_STATE = {
  main_menu:                  'main_menu',
  retail_menu:                'main_menu',
  retail_pricing:             'retail_menu',
  retail_size_ask:            'retail_menu',
  retail_layby:               'retail_menu',
  retail_hours:               'retail_menu',
  retail_collection_ask:      'retail_menu',
  retail_school_select:       'retail_menu',
  corporate_menu:             'main_menu',
  corporate_repeat_order_ask: 'corporate_menu',
  corporate_manufacturing_ask:'corporate_menu',
  corporate_delivery_ask:     'corporate_menu',
  corporate_account_query:    'corporate_menu',
  quotation_ask_description:  'main_menu',
  order_ask_method:           'main_menu',
  order_ask_reference:        'order_ask_method',
  order_gathering:            'order_ask_method',
  order_confirm_quote:        'main_menu',
  order_confirm_direct:       'main_menu',
  order_tracking_ask:         'main_menu',
  ticket_ask_category:        'main_menu',
  ticket_ask_description:     'ticket_ask_category',
};

const PARENT_TEMPLATE = {
  main_menu:          (T) => T.MAIN_MENU,
  retail_menu:        (T) => T.RETAIL_MENU,
  corporate_menu:     (T) => T.CORPORATE_MENU,
  ticket_ask_category:(T) => T.TICKET_ASK_CATEGORY,
};

// States where free text is data, not navigation intent — keywords disabled
const DATA_COLLECTION_STATES = new Set([
  'quotation_ask_description',
  'quotation_gathering',
  'order_gathering',
  'ticket_ask_description',
  'corporate_account_query',
  'registration_name',
  'registration_org_or_school',
  'registration_address',
  'retail_size_ask',
]);

// ── Settings helper ───────────────────────────────────────────────────────────
async function getSetting(key) {
  const { rows } = await query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

// ── Intent detection ──────────────────────────────────────────────────────────
function detectIntent(body) {
  const t = body.trim().toLowerCase();

  if (t === '0' || t === 'menu' || t === 'main menu') return { type: 'main_menu' };
  if (t === 'back' || t === 'go back')                return { type: 'back' };
  if (t === '9' || /^(speak to|talk to|connect me to|i need a) consultant/i.test(t))
    return { type: 'consultant' };

  if (/^[1-8]$/.test(t)) return { type: 'menu', value: parseInt(t) };

  // Order reference: BRQ-O-YYYYMMDD-XXXX or BRQ-Q-YYYYMMDD-XXXX
  if (/^brq-[oq]-\d{8}-\d{4}$/i.test(t)) return { type: 'order_ref', value: t.toUpperCase() };

  // Global keyword shortcuts
  if (/track|order status|where.*order/i.test(t))       return { type: 'keyword', value: 'track' };
  if (/\bquot/i.test(t))                               return { type: 'keyword', value: 'quote' };
  if (/hours?|open|trading/i.test(t))                   return { type: 'keyword', value: 'hours' };
  if (/lay.?by|layby/i.test(t))                         return { type: 'keyword', value: 'layby' };
  if (/brand|embroider|print|sublim/i.test(t))          return { type: 'keyword', value: 'branding' };
  if (/store info|where.*shop|where.*store|store location/i.test(t))
    return { type: 'keyword', value: 'store' };
  if (/wrong item|defective|faulty|damaged|broken|missing item|\bcomplaint\b/i.test(t))
    return { type: 'keyword', value: 'ticket' };
  if (/^accept$|^i accept$|^yes.*accept|^accept.*quotation/i.test(t))
    return { type: 'keyword', value: 'accept_quote' };
  if (/^(make|place|new)\s*(an?\s*)?order$/i.test(t))
    return { type: 'keyword', value: 'make_order' };

  return { type: 'freetext', value: body };
}

// ── Fetch order by reference (only the client's own orders) ──────────────────
async function findOrder(reference, clientId) {
  const { rows } = await query(
    `SELECT * FROM orders WHERE reference = $1 AND client_id = $2`,
    [reference, clientId]
  );
  return rows[0] || null;
}

// ── SLA reminder: notify client if a draft quotation is overdue ───────────────
async function sendOverdueQuotationReminder(client, phoneNumber) {
  const { rows } = await query(
    `SELECT * FROM quotations
     WHERE client_id = $1 AND status = 'draft'
       AND sla_remind_at <= NOW() AND reminder_sent_at IS NULL
     ORDER BY sla_remind_at ASC LIMIT 1`,
    [client.id]
  );
  if (!rows.length) return;

  const q = rows[0];
  await query(`UPDATE quotations SET reminder_sent_at = NOW() WHERE id = $1`, [q.id]);

  const firstName = client.name?.split(' ')[0] || 'there';
  const msg =
    `Hi *${firstName}*! 😊\n\n` +
    `Just a quick update — your consultant is finalising your quotation *(Ref: ${q.reference})* ` +
    `and will send it through shortly.\n\n` +
    `Reply *9* to speak to a consultant directly.`;

  await sendTextMessage(phoneNumber, msg);
  logger.info('Sent overdue quotation reminder', { clientId: client.id, quotationId: q.id });
}

// ── Conversation helpers ──────────────────────────────────────────────────────
async function getOrCreateConversation(clientId) {
  const { rows: existing } = await query(
    `SELECT * FROM conversations WHERE client_id = $1 AND is_open = true ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  if (existing.length) return { conversation: existing[0], isNew: false };

  const { rows: created } = await query(
    `INSERT INTO conversations (client_id, state) VALUES ($1, 'main_menu') RETURNING *`,
    [clientId]
  );
  return { conversation: created[0], isNew: true };
}

async function saveMessage(conversationId, clientId, metaMessageId, body, direction = 'inbound') {
  await query(
    `INSERT INTO messages (conversation_id, client_id, meta_message_id, direction, body, is_read_by_staff)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, clientId, metaMessageId, direction, body, direction === 'inbound']
  );
}

async function updateState(conversationId, state, context = {}) {
  await query(
    `UPDATE conversations
     SET state = $1, context = context || $2::jsonb, last_message_at = NOW()
     WHERE id = $3`,
    [state, JSON.stringify(context), conversationId]
  );
}

async function reply(to, conversationId, clientId, templateFn, params = {}) {
  const body = templateFn(params);
  const msgId = await sendTextMessage(to, body);
  await saveMessage(conversationId, clientId, msgId, body, 'outbound');
  return msgId;
}

// ── Registration gate ─────────────────────────────────────────────────────────
async function gateOrProceed(client, convo, pendingState, R, proceedFn) {
  if (client.profile_complete) return proceedFn();
  await updateState(convo.id, 'registration_name', { pendingIntent: pendingState });
  return R(TEMPLATES.REGISTRATION_ASK_NAME);
}

// ── Quotation multi-turn gathering ───────────────────────────────────────────
async function handleQuotationGathering(body, convo, client, R) {
  const history = [...(convo.context.quotationHistory || [])];
  history.push({ role: 'client', text: body });

  const followupsAsked = convo.context.quotationFollowups || 0;
  const MAX_FOLLOWUPS = 5;
  const products = await listProducts({});

  if (followupsAsked < MAX_FOLLOWUPS) {
    const result = await gatherQuotationInfo(history, { products });

    if (result.status === 'need_more_info' && result.question) {
      history.push({ role: 'bot', text: result.question });
      await updateState(convo.id, 'quotation_gathering', {
        quotationHistory: history,
        quotationFollowups: followupsAsked + 1,
      });
      return R(() => result.question);
    }

    const consolidated = result.consolidatedRequest
      || history.filter((h) => h.role === 'client').map((h) => h.text).join('\n');
    return finaliseQuotation(consolidated, convo, client, R);
  }

  const consolidated = history.filter((h) => h.role === 'client').map((h) => h.text).join('\n');
  return finaliseQuotation(consolidated, convo, client, R);
}

async function finaliseQuotation(consolidatedText, convo, client, R) {
  const { quotation, unmatchedText } = await createFromFreeText(client.id, consolidatedText);

  // Auto-approve instantly when every item matched the catalog — no consultant needed
  const allCatalogMatched = !unmatchedText || unmatchedText.length === 0;
  const hasItems = Array.isArray(quotation.line_items) && quotation.line_items.length > 0;

  if (allCatalogMatched && hasItems) {
    await autoApproveQuotation(quotation.id, quotation.line_items);
    await updateState(convo.id, 'main_menu', { quotationHistory: null, quotationFollowups: 0 });
    // PDF already sent via WhatsApp by autoApproveQuotation — no extra text needed
    return;
  }

  // Unmatched custom items — send to consultant for pricing
  await updateState(convo.id, 'awaiting_consultant', { quotationHistory: null, quotationFollowups: 0 });
  notifyAsync(notifyNewQuotation, quotation, client);
  notifyAsync(notifyConsultantRequested, convo, client, 'Quotation enquiry');
  return R(TEMPLATES.QUOTATION_DRAFT_ACK, { reference: quotation.reference, unmatched: unmatchedText });
}

// ── Size availability via AI ──────────────────────────────────────────────────
async function handleSizeQuery(body, convo, R) {
  const products = await listProducts({});
  const result = await answerFaq(body, {
    products,
    hoursText: TEMPLATES.RETAIL_HOURS(),
    laybyText: TEMPLATES.RETAIL_LAYBY(),
  });

  if (result.type === 'answer' && result.text) {
    return R(() =>
      result.text +
      '\n\nFeel free to ask about another product, or reply *back* for the shop menu | *0* for the main menu.'
    );
  }

  return R(() =>
    `I couldn't find size information for that product in our catalog. 😊\n\n` +
    `Reply *9* to speak to a consultant, or try a different product.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — called by the webhook for every inbound message
// ─────────────────────────────────────────────────────────────────────────────
export async function handleInbound({ phoneNumber, metaMessageId, body }) {
  logger.info('Handling inbound message', { phoneNumber, body: body?.slice(0, 80) });

  const client = await getOrCreateClientByWhatsapp(phoneNumber);
  const { conversation: convo, isNew } = await getOrCreateConversation(client.id);
  const state  = convo.state;
  const intent = detectIntent(body || '');

  await saveMessage(convo.id, client.id, metaMessageId, body, 'inbound');

  const R = (templateFn, params = {}) =>
    reply(phoneNumber, convo.id, client.id, templateFn, params);

  // First-contact acknowledgement (new conversation)
  if (isNew) {
    const busyMode = await getSetting('busy_mode');
    const withinHours = isWithinBusinessHours();
    if (busyMode === 'true') {
      await R(TEMPLATES.HIGH_VOLUME_NOTICE);
    } else if (!withinHours) {
      await R(TEMPLATES.OUTSIDE_HOURS_ACK);
    }
  }

  // Check for overdue quotation reminders (non-blocking)
  sendOverdueQuotationReminder(client, phoneNumber).catch((err) =>
    logger.warn('SLA reminder check failed', { error: err.message })
  );

  // ── Global overrides (fire in any non-data-collection state) ─────────────
  if (intent.type === 'main_menu') {
    await updateState(convo.id, 'main_menu');
    return R(TEMPLATES.MAIN_MENU);
  }

  if (intent.type === 'back') {
    const parentState   = PARENT_STATE[state] ?? 'main_menu';
    const templateGetter = PARENT_TEMPLATE[parentState] ?? ((T) => T.MAIN_MENU);
    await updateState(convo.id, parentState);
    return R(templateGetter(TEMPLATES));
  }

  if (intent.type === 'consultant') {
    await updateState(convo.id, 'awaiting_consultant');
    notifyAsync(notifyConsultantRequested, convo, client, 'General enquiry');
    return R(TEMPLATES.AWAITING_CONSULTANT);
  }

  // Order/quotation reference typed — route based on state and ref type
  if (intent.type === 'order_ref') {
    const ref = intent.value;

    // BRQ-Q ref typed while waiting for a quotation ref → look up the quote
    if (ref.startsWith('BRQ-Q-') && state === 'order_ask_reference') {
      return handleOrderQuoteRefLookup(ref, convo, client, R);
    }

    // Everything else → order tracking
    const order = await findOrder(ref, client.id);
    if (!order) return R(TEMPLATES.ORDER_NOT_FOUND);
    const estimatedDate = order.estimated_completion_date
      ? new Date(order.estimated_completion_date).toLocaleDateString('en-ZA')
      : null;
    await updateState(convo.id, 'main_menu');
    return R(TEMPLATES.ORDER_TRACKING_RESULT, {
      reference: order.reference,
      stage: order.stage,
      trackingNumber: order.tracking_number,
      estimatedCompletion: estimatedDate,
    });
  }

  // Keyword shortcuts — disabled in data-collection states
  if (intent.type === 'keyword' && !DATA_COLLECTION_STATES.has(state)) {
    if (intent.value === 'track') {
      await updateState(convo.id, 'order_tracking_ask');
      return R(TEMPLATES.ORDER_TRACKING_ASK);
    }
    if (intent.value === 'hours')    return R(TEMPLATES.RETAIL_HOURS);
    if (intent.value === 'layby')    return R(TEMPLATES.RETAIL_LAYBY);
    if (intent.value === 'branding') return R(TEMPLATES.BRANDING_INFO);
    if (intent.value === 'store')    return R(TEMPLATES.STORE_INFO);
    if (intent.value === 'quote') {
      return gateOrProceed(client, convo, 'quotation_ask_description', R, async () => {
        await updateState(convo.id, 'quotation_ask_description', { quotationHistory: [], quotationFollowups: 0 });
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      });
    }
    if (intent.value === 'ticket') {
      await updateState(convo.id, 'ticket_ask_category');
      return R(TEMPLATES.TICKET_ASK_CATEGORY);
    }
    if (intent.value === 'accept_quote') {
      const accepted = await acceptQuotationByClient(client.id);
      if (!accepted) {
        return R(TEMPLATES.NO_PENDING_QUOTE);
      }
      notifyAsync(notifyQuotationAccepted, accepted, client);
      return R(TEMPLATES.QUOTE_ACCEPTED, { reference: accepted.reference });
    }
    if (intent.value === 'make_order') {
      return gateOrProceed(client, convo, 'order_ask_method', R, async () => {
        await updateState(convo.id, 'order_ask_method');
        return R(TEMPLATES.ORDER_ASK_METHOD);
      });
    }
  }

  // Consultant active — message already saved; staff sees it in inbox
  if (state === 'consultant_active' || state === 'awaiting_consultant') {
    logger.info('Message queued for consultant', { conversationId: convo.id });
    return;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  switch (state) {

    case 'main_menu':
      if (intent.type === 'menu') {
        return handleMainMenuSelection(intent.value, convo, client, R);
      }
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.MAIN_MENU);

    case 'retail_menu':
      if (intent.type === 'menu') {
        return handleRetailMenuSelection(intent.value, convo, client, R);
      }
      await updateState(convo.id, 'retail_menu');
      return R(TEMPLATES.RETAIL_MENU);

    case 'retail_school_select': {
      const schools = convo.context.schoolList || [];
      const num = parseInt(body.trim());
      if (!isNaN(num) && num >= 1 && num <= schools.length) {
        const selectedSchool = schools[num - 1];
        const uniforms = await listProductsBySchool(selectedSchool);
        await updateState(convo.id, 'retail_menu');
        if (!uniforms.length) {
          return R(() =>
            `🏫 *${selectedSchool}*\n\n` +
            `We supply uniforms for ${selectedSchool}. A consultant will send you the full product list and pricing.\n\n` +
            `Reply *9* to speak to a consultant now, or *back* to view another school.`
          );
        }
        return R(TEMPLATES.RETAIL_SCHOOL_UNIFORMS, { schoolName: selectedSchool, uniforms });
      }
      return R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
    }

    case 'retail_size_ask':
      return handleSizeQuery(body, convo, R);

    case 'retail_collection_ask':
      // If they typed something other than a BRQ ref, prompt again
      await updateState(convo.id, 'retail_menu');
      return R(TEMPLATES.ORDER_NOT_FOUND);

    case 'order_tracking_ask':
      // Expecting an order ref — handled above; if not a ref, reprompt
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.ORDER_NOT_FOUND);

    case 'corporate_menu':
      if (intent.type === 'menu') {
        return handleCorporateMenuSelection(intent.value, convo, client, R);
      }
      await updateState(convo.id, 'corporate_menu');
      return R(TEMPLATES.CORPORATE_MENU);

    case 'corporate_repeat_order_ask':
      // Expecting an order reference — if not provided above, prompt again
      await updateState(convo.id, 'corporate_menu');
      return R(TEMPLATES.CORPORATE_MENU);

    case 'corporate_manufacturing_ask':
    case 'corporate_delivery_ask':
      // Expecting an order reference — handled above, prompt again if not
      return R(TEMPLATES.ORDER_NOT_FOUND);

    case 'corporate_account_query': {
      const description = body.trim();
      if (description.length < 5) {
        return R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_ASK);
      }
      const accountTicket = await createTicket({
        clientId: client.id,
        category: 'account_query',
        description,
      });
      await updateState(convo.id, 'awaiting_consultant');
      notifyAsync(notifyNewTicket, accountTicket, client);
      notifyAsync(notifyConsultantRequested, convo, client, description);
      return R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_LOGGED);
    }

    case 'quotation_ask_description':
    case 'quotation_gathering':
      return handleQuotationGathering(body, convo, client, R);

    case 'order_ask_method': {
      if (intent.type === 'menu' && intent.value === 1) {
        await updateState(convo.id, 'order_ask_reference');
        return R(TEMPLATES.ORDER_ASK_REFERENCE);
      }
      if (intent.type === 'menu' && intent.value === 2) {
        await updateState(convo.id, 'order_gathering', { orderHistory: [], orderFollowups: 0 });
        return R(TEMPLATES.ORDER_ASK_ITEMS, { name: client.name });
      }
      return R(TEMPLATES.ORDER_ASK_METHOD);
    }

    case 'order_ask_reference':
      // BRQ-Q ref typed → intercepted globally above; anything else → reprompt
      return R(TEMPLATES.ORDER_ASK_REFERENCE);

    case 'order_gathering':
      return handleOrderGathering(body, convo, client, R);

    case 'order_confirm_quote': {
      if (intent.type === 'menu' && intent.value === 1) {
        const quotationId = convo.context.pendingQuotationId;
        if (!quotationId) { await updateState(convo.id, 'main_menu'); return R(TEMPLATES.MAIN_MENU); }
        const { rows: qRows } = await query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
        if (!qRows.length) { await updateState(convo.id, 'main_menu'); return R(TEMPLATES.MAIN_MENU); }
        const lineItems = Array.isArray(qRows[0].line_items) ? qRows[0].line_items : [];
        const order = await createOrderFromBot(client.id, { lineItems, quotationId });
        await updateState(convo.id, 'main_menu', { pendingQuotationId: null });
        notifyAsync(notifyNewOrder, order, client);
        return R(TEMPLATES.ORDER_CREATED, { reference: order.reference, deposit: Number(order.deposit_amount) });
      }
      if (intent.type === 'menu' && intent.value === 2) {
        await updateState(convo.id, 'main_menu');
        return R(TEMPLATES.MAIN_MENU);
      }
      // Re-show confirm — re-fetch from context
      const qId = convo.context.pendingQuotationId;
      if (!qId) { await updateState(convo.id, 'main_menu'); return R(TEMPLATES.MAIN_MENU); }
      const { rows: reRows } = await query('SELECT * FROM quotations WHERE id = $1', [qId]);
      if (!reRows.length) { await updateState(convo.id, 'main_menu'); return R(TEMPLATES.MAIN_MENU); }
      const rq = reRows[0];
      const rItems = Array.isArray(rq.line_items) ? rq.line_items : [];
      return R(TEMPLATES.ORDER_CONFIRM_QUOTE, {
        reference: rq.reference,
        items: rItems,
        subtotal: Number(rq.subtotal),
        vat: Number(rq.vat),
        total: Number(rq.total),
        deposit: parseFloat((Number(rq.total) * 0.60).toFixed(2)),
      });
    }

    case 'order_confirm_direct': {
      if (intent.type === 'menu' && intent.value === 1) {
        const lineItems = convo.context.pendingOrderItems || [];
        if (!lineItems.length) { await updateState(convo.id, 'main_menu'); return R(TEMPLATES.MAIN_MENU); }
        const order = await createOrderFromBot(client.id, { lineItems });
        await updateState(convo.id, 'main_menu', { pendingOrderItems: null });
        notifyAsync(notifyNewOrder, order, client);
        return R(TEMPLATES.ORDER_CREATED, { reference: order.reference, deposit: Number(order.deposit_amount) });
      }
      if (intent.type === 'menu' && intent.value === 2) {
        await updateState(convo.id, 'main_menu');
        return R(TEMPLATES.MAIN_MENU);
      }
      // Re-show confirm
      const pendingItems = convo.context.pendingOrderItems || [];
      const sub  = parseFloat(pendingItems.reduce((s, i) => s + Number(i.lineTotal), 0).toFixed(2));
      const vat  = parseFloat((sub * 0.15).toFixed(2));
      const tot  = parseFloat((sub + vat).toFixed(2));
      const dep  = parseFloat((tot * 0.60).toFixed(2));
      return R(TEMPLATES.ORDER_CONFIRM_DIRECT, { items: pendingItems, subtotal: sub, vat, total: tot, deposit: dep });
    }

    case 'ticket_ask_category': {
      const categoryMap = { '1': 'wrong_item', '2': 'defective', '3': 'missing_item', '4': 'other' };
      const category = categoryMap[body.trim()] || null;
      if (!category) return R(TEMPLATES.TICKET_ASK_CATEGORY);
      await updateState(convo.id, 'ticket_ask_description', { ticketCategory: category });
      return R(TEMPLATES.TICKET_ASK_DESCRIPTION);
    }

    case 'ticket_ask_description': {
      const description = body.trim();
      if (description.length < 30) return R(TEMPLATES.TICKET_NEEDS_MORE_DETAIL);
      const ticket = await createTicket({
        clientId: client.id,
        category: convo.context.ticketCategory || 'other',
        description,
      });
      await updateState(convo.id, 'awaiting_consultant');
      notifyAsync(notifyNewTicket, ticket, client);
      notifyAsync(notifyConsultantRequested, convo, client, description);
      return R(TEMPLATES.TICKET_LOGGED);
    }

    case 'registration_name': {
      if (!body.trim()) return R(TEMPLATES.REGISTRATION_ASK_NAME);
      await updateClientProfile(client.id, { name: body.trim() });
      await updateState(convo.id, 'registration_org_or_school');
      return R(TEMPLATES.REGISTRATION_ASK_ORG_OR_SCHOOL, { clientType: client.client_type });
    }

    case 'registration_org_or_school': {
      const isRetailLike = ['retail', 'school'].includes(client.client_type);
      const patch = isRetailLike
        ? { school_name: body.trim() }
        : { organisation: body.trim() };
      await updateClientProfile(client.id, patch);
      await updateState(convo.id, 'registration_address');
      return R(TEMPLATES.REGISTRATION_ASK_ADDRESS, { clientType: client.client_type });
    }

    case 'registration_address': {
      const isRetailLike = ['retail', 'school'].includes(client.client_type);
      const patch = isRetailLike
        ? { preferred_store_location: body.trim() }
        : { physical_address: body.trim() };
      await updateClientProfile(client.id, { ...patch, profile_complete: true });
      await R(TEMPLATES.REGISTRATION_COMPLETE);

      const pendingIntent = convo.context.pendingIntent || 'main_menu';
      if (pendingIntent === 'quotation_ask_description') {
        await updateState(convo.id, 'quotation_ask_description', { quotationHistory: [], quotationFollowups: 0 });
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      }
      if (pendingIntent === 'corporate_menu') {
        await updateState(convo.id, 'corporate_menu');
        return R(TEMPLATES.CORPORATE_MENU);
      }
      if (pendingIntent === 'order_ask_method') {
        await updateState(convo.id, 'order_ask_method');
        return R(TEMPLATES.ORDER_ASK_METHOD);
      }
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.MAIN_MENU);
    }

    default:
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.MAIN_MENU);
  }
}

// ── Order: look up a quotation ref and show confirmation ─────────────────────
async function handleOrderQuoteRefLookup(reference, convo, client, R) {
  const quotation = await getQuotationByReference(reference, client.id);
  if (!quotation) return R(TEMPLATES.ORDER_QUOTE_NOT_FOUND);

  if (!['sent', 'accepted'].includes(quotation.status)) {
    return R(TEMPLATES.ORDER_QUOTE_NOT_READY, { status: quotation.status });
  }

  const items    = Array.isArray(quotation.line_items) ? quotation.line_items : [];
  const subtotal = Number(quotation.subtotal);
  const vat      = Number(quotation.vat);
  const total    = Number(quotation.total);
  const deposit  = parseFloat((total * 0.60).toFixed(2));

  await updateState(convo.id, 'order_confirm_quote', { pendingQuotationId: quotation.id });
  return R(TEMPLATES.ORDER_CONFIRM_QUOTE, { reference: quotation.reference, items, subtotal, vat, total, deposit });
}

// ── Order: multi-turn gathering for direct catalog orders ─────────────────────
async function handleOrderGathering(body, convo, client, R) {
  const history        = [...(convo.context.orderHistory || [])];
  history.push({ role: 'client', text: body });

  const followupsAsked = convo.context.orderFollowups || 0;
  const MAX_FOLLOWUPS  = 5;
  const products       = await listProducts({});

  if (followupsAsked < MAX_FOLLOWUPS) {
    const result = await gatherQuotationInfo(history, { products });

    if (result.status === 'need_more_info' && result.question) {
      history.push({ role: 'bot', text: result.question });
      await updateState(convo.id, 'order_gathering', {
        orderHistory:   history,
        orderFollowups: followupsAsked + 1,
      });
      return R(() => result.question);
    }

    const consolidated = result.consolidatedRequest
      || history.filter((h) => h.role === 'client').map((h) => h.text).join('\n');
    return finaliseDirectOrder(consolidated, convo, client, R);
  }

  const consolidated = history.filter((h) => h.role === 'client').map((h) => h.text).join('\n');
  return finaliseDirectOrder(consolidated, convo, client, R);
}

async function finaliseDirectOrder(consolidatedText, convo, client, R) {
  const products     = await listProducts({});
  const parsed       = await parseQuotationRequest(consolidatedText, { products });
  const productsById = new Map(products.map((p) => [p.id, p]));

  const unmatchedItems = [...(parsed.unmatchedText || [])];
  const lineItems      = [];

  for (const item of parsed.items || []) {
    const product = productsById.get(item.productId);
    if (!product || !item.quantity || item.quantity <= 0) {
      unmatchedItems.push(item.description || 'unrecognised item');
      continue;
    }
    const qty       = item.quantity;
    const unitPrice = Number(product.price);
    const sizes     = Array.isArray(item.sizes) && item.sizes.length
      ? item.sizes : [{ size: 'TBC', qty }];
    lineItems.push({
      productId:          product.id,
      name:               product.name,
      category:           product.category,
      colour:             item.colour || '',
      sizes,
      quantity:           qty,
      unitPrice,
      brandingSurcharge:  0,
      effectiveUnitPrice: unitPrice,
      branding:           { type: 'none', position: '', detail: '' },
      lineTotal:          unitPrice * qty,
      priceConfirmed:     true,
    });
  }

  if (unmatchedItems.length > 0) {
    await updateState(convo.id, 'order_ask_method', { orderHistory: null, orderFollowups: 0 });
    return R(TEMPLATES.ORDER_CUSTOM_ITEMS_NOT_ALLOWED, { unmatched: unmatchedItems });
  }

  if (!lineItems.length) {
    await updateState(convo.id, 'order_gathering', { orderHistory: [], orderFollowups: 0 });
    return R(() =>
      `I couldn't identify any catalog items from your message. 😊\n\n` +
      `Please describe what you'd like to order, including item types, colours, and sizes.\n\n` +
      `Or reply *3* to request a formal quotation instead.`
    );
  }

  const subtotal = parseFloat(lineItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));
  const vat      = parseFloat((subtotal * 0.15).toFixed(2));
  const total    = parseFloat((subtotal + vat).toFixed(2));
  const deposit  = parseFloat((total * 0.60).toFixed(2));

  await updateState(convo.id, 'order_confirm_direct', {
    pendingOrderItems: lineItems,
    orderHistory:      null,
    orderFollowups:    0,
  });
  return R(TEMPLATES.ORDER_CONFIRM_DIRECT, { items: lineItems, subtotal, vat, total, deposit });
}

// ── Main menu handler (8 options) ─────────────────────────────────────────────
async function handleMainMenuSelection(option, convo, client, R) {
  switch (option) {
    case 1:
      await updateState(convo.id, 'retail_menu');
      return R(TEMPLATES.RETAIL_MENU);

    case 2:
      await updateState(convo.id, 'corporate_menu');
      return R(TEMPLATES.CORPORATE_MENU);

    case 3:
      return gateOrProceed(client, convo, 'quotation_ask_description', R, async () => {
        await updateState(convo.id, 'quotation_ask_description', { quotationHistory: [], quotationFollowups: 0 });
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      });

    case 4:
      return gateOrProceed(client, convo, 'order_ask_method', R, async () => {
        await updateState(convo.id, 'order_ask_method');
        return R(TEMPLATES.ORDER_ASK_METHOD);
      });

    case 5:
      await updateState(convo.id, 'order_tracking_ask');
      return R(TEMPLATES.ORDER_TRACKING_ASK);

    case 6:
      return R(TEMPLATES.BRANDING_INFO);

    case 7:
      return R(TEMPLATES.STORE_INFO);

    case 8:
      await updateState(convo.id, 'awaiting_consultant');
      notifyAsync(notifyConsultantRequested, convo, client, 'General enquiry');
      return R(TEMPLATES.AWAITING_CONSULTANT);

    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}

// ── Retail menu handler (6 options) ──────────────────────────────────────────
async function handleRetailMenuSelection(option, convo, client, R) {
  switch (option) {
    case 1: {
      const products = await listProducts({ activeOnly: true });
      await updateState(convo.id, 'retail_pricing');
      return R(TEMPLATES.RETAIL_PRODUCT_LIST, { products });
    }

    case 2: {
      const dbSchools = await listSchoolNames();
      const extra = dbSchools.filter((s) => !SCHOOLS.includes(s));
      const schools = [...SCHOOLS, ...extra];
      await updateState(convo.id, 'retail_school_select', { schoolList: schools });
      return R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
    }

    case 3:
      await updateState(convo.id, 'retail_hours');
      return R(TEMPLATES.RETAIL_HOURS);

    case 4:
      await updateState(convo.id, 'retail_collection_ask');
      return R(TEMPLATES.RETAIL_COLLECTION_ASK);

    case 5:
      await updateState(convo.id, 'retail_layby');
      return R(TEMPLATES.RETAIL_LAYBY);

    case 6:
      await updateState(convo.id, 'retail_size_ask');
      return R(TEMPLATES.RETAIL_SIZE_ASK);

    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}

// ── Corporate menu handler (6 options) ────────────────────────────────────────
async function handleCorporateMenuSelection(option, convo, client, R) {
  switch (option) {
    case 1:
      await updateState(convo.id, 'corporate_repeat_order_ask');
      return R(TEMPLATES.CORPORATE_REPEAT_ORDER_ASK);

    case 2:
      // New uniform development → quotation flow
      return gateOrProceed(client, convo, 'quotation_ask_description', R, async () => {
        await updateState(convo.id, 'quotation_ask_description', { quotationHistory: [], quotationFollowups: 0 });
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      });

    case 3:
      await updateState(convo.id, 'corporate_manufacturing_ask');
      return R(TEMPLATES.CORPORATE_MANUFACTURING_ASK);

    case 4:
      await updateState(convo.id, 'corporate_delivery_ask');
      return R(TEMPLATES.CORPORATE_DELIVERY_ASK);

    case 5:
      await updateState(convo.id, 'corporate_account_query');
      return R(TEMPLATES.CORPORATE_ACCOUNT_QUERY_ASK);

    case 6:
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.AWAITING_CONSULTANT);

    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}
