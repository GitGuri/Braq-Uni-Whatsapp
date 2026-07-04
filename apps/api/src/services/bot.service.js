import { query } from '../db/pool.js';
import { sendTextMessage } from './whatsapp.service.js';
import { TEMPLATES } from './bot.templates.js';
import { answerFaq, gatherQuotationInfo } from './ai.service.js';
import { listProducts } from './catalog.service.js';
import { listDistinctSchools, listUniformsForSchool } from './schoolCatalog.service.js';
import { createFromFreeText } from './quotations.service.js';
import { repeatOrder, createOrder, getStageProgress, getOrderById, recordDesignApproval } from './orders.service.js';
import { submitPurchaseOrder } from './purchaseOrders.service.js';
import { createTicket } from './tickets.service.js';
import { getOrCreateClientByWhatsapp, updateClientProfile } from './clients.service.js';
import { isWithinBusinessHours } from '../utils/businessHours.js';
import { logger } from '../utils/logger.js';

// Canonical school list — always shown in the bot even before catalog is populated
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

// Where to resume after the registration gate completes.
const RESUME_TEMPLATES = {
  quotation_requested:       TEMPLATES.QUOTATION_ASK_DESCRIPTION,
  corporate_uniform_garment: TEMPLATES.UNIFORM_INTAKE_GARMENT,
};

// ── Parent state map — used by the "back" command ────────────────────────────
const PARENT_STATE = {
  main_menu:                      'main_menu',
  retail_menu:                    'main_menu',
  retail_pricing:                 'retail_menu',
  retail_size_availability:       'retail_menu',
  retail_layby:                   'retail_menu',
  retail_hours:                   'retail_menu',
  retail_collection:              'retail_menu',
  retail_school_select:           'retail_menu',
  corporate_menu:                 'main_menu',
  corporate_new_order:            'corporate_menu',
  corporate_repeat_order:         'corporate_menu',
  corporate_manufacturing_update: 'corporate_menu',
  corporate_delivery_schedule:    'corporate_menu',
  quotation_requested:            'main_menu',
  ticket_category:                'main_menu',
  ticket_description:             'ticket_category',
};

const PARENT_TEMPLATE = {
  main_menu:      (T) => T.MAIN_MENU,
  retail_menu:    (T) => T.RETAIL_MENU,
  corporate_menu: (T) => T.CORPORATE_MENU,
  ticket_category:(T) => T.TICKET_ASK_CATEGORY,
};

// ── Intent detection ──────────────────────────────────────────────────────────
function detectIntent(body) {
  const t = body.trim().toLowerCase();

  // Universal navigation — work in any state
  if (t === '0' || t === 'menu' || t === 'main menu') return { type: 'main_menu' };
  if (t === 'back' || t === 'go back')                 return { type: 'back' };
  if (t === '9' || /^(speak to|talk to|connect me to|i need a) consultant/i.test(t))
    return { type: 'consultant' };

  // Menu digits
  if (/^[1-7]$/.test(t)) return { type: 'menu', value: parseInt(t) };

  // Order reference pattern e.g. BRQ-20260624-5678
  if (/^brq-\d{8}-\d{4}$/i.test(t)) return { type: 'order_ref', value: t.toUpperCase() };

  // Keywords
  if (/track|order status|where.*order/i.test(t))    return { type: 'keyword', value: 'track' };
  if (/quot/i.test(t))                               return { type: 'keyword', value: 'quote' };
  if (/hours?|open|trading/i.test(t))                return { type: 'keyword', value: 'hours' };
  if (/lay.?by|layby/i.test(t))                      return { type: 'keyword', value: 'layby' };
  if (/brand|embroider|print|sublim/i.test(t))       return { type: 'keyword', value: 'branding' };
  if (/store info|where.*shop|where.*store|store location/i.test(t))
    return { type: 'keyword', value: 'store' };
  if (/\bpurchase order\b|\bpo\b/i.test(t))          return { type: 'keyword', value: 'po' };
  if (/wrong item|defective|faulty|damaged|broken item|missing item|\bcomplaint\b/i.test(t))
    return { type: 'keyword', value: 'ticket' };

  return { type: 'freetext', value: body };
}

