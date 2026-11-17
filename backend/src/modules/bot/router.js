/**
 * WhatsApp bot entry point: intent detection (intents.js) and dispatch to the
 * state handlers (states/*.js). Called by the 'inbound.process' job for every
 * stored inbound event (FIFO per sender), or directly by tests.
 *
 * Each inbound message is one turn (reply.js): handlers record replies, state
 * changes and staff notifications; the turn commits them in one transaction
 * (replies go out through the outbox). An unexpected error gets the customer a
 * short apology instead.
 *
 * Order of precedence for a text message:
 *   1. a one-message follow-up the bot asked for (context.pending: "Reply 1 to
 *      refresh", "Approve this design?", "What would you like to change?")
 *   2. consultant states (handoff.js): mostly silent; "accept" still works
 *   3. a conversation idle for 24 hours starts again at the main menu
 *      ("Welcome back, Thabo") unless the message itself asks for something
 *   4. escapes: "0"/"menu"/"cancel", "back", "9"/"agent" — inside data
 *      collection only the words (a bare "9" answering "how many?" is data)
 *   5. "accept" (any state, before the "quote" keyword), references, quote
 *      status, quote changes / proof answers, keyword shortcuts
 *   6. the state's own handler
 */
import { logger } from '../../core/logger.js';
import { TEMPLATES } from './templates.js';
import { createTurn, handlerContext } from './reply.js';
import {
  CONSULTANT_STATES, PARENT_STATE, PARENT_TEMPLATE, DATA_COLLECTION_STATES,
  getSetting, getOrCreateConversation, isDuplicateMessage, lastOutboundBody,
} from './state.js';
import { detectIntent, CONFIRM_RE, DECLINE_RE } from './intents.js';
import { isValidName, tidyName } from './profile.js';
import { isStaleConversation } from './lookups.js';
import { getOrCreateClientByWhatsapp, updateClientProfile } from '../clients/service.js';
import { isWithinBusinessHours } from '../../core/businessHours.js';
import { notifyMediaReceived } from '../notifications/service.js';
import * as menu from './states/menu.js';
import * as retail from './states/retail.js';
import * as corporate from './states/corporate.js';
import * as quote from './states/quote.js';
import * as order from './states/order.js';
import * as proof from './states/proof.js';
import * as ticket from './states/ticket.js';
import * as registration from './states/registration.js';
import * as handoff from './states/handoff.js';

export { detectIntent };

// ── State → handler ──────────────────────────────────────────────────────────
const STATE_HANDLERS = {
  main_menu:                   menu.mainMenu,
  retail_menu:                 retail.retailMenu,
  retail_pricing:              retail.retailMenu,
  retail_hours:                retail.retailMenu,
  retail_layby:                retail.retailMenu,
  retail_school_select:        retail.retailSchoolSelect,
  retail_size_ask:             retail.retailSizeAsk,
  retail_collection_ask:       retail.retailCollectionAsk,
  order_tracking_ask:          order.orderTrackingAsk,
  corporate_menu:              corporate.corporateMenu,
  corporate_repeat_order_ask:  corporate.corporateRepeatOrderAsk,
  corporate_manufacturing_ask: corporate.corporateRefAsk,
  corporate_delivery_ask:      corporate.corporateRefAsk,
  corporate_account_query:     corporate.corporateAccountQuery,
  quotation_ask_description:   (c) => quote.quoteGathering(c),
  quotation_gathering:         (c) => quote.quoteGathering(c),
  order_ask_method:            order.orderAskMethod,
  order_ask_reference:         order.orderAskReference,
  order_gathering:             (c) => order.orderGathering(c),
  order_confirm_quote:         order.orderConfirmQuote,
  order_confirm_direct:        order.orderConfirmDirect,
  proof_review:                proof.proofReview,
  proof_revision_describe:     proof.proofRevisionDescribe,
  ticket_ask_category:         ticket.ticketAskCategory,
  ticket_ask_description:      ticket.ticketAskDescription,
  registration_name:           registration.registrationReply,
  registration_org_or_school:  registration.registrationReply,
  registration_address:        registration.registrationReply,
};

// Keyword shortcuts (outside data-collection states). Those that start a flow
// keep the message, so "I need a quote for 30 jerseys" is the request itself.
const KEYWORD_HANDLERS = {
  track:      order.startTracking,
  hours:      (c) => c.R(TEMPLATES.RETAIL_HOURS),
  layby:      (c) => c.R(TEMPLATES.RETAIL_LAYBY),
  branding:   (c) => c.R(TEMPLATES.BRANDING_INFO),
  store:      (c) => c.R(TEMPLATES.STORE_INFO),
  quote:      (c) => quote.startQuote(c, { text: c.body }),
  ticket:     (c) => ticket.startTicket(c, { text: c.body }),
  make_order: (c) => order.startOrder(c, { text: c.body }),
};