// ── SLA reminder: send WhatsApp update if a draft quotation is overdue ───────
async function sendOverdueQuotationReminder(client, phoneNumber) {
  const { rows } = await query(
    `SELECT * FROM quotations
     WHERE client_id      = $1
       AND status         = 'draft'
       AND sla_remind_at  <= NOW()
       AND reminder_sent_at IS NULL
     ORDER BY sla_remind_at ASC
     LIMIT 1`,
    [client.id]
  );
  if (!rows.length) return;

  const q = rows[0];
  await query(
    `UPDATE quotations SET reminder_sent_at = NOW() WHERE id = $1`,
    [q.id]
  );

  const firstName = client.name?.split(' ')[0] || 'there';
  const msg =
    `Hi *${firstName}*! 😊\n\n` +
    `Just a quick update — your consultant is finalising your quotation ` +
    `*(Ref: ${q.reference})* and will send it through to you shortly.\n\n` +
    `We appreciate your patience! If you have any questions in the meantime, ` +
    `reply *9* to speak to a consultant directly.`;

  const msgId = await sendTextMessage(phoneNumber, msg);
  logger.info('Sent overdue quotation reminder', { clientId: client.id, quotationId: q.id });
  return msgId;
}

// ── Get or create open conversation ──────────────────────────────────────────
async function getOrCreateConversation(clientId) {
  const existing = await query(
    `SELECT * FROM conversations
     WHERE client_id = $1 AND is_open = true
     ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  if (existing.rows.length > 0) return { conversation: existing.rows[0], isNew: false };

  const created = await query(
    `INSERT INTO conversations (client_id, state)
     VALUES ($1, 'new') RETURNING *`,
    [clientId]
  );
  return { conversation: created.rows[0], isNew: true };
}

// ── Save inbound message ──────────────────────────────────────────────────────
async function saveMessage(conversationId, clientId, metaMessageId, body, direction = 'inbound') {
  await query(
    `INSERT INTO messages (conversation_id, client_id, meta_message_id, direction, body, is_read_by_staff)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, clientId, metaMessageId, direction, body, direction === 'inbound']
  );
}

// ── Update conversation state ─────────────────────────────────────────────────
async function updateState(conversationId, state, context = {}) {
  await query(
    `UPDATE conversations
     SET state = $1, context = context || $2, last_message_at = NOW()
     WHERE id = $3`,
    [state, JSON.stringify(context), conversationId]
  );
}

// ── Reply and save outbound ───────────────────────────────────────────────────
async function reply(to, conversationId, clientId, templateFn, params = {}) {
  const body = templateFn(params);
  const msgId = await sendTextMessage(to, body);
  await saveMessage(conversationId, clientId, msgId, body, 'outbound');
  return msgId;
}

// ── Registration gate — divert to a 3-question profile capture if incomplete ─
async function gateOrProceed(client, convo, pendingState, R, updateState, proceedFn) {
  if (client.profile_complete) return proceedFn();
  await updateState(convo.id, 'registration_name', { pendingIntent: { state: pendingState } });
  return R(TEMPLATES.REGISTRATION_ASK_NAME);
}

// ── Repeat a previous order under a new reference ─────────────────────────────
async function repeatPreviousOrder(reference, convo, client, R, updateState) {
  try {
    const { order, previousReference } = await repeatOrder(reference, client.id);
    await updateState(convo.id, 'awaiting_consultant');
    return R(() =>
      `Your repeat order has been created. 🔁\n\n` +
      `*New Ref: ${order.reference}*\n` +
      `(based on previous order ${previousReference})\n\n` +
      `A consultant will confirm details shortly.`
    );
  } catch (err) {
    if (err.status === 404) return R(TEMPLATES.ORDER_NOT_FOUND);
    throw err;
  }
}

// ── Report an order's manufacturing/delivery status by reference ─────────────
async function reportOrderStatus(reference, convo, client, R, updateState) {
  const order = await findOrder(reference, client.id);
  await updateState(convo.id, 'main_menu');

  if (!order) return R(TEMPLATES.ORDER_NOT_FOUND);
  const { percent } = getStageProgress(order.stage);
  return R(TEMPLATES.CORPORATE_DELIVERY_STATUS, {
    reference: order.reference,
    stage: order.stage,
    trackingNumber: order.tracking_number,
    percent,
  });
}

// ── Finish the guided new-uniform-development intake ─────────────────────────
async function completeUniformIntake(quantityText, convo, client, R, updateState) {
  const intake = convo.context.uniformIntake || {};
  const description =
    `New uniform development request:\n` +
    `Garment(s): ${intake.garment || '-'}\n` +
    `Sizes/age range: ${intake.sizes || '-'}\n` +
    `Branding: ${intake.branding || '-'}\n` +
    `Quantity/timeline: ${quantityText}`;

  const order = await createOrder({
    clientId: client.id,
    clientType: 'corporate',
    description,
    isUrgent: false,
  }, null);

  await updateState(convo.id, 'awaiting_consultant');
  return R(TEMPLATES.UNIFORM_INTAKE_COMPLETE, { reference: order.reference });
}

// ── Log the quotation as a draft and notify client — consultant sends the PDF ──
async function generateAndSendQuotation(consolidatedText, convo, client, phoneNumber, R, updateState) {
  const { quotation, unmatchedText } = await createFromFreeText(client.id, consolidatedText);

  await updateState(convo.id, 'awaiting_consultant', {
    quotationHistory: null,
    quotationFollowups: 0,
  });

  // Always draft — consultant reviews in the dashboard and clicks "Price & Approve"
  // which recalculates totals and sends the PDF to the client via WhatsApp.
  return R(TEMPLATES.QUOTATION_DRAFT_ACK, {
    reference: quotation.reference,
    unmatched: unmatchedText,
  });
}

// ── Multi-turn quotation gathering — AI asks follow-ups until enough info ─────
async function handleQuotationGathering(body, convo, client, phoneNumber, R, updateState) {
  const history = [...(convo.context.quotationHistory || [])];
  history.push({ role: 'client', text: body });

  const followupsAsked = convo.context.quotationFollowups || 0;
  const MAX_FOLLOWUPS  = 5; // AI drives the conversation; this is a hard safety ceiling
  const products = await listProducts({});

  if (followupsAsked < MAX_FOLLOWUPS) {
    const result = await gatherQuotationInfo(history, { products });

    if (result.status === 'need_more_info' && result.question) {
      history.push({ role: 'bot', text: result.question });
      await updateState(convo.id, 'quotation_requested', {
        quotationHistory: history,
        quotationFollowups: followupsAsked + 1,
      });
      return R(() => result.question);
    }

    const consolidated = result.consolidatedRequest
      || history.filter(h => h.role === 'client').map(h => h.text).join('\n');
    return generateAndSendQuotation(consolidated, convo, client, phoneNumber, R, updateState);
  }

  // Safety ceiling reached — generate with everything gathered so far
  const consolidated = history.filter(h => h.role === 'client').map(h => h.text).join('\n');
  return generateAndSendQuotation(consolidated, convo, client, phoneNumber, R, updateState);
}

// ── Submit a purchase order against a previously shared quotation reference ──
async function submitPo(poNumber, convo, client, R, updateState) {
  const quotationRef = convo.context.poQuotationRef;
  try {
    const { valid, order } = await submitPurchaseOrder(quotationRef, poNumber.trim(), client.id);
    if (!valid) {
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.PO_INVALID);
    }
    await updateState(convo.id, 'main_menu');
    return R(() =>
      `✅ Purchase order received and validated.\n\n*Order Ref: ${order.reference}*\n\n` +
      `We'll keep you updated as your order progresses.`
    );
  } catch (err) {
    if (err.status === 404) {
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.PO_INVALID);
    }
    throw err;
  }
}