/** Confirmation screens: "yes" / "go ahead" / "accept" there confirm the order on screen. */
const CONFIRM_STATES = new Set(['order_confirm_quote', 'order_confirm_direct', 'order_ask_method']);

/** States a stale (24 h) conversation is not pulled out of. */
const STALE_EXEMPT = new Set(['proof_review', 'proof_revision_describe']);

/** A pending one-message prompt older than this is ignored. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// Busy-mode / outside-hours notice, sent once when a conversation is opened
async function firstContactAck(turn) {
  const busyMode = await getSetting('busy_mode');
  if (busyMode === 'true') turn.reply(TEMPLATES.HIGH_VOLUME_NOTICE);
  else if (!isWithinBusinessHours()) turn.reply(TEMPLATES.OUTSIDE_HOURS_ACK);
}

/**
 * SLA reminder: tell the client once that a draft quotation past its reminder
 * time is still being finalised. Runs inside the commit (claims the quotation
 * row so it is reminded exactly once); a failure never sinks the turn.
 */
function overdueQuotationReminder(turn) {
  turn.onCommit(async (tx) => {
    await tx.query('SAVEPOINT sla_reminder');
    try {
      const { rows } = await tx.query(
        `UPDATE quotations SET reminder_sent_at = NOW()
         WHERE id = (SELECT id FROM quotations
                     WHERE client_id = $1 AND status = 'draft'
                       AND sla_remind_at <= NOW() AND reminder_sent_at IS NULL
                     ORDER BY sla_remind_at ASC LIMIT 1
                     FOR UPDATE SKIP LOCKED)
         RETURNING id, reference`,
        [turn.client.id]
      );
      if (rows.length) {
        await turn.queueReply(tx, TEMPLATES.OVERDUE_QUOTE_REMINDER({ name: turn.client.name, reference: rows[0].reference }));
        logger.info('Queued overdue quotation reminder', { clientId: turn.client.id, quotationId: rows[0].id });
      }
      await tx.query('RELEASE SAVEPOINT sla_reminder');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT sla_reminder');
      logger.warn('SLA reminder check failed', { error: err.message });
    }
  });
}

/** Run one turn: process(turn) records what to do, then it is committed (or apologised for). */
async function runTurn(turn, process) {
  try {
    await process(turn);
    await turn.commit();
  } catch (err) {
    await turn.fail(err);
  }
}

/**
 * The client, with the WhatsApp profile name as their name when we have none
 * (so registration only asks for what is really missing).
 */