// ── Handle the client's reply to a design-approval request ───────────────────
async function handleDesignApprovalReply(body, convo, R, updateState) {
  const orderId = convo.context.designApprovalOrderId;
  if (!orderId) {
    await updateState(convo.id, 'main_menu');
    return R(TEMPLATES.MAIN_MENU);
  }

  const t = body.trim().toLowerCase();
  if (t.startsWith('approve')) {
    const { order } = await recordDesignApproval(orderId, { approved: true });
    await updateState(convo.id, 'main_menu');
    return R(TEMPLATES.DESIGN_APPROVED_ACK, { reference: order.reference });
  }
  if (t.startsWith('reject')) {
    const reason = body.includes(':') ? body.slice(body.indexOf(':') + 1).trim() : 'No reason given';
    const { order } = await recordDesignApproval(orderId, { approved: false, reason });
    await updateState(convo.id, 'awaiting_consultant');
    return R(TEMPLATES.DESIGN_REJECTED_ACK, { reference: order.reference });
  }

  const { order } = await getOrderById(orderId);
  return R(TEMPLATES.DESIGN_APPROVAL_REQUEST, { reference: order.reference });
}

// ── Try the AI FAQ agent, escalate to a consultant if it can't ground an answer
async function tryAnswerFaq(question, convo, R, updateState) {
  const products = await listProducts({});
  const result = await answerFaq(question, {
    products,
    hoursText: TEMPLATES.RETAIL_HOURS(),
    laybyText: TEMPLATES.RETAIL_LAYBY(),
  });

  if (result.type === 'answer' && result.text) {
    return R(() => result.text);
  }

  logger.info('FAQ escalated to consultant', { conversationId: convo.id, reason: result.reason });
  await updateState(convo.id, 'awaiting_consultant');
  return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });
}

// ── Handle a size availability query from the customer ────────────────────────
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
    `Please reply *9* to speak to a consultant who can confirm availability, ` +
    `or try asking about a different product.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`
  );
}

// ── Look up order by reference ────────────────────────────────────────────────
async function findOrder(reference, clientId) {
  const result = await query(
    `SELECT o.*, c.whatsapp_number
     FROM orders o
     JOIN clients c ON o.client_id = c.id
     WHERE o.reference = $1 AND o.client_id = $2`,
    [reference, clientId]
  );
  return result.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — called by webhook for every inbound message
// ─────────────────────────────────────────────────────────────────────────────
export async function handleInbound({ phoneNumber, metaMessageId, body }) {
  logger.info('Handling inbound message', { phoneNumber, body: body.slice(0, 80) });

  const client   = await getOrCreateClientByWhatsapp(phoneNumber);
  const { conversation: convo, isNew } = await getOrCreateConversation(client.id);
  const state    = convo.state;
  const intent   = detectIntent(body);

  // Always save the inbound message
  await saveMessage(convo.id, client.id, metaMessageId, body, 'inbound');

  const R = (templateFn, params = {}) =>
    reply(phoneNumber, convo.id, client.id, templateFn, params);

  if (isNew && !isWithinBusinessHours()) {
    await R(TEMPLATES.OUTSIDE_HOURS_ACK);
  }

  // Check if any draft quotation is overdue for a consultant-progress reminder
  await sendOverdueQuotationReminder(client, phoneNumber).catch((err) =>
    logger.warn('SLA reminder check failed (non-fatal)', { error: err.message })
  );

  // ── Global overrides — fire in any state ─────────────────────────────────
  if (intent.type === 'main_menu') {
    await updateState(convo.id, 'main_menu');
    return R(TEMPLATES.MAIN_MENU);
  }

  if (intent.type === 'back') {
    const parentState  = PARENT_STATE[state] ?? 'main_menu';
    const templateGetter = PARENT_TEMPLATE[parentState] ?? ((T) => T.MAIN_MENU);
    await updateState(convo.id, parentState);
    return R(templateGetter(TEMPLATES));
  }

  if (intent.type === 'consultant') {
    await updateState(convo.id, 'awaiting_consultant');
    return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });
  }

  if (intent.type === 'order_ref' && state === 'corporate_repeat_order') {
    return repeatPreviousOrder(intent.value, convo, client, R, updateState);
  }

  if (intent.type === 'order_ref' && (state === 'corporate_manufacturing_update' || state === 'corporate_delivery_schedule')) {
    return reportOrderStatus(intent.value, convo, client, R, updateState);
  }

  if (intent.type === 'order_ref') {
    const order = await findOrder(intent.value, client.id);
    if (!order) return R(TEMPLATES.ORDER_NOT_FOUND);
    if (order.stage === 'completed') return R(TEMPLATES.RETAIL_COLLECTION_READY, { reference: order.reference });
    const { percent } = getStageProgress(order.stage);
    return R(TEMPLATES.RETAIL_COLLECTION_NOT_READY, { reference: order.reference, stage: order.stage, percent });
  }

  // ── Keyword shortcuts ─────────────────────────────────────────────────────
  // Disabled during active data-collection states — the user's free text is
  // content, not a navigation command (e.g. "embroidered" in a quotation
  // description must not trigger the branding shortcut).
  const DATA_COLLECTION_STATES = new Set([
    'quotation_requested',
    'ticket_description',
    'registration_name', 'registration_org_or_school', 'registration_address',
    'corporate_uniform_garment', 'corporate_uniform_sizes',
    'corporate_uniform_branding', 'corporate_uniform_quantity',
    'corporate_po_quotation_ref', 'corporate_po_number',
  ]);

  if (intent.type === 'keyword' && !DATA_COLLECTION_STATES.has(state)) {
    if (intent.value === 'track') {
      await updateState(convo.id, 'retail_collection');
      return R(TEMPLATES.RETAIL_COLLECTION_ASK);
    }
    if (intent.value === 'hours') return R(TEMPLATES.RETAIL_HOURS);
    if (intent.value === 'layby') return R(TEMPLATES.RETAIL_LAYBY);
    if (intent.value === 'branding') return R(TEMPLATES.BRANDING_INFO);
    if (intent.value === 'store')   return R(TEMPLATES.STORE_INFO);
    if (intent.value === 'quote') {
      return gateOrProceed(client, convo, 'quotation_requested', R, updateState, async () => {
        await updateState(convo.id, 'quotation_requested');
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      });
    }
    if (intent.value === 'po') {
      await updateState(convo.id, 'corporate_po_quotation_ref');
      return R(TEMPLATES.PO_ASK_QUOTATION_REF);
    }
    if (intent.value === 'ticket') {
      await updateState(convo.id, 'ticket_category');
      return R(TEMPLATES.TICKET_ASK_CATEGORY);
    }
  }

  // ── Design approval reply takes priority while it's pending ───────────────
  if (state === 'corporate_design_approval') {
    return handleDesignApprovalReply(body, convo, R, updateState);
  }

  // ── If consultant is active — don't interfere ─────────────────────────────
  if (state === 'consultant_active' || state === 'awaiting_consultant') {
    // Message already saved — consultant sees it in inbox
    logger.info('Message routed to consultant inbox', { conversationId: convo.id });
    return;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  switch (state) {

    case 'new':
    case 'main_menu':
      if (intent.type === 'menu') {
        return handleMainMenuSelection(intent.value, phoneNumber, convo, client, R, updateState);
      }
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.MAIN_MENU);

    case 'retail_menu':
      if (intent.type === 'menu') {
        return handleRetailMenuSelection(intent.value, phoneNumber, convo, client, R, updateState);
      }
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'our team' });

    case 'retail_school_select': {
      const schools = convo.context.schoolList || [];
      const num = parseInt(body.trim());
      if (!isNaN(num) && num >= 1 && num <= schools.length) {
        const selectedSchool = schools[num - 1];
        const uniforms = await listUniformsForSchool(selectedSchool);
        await updateState(convo.id, 'retail_menu');
        if (!uniforms.length) {
          return R(TEMPLATES.RETAIL_SCHOOL_PENDING, { schoolName: selectedSchool });
        }
        return R(TEMPLATES.RETAIL_SCHOOL_UNIFORMS, { schoolName: selectedSchool, uniforms });
      }
      return R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
    }

    case 'retail_pricing':
    case 'retail_layby':
      return tryAnswerFaq(body, convo, R, updateState);

    case 'retail_size_availability':
      return handleSizeQuery(body, convo, R);

    case 'retail_collection':
      // Expecting an order reference
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.ORDER_NOT_FOUND);

    case 'corporate_menu':
      if (intent.type === 'menu') {
        return handleCorporateMenuSelection(intent.value, phoneNumber, convo, client, R, updateState);
      }
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });

    case 'corporate_new_order':
      // Legacy state — redirect to consultant
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });

    case 'quotation_requested':
      return handleQuotationGathering(body, convo, client, phoneNumber, R, updateState);

    case 'corporate_repeat_order':
    case 'corporate_manufacturing_update':
    case 'corporate_delivery_schedule':
      // Expecting an order reference — not one yet, ask again
      return R(TEMPLATES.ORDER_NOT_FOUND);

    case 'corporate_uniform_garment':
      await updateState(convo.id, 'corporate_uniform_sizes', { uniformIntake: { garment: body } });
      return R(TEMPLATES.UNIFORM_INTAKE_SIZES);

    case 'corporate_uniform_sizes':
      await updateState(convo.id, 'corporate_uniform_branding', {
        uniformIntake: { ...(convo.context.uniformIntake || {}), sizes: body },
      });
      return R(TEMPLATES.UNIFORM_INTAKE_BRANDING);

    case 'corporate_uniform_branding':
      await updateState(convo.id, 'corporate_uniform_quantity', {
        uniformIntake: { ...(convo.context.uniformIntake || {}), branding: body },
      });
      return R(TEMPLATES.UNIFORM_INTAKE_QUANTITY);

    case 'corporate_uniform_quantity':
      return completeUniformIntake(body, convo, client, R, updateState);

    case 'corporate_po_quotation_ref':
      await updateState(convo.id, 'corporate_po_number', { poQuotationRef: body.trim().toUpperCase() });
      return R(TEMPLATES.PO_ASK_NUMBER);

    case 'corporate_po_number':
      return submitPo(body, convo, client, R, updateState);

    case 'ticket_category': {
      const categoryMap = { '1': 'wrong_item', '2': 'defective', '3': 'missing_item', '4': 'other' };
      const category = categoryMap[body.trim()] || 'other';
      await updateState(convo.id, 'ticket_description', { ticketCategory: category });
      return R(TEMPLATES.TICKET_ASK_DESCRIPTION);
    }

    case 'ticket_description': {
      const description = body.trim();
      if (description.length < 30) {
        return R(TEMPLATES.TICKET_NEEDS_MORE_DETAIL);
      }
      await createTicket({
        clientId: client.id,
        category: convo.context.ticketCategory || 'other',
        description,
      });
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.TICKET_LOGGED);
    }

    case 'registration_name':
      await updateClientProfile(client.id, { name: body });
      await updateState(convo.id, 'registration_org_or_school');
      return R(TEMPLATES.REGISTRATION_ASK_ORG_OR_SCHOOL, { clientType: client.client_type });

    case 'registration_org_or_school': {
      const isRetailLike = ['retail', 'school'].includes(client.client_type);
      await updateClientProfile(client.id, isRetailLike ? { schoolName: body } : { organisation: body });
      await updateState(convo.id, 'registration_address');
      return R(TEMPLATES.REGISTRATION_ASK_ADDRESS, { clientType: client.client_type });
    }

    case 'registration_address': {
      const isRetailLike = ['retail', 'school'].includes(client.client_type);
      await updateClientProfile(client.id, isRetailLike ? { preferredStoreLocation: body } : { physicalAddress: body });
      await R(TEMPLATES.REGISTRATION_COMPLETE);

      const pending = convo.context.pendingIntent;
      const resumeState = pending?.state;
      await updateState(convo.id, resumeState || 'main_menu', { pendingIntent: null });
      return R(RESUME_TEMPLATES[resumeState] || TEMPLATES.MAIN_MENU);
    }

    default:
      await updateState(convo.id, 'main_menu');
      return R(TEMPLATES.MAIN_MENU);
  }
}