async function loadClient(phone, profileName) {
  const client = await getOrCreateClientByWhatsapp(phone);
  if (!String(client.name ?? '').trim() && profileName && isValidName(profileName)) {
    try {
      return await updateClientProfile(client.id, { name: tidyName(profileName).slice(0, 200) });
    } catch (err) {
      logger.warn('Could not store the WhatsApp profile name', { clientId: client.id, error: err.message });
    }
  }
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text messages
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {{ phoneNumber: string, metaMessageId?: string, body: string, eventId?: number, profileName?: string }} msg
 * eventId: the inbound_events row — marked processed in the same transaction.
 * profileName: the sender's WhatsApp profile name (webhook contacts[].profile.name).
 */
export async function handleInbound({ phoneNumber, metaMessageId = null, body, eventId = null, profileName = null }) {
  const turn = createTurn({ phoneNumber, metaMessageId, eventId });
  return runTurn(turn, (t) => processInbound(t, body || '', profileName));
}

/** Follow-up the bot asked for in its previous message. true = handled. */
async function handlePending(c, pending) {
  const t = c.body.trim();
  switch (pending.kind) {
    case 'refresh_quote':
      if (CONFIRM_RE.test(t)) { await quote.requestQuoteRefresh(c, pending); return true; }
      return false;
    case 'proof_confirm':
      return proof.proofConfirmReply(c, pending);
    case 'quote_changes':
      if (DECLINE_RE.test(t) || c.intent.type === 'main_menu') return false;
      if (t.length >= 5 && c.intent.type !== 'consultant') {
        await quote.logQuoteChanges(c, { quotationId: pending.quotationId, notes: t });
        return true;
      }
      return false;
    default:
      return false;
  }
}

/** "changes" / "changes: …" about a waiting proof or the client's sent quote. true = handled. */
async function changesOrProof(c) {
  if (await proof.globalProofReply(c)) return true;
  const m = /^(?:changes?|edits?|amend(?:ments?)?|revise|revision|i (?:want|need|would like) (?:to make )?(?:some )?changes?)\b(?:\s*please)?\s*[:\-–—,]?\s*(.*)$/is.exec(c.body.trim());
  if (!m) return false;
  return quote.startQuoteChanges(c, m[1] || null);
}

async function processInbound(turn, body, profileName) {
  logger.info('Handling inbound message', { phoneNumber: turn.phone, body: body?.slice(0, 80) });

  // Meta retries: already processed → skip silently (no error, no second reply)
  if (await isDuplicateMessage(turn.metaMessageId)) {
    logger.debug('Duplicate inbound message skipped', { metaMessageId: turn.metaMessageId });
    return turn.skip();
  }

  const client = await loadClient(turn.phone, profileName);
  const { conversation: convo, isNew } = await getOrCreateConversation(client.id);
  convo.context = convo.context || {};
  const stale = !isNew && !STALE_EXEMPT.has(convo.state) && !CONSULTANT_STATES.has(convo.state)
    && await isStaleConversation(convo.id);
  turn.bind(convo, client, body);

  let state = convo.state;
  const intent = detectIntent(body);
  const c = handlerContext(turn, { body, intent, state });

  // First-contact acknowledgement (new conversation)
  if (isNew) await firstContactAck(turn);

  // Overdue quotation reminder — not while a human is mid-chat
  if (state !== 'consultant_active') overdueQuotationReminder(turn);

  // 1. A one-message follow-up the bot asked for
  const pending = convo.context.pending;
  if (pending && typeof pending === 'object') {
    const fresh = !pending.at || Date.now() - new Date(pending.at).getTime() < PENDING_TTL_MS;
    if (fresh && !stale && await handlePending(c, pending)) return;
    c.setState(state, { pending: null });
  }

  // 2. Consultant hand-over (handoff.js)
  if (CONSULTANT_STATES.has(state)) return handoff.consultantState(c);

  // 3. Idle for 24 hours: start again at the main menu, unless the message asks for something
  if (stale) {
    c.setState('main_menu', { pending: null, quotationHistory: null, orderHistory: null, pendingOrderItems: null, trackList: null });
    state = 'main_menu';
    c.welcomeBack = true;
    if (['greeting', 'thanks', 'menu', 'main_menu', 'back'].includes(intent.type)) {
      return menu.showMainMenu(c, { welcomeBack: true });
    }
  }

  const inDataState = DATA_COLLECTION_STATES.has(state);
  const ownsNumber = retail.ownsNumber(c, body.trim()) || order.ownsTrackingNumber(c, body.trim());

  // 4. Escapes
  if (intent.type === 'main_menu') return menu.showMainMenu(c);

  if (intent.type === 'back') {
    const parentState = PARENT_STATE[state] ?? 'main_menu';
    const templateGetter = PARENT_TEMPLATE[parentState] ?? ((T) => T.MAIN_MENU);
    c.setState(parentState);
    return c.R(templateGetter(TEMPLATES), { name: client.name });
  }

  if (intent.type === 'consultant' && !ownsNumber && (!inDataState || intent.exact)) {
    return handoff.requestConsultant(c, 'General enquiry');
  }

  // 5. Accept (any state — before the "quote" keyword: "accept the quote" is not a new quote)
  if (intent.type === 'accept' && !CONFIRM_STATES.has(state)) return quote.acceptQuote(c);

  // Order/quotation reference typed — route based on state and ref type
  if (intent.type === 'order_ref') {
    if (intent.value.startsWith('BRQ-Q-')) {
      if (['order_ask_reference', 'order_ask_method', 'order_gathering'].includes(state)) {
        return order.orderQuoteRefLookup(c, intent.value);
      }
      const { findQuote } = await import('./lookups.js');
      if (await findQuote(client.id, { reference: intent.value })) return quote.showQuoteStatus(c, { reference: intent.value });
    }
    return order.trackOrder(c, intent.value);
  }

  if (!inDataState && !CONFIRM_STATES.has(state)) {
    if (intent.type === 'quote_status') return quote.showQuoteStatus(c);
    if (await changesOrProof(c)) return;
    if (intent.type === 'keyword') {
      const handler = KEYWORD_HANDLERS[intent.value];
      if (handler) return handler(c);
    }
  }

  // 6. State machine
  const handler = STATE_HANDLERS[state];
  if (handler) return handler(c);
  return menu.mainMenu(c);
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-text messages (photos, voice notes, documents, …)
// ─────────────────────────────────────────────────────────────────────────────
// The bot only understands text, but the attachment must not vanish: a placeholder
// is stored on the conversation (unread) so staff see it in the inbox, staff are
// emailed (e.g. a proof of payment), and photos sent while reporting a problem
// are linked to the ticket.
const MEDIA_REPLY_TYPES = new Set(['image', 'video', 'audio', 'document']);

export function mediaPlaceholder(type, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const caption = typeof p.caption === 'string' && p.caption.trim() ? ` ${p.caption.trim()}` : '';
  switch (type) {
    case 'image':    return `[image received]${caption}`;
    case 'video':    return `[video received]${caption}`;
    case 'audio':    return p.voice ? '[voice note received]' : '[audio received]';
    case 'document': return `[document received${typeof p.filename === 'string' && p.filename ? `: ${p.filename}` : ''}]${caption}`;
    case 'sticker':  return '[sticker received]';
    case 'location': {
      const where = [p.name, p.address].filter((v) => typeof v === 'string' && v).join(', ');
      const coords = p.latitude != null && p.longitude != null ? `${p.latitude}, ${p.longitude}` : '';
      const detail = [where, coords].filter(Boolean).join(' — ');
      return `[location shared${detail ? `: ${detail}` : ''}]`;
    }
    case 'contacts': return '[contact card received]';
    default:         return `[${type} received]`;
  }
}

export async function handleInboundMedia({ phoneNumber, metaMessageId = null, type, payload, eventId = null, profileName = null }) {
  const turn = createTurn({ phoneNumber, metaMessageId, eventId });
  return runTurn(turn, (t) => processInboundMedia(t, type, payload, profileName));
}

/** The ticket a photo belongs to: one just logged (within ATTACH_WINDOW_MINUTES) in this chat. */
function recentTicket(convo) {
  const ctx = convo.context || {};
  if (!ctx.ticketId || !ctx.ticketAt) return null;
  const age = Date.now() - new Date(ctx.ticketAt).getTime();
  return age >= 0 && age <= ticket.ATTACH_WINDOW_MINUTES * 60 * 1000 ? { id: ctx.ticketId, no: ctx.ticketNo } : null;
}

async function processInboundMedia(turn, type, payload, profileName) {
  logger.info('Handling inbound media message', { phoneNumber: turn.phone, type });

  if (await isDuplicateMessage(turn.metaMessageId)) return turn.skip();

  const client = await loadClient(turn.phone, profileName);
  const { conversation: convo, isNew } = await getOrCreateConversation(client.id);
  convo.context = convo.context || {};
  const placeholder = mediaPlaceholder(type, payload);
  turn.bind(convo, client, placeholder);
  const mediaId = payload && typeof payload.id === 'string' ? payload.id : null;
  const linkedTicket = MEDIA_REPLY_TYPES.has(type) ? recentTicket(convo) : null;
  turn.inboundExtra = { mediaId, ticketId: linkedTicket?.id ?? null };

  // Photos for a ticket being reported (linked when it is logged) or just logged
  if (MEDIA_REPLY_TYPES.has(type) && (linkedTicket || convo.state === 'ticket_ask_description' || convo.state === 'ticket_ask_category')) {
    const lastBody = await lastOutboundBody(convo.id);
    const notice = linkedTicket ? TEMPLATES.TICKET_PHOTO_ADDED({ ticketNo: linkedTicket.no }) : TEMPLATES.TICKET_PHOTO_BEFORE_LOG();
    if (lastBody !== notice) {
      turn.reply(() => notice);
      if (linkedTicket) turn.notify(notifyMediaReceived, convo, client, { placeholder, ticketNo: linkedTicket.no });
    }
    return;
  }

  // A consultant is handling the chat — they'll see the attachment; bot stays silent
  if (CONSULTANT_STATES.has(convo.state)) return;
  if (!MEDIA_REPLY_TYPES.has(type)) return;

  if (isNew) await firstContactAck(turn);

  // Several photos in a row → explain once (and email staff once), not once per photo
  // (queued replies are recorded in messages too, so a notice still waiting to go out counts)
  if (await lastOutboundBody(convo.id) === TEMPLATES.MEDIA_RECEIVED()) return;
  turn.reply(TEMPLATES.MEDIA_RECEIVED);
  turn.notify(notifyMediaReceived, convo, client, { placeholder });
}