// ── Main menu selection handler ───────────────────────────────────────────────
async function handleMainMenuSelection(option, phone, convo, client, R, updateState) {
  switch (option) {
    case 1:
      await updateState(convo.id, 'retail_menu');
      return R(TEMPLATES.RETAIL_MENU);
    case 2:
      await updateState(convo.id, 'corporate_menu');
      return R(TEMPLATES.CORPORATE_MENU);
    case 3:
      return gateOrProceed(client, convo, 'quotation_requested', R, updateState, async () => {
        await updateState(convo.id, 'quotation_requested');
        return R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: client.name });
      });
    case 4:
      await updateState(convo.id, 'retail_collection');
      return R(TEMPLATES.RETAIL_COLLECTION_ASK);
    case 5:
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });
    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}

// ── Retail menu selection handler ─────────────────────────────────────────────
async function handleRetailMenuSelection(option, phone, convo, client, R, updateState) {
  switch (option) {
    case 1: {
      const products = await listProducts({});
      await updateState(convo.id, 'retail_pricing');
      return R(TEMPLATES.RETAIL_PRODUCT_LIST, { products });
    }
    case 2: {
      // Always use the hardcoded canonical list; supplement with any extra DB schools
      const dbSchools = await listDistinctSchools();
      const extra = dbSchools.filter((s) => !SCHOOLS.includes(s));
      const schools = [...SCHOOLS, ...extra];
      await updateState(convo.id, 'retail_school_select', { schoolList: schools });
      return R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
    }
    case 3:
      return R(TEMPLATES.RETAIL_HOURS);
    case 4:
      await updateState(convo.id, 'retail_collection');
      return R(TEMPLATES.RETAIL_COLLECTION_ASK);
    case 5:
      await updateState(convo.id, 'retail_layby');
      return R(TEMPLATES.RETAIL_LAYBY);
    case 6:
      await updateState(convo.id, 'retail_size_availability');
      return R(TEMPLATES.RETAIL_SIZE_ASK);
    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}

// ── Corporate menu selection handler ──────────────────────────────────────────
async function handleCorporateMenuSelection(option, phone, convo, client, R, updateState) {
  switch (option) {
    case 1:
      await updateState(convo.id, 'corporate_repeat_order');
      return R(TEMPLATES.CORPORATE_REPEAT_ORDER_ASK);
    case 2:
      return gateOrProceed(client, convo, 'corporate_uniform_garment', R, updateState, async () => {
        await updateState(convo.id, 'corporate_uniform_garment');
        return R(TEMPLATES.UNIFORM_INTAKE_GARMENT);
      });
    case 3:
      await updateState(convo.id, 'corporate_manufacturing_update');
      return R(TEMPLATES.CORPORATE_MANUFACTURING_ASK);
    case 4:
      await updateState(convo.id, 'corporate_delivery_schedule');
      return R(TEMPLATES.CORPORATE_DELIVERY_ASK);
    case 5:
      await updateState(convo.id, 'awaiting_consultant');
      return R(TEMPLATES.CONSULTANT_ASSIGNED, { consultantName: 'a consultant' });
    default:
      return R(TEMPLATES.UNKNOWN_INTENT);
  }
}
