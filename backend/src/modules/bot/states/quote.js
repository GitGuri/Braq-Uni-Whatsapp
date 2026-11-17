// Quotation flow: describe → AI gathering → draft (auto-sent when every item
// matched the catalog, else handed to a consultant for pricing); the client
// accepting a sent quotation ("accept" / "accept BRQ-Q-…", in any state — the
// order itself is created by staff, owner decision 1); quote status / resend;
// changes to a sent quote; refreshing an expired one.
import { query } from '../../../core/db.js';
import { HttpError } from '../../../core/errors.js';
import { TEMPLATES, fmtDate } from '../templates.js';
import { gather } from '../gathering.js';
import { carriesDetail } from '../intents.js';
import { gateOrProceed } from './registration.js';
import { findQuote, latestSentQuote, quoteStatus } from '../lookups.js';
import {
  createFromFreeText, autoApproveQuotation, acceptQuotationByClient, resendQuotation,
} from '../../quotations/service.js';
import {
  notifyNewQuotation, notifyConsultantRequested, notifyQuotationAccepted, notifyQuoteRevisionRequested,
} from '../../notifications/service.js';

const QUOTE_CONTEXT_RESET = { quotationHistory: null, quotationFollowups: 0 };

/**
 * Start a quotation request (registration first when details are missing).
 * text: the message that asked for the quote — when it already describes the
 * items ("a quote for 30 Dalview jerseys") it becomes the request itself.
 */
export function startQuote(c, { text = null } = {}) {
  const detail = text && carriesDetail(text) ? text : null;
  return gateOrProceed(c, { purpose: 'quote', pendingIntent: 'quote', pendingText: detail },
    () => beginQuote(c, { text: detail }));
}

/** After the gate: gather from `text` straight away, or ask for a description. */
export function beginQuote(c, { text = null, thanks = false } = {}) {
  if (text) return quoteGathering(c, { text, fresh: true });
  c.setState('quotation_ask_description', { quotationHistory: [], quotationFollowups: 0 });
  return c.R(TEMPLATES.QUOTATION_ASK_DESCRIPTION, { name: c.client.name, clientType: c.client.client_type, thanks });
}

/** quotation_ask_description / quotation_gathering */
export function quoteGathering(c, { text = null, fresh = false } = {}) {
  return gather(c, {
    state: 'quotation_gathering',
    historyKey: 'quotationHistory',
    followupsKey: 'quotationFollowups',
    finalise: finaliseQuotation,
    text,
    fresh,
  });
}

/**
 * Create the quotation from the consolidated request. fromOrder: the client was
 * ordering but asked for items outside the catalogue — the order becomes a quote.
 */
export async function finaliseQuotation(c, consolidatedText, { fromOrder = false } = {}) {
  const { quotation, unmatchedText, replayed } = await createFromFreeText(c.client.id, consolidatedText, {
    conversationId: c.convo.id, sourceEventId: c.turn.eventId,
  });

  // Replay of a turn whose quote already went out automatically: nothing more to do.
  if (replayed && quotation.status !== 'draft') {
    c.setState('main_menu', { ...QUOTE_CONTEXT_RESET, orderHistory: null, orderFollowups: 0 });
    return;
  }

  // Auto-approve instantly when every item matched the catalog — no consultant needed.
  // Never on a replay: the original unmatched list is not stored, so a consultant checks it.
  const allCatalogMatched = !unmatchedText || unmatchedText.length === 0;
  const hasItems = Array.isArray(quotation.line_items) && quotation.line_items.length > 0;

  if (allCatalogMatched && hasItems && !replayed) {
    await autoApproveQuotation(quotation.id, quotation.line_items);
    c.setState('main_menu', { ...QUOTE_CONTEXT_RESET, orderHistory: null, orderFollowups: 0 });
    // The PDF is queued by autoApproveQuotation — no extra text needed
    return;
  }

  // Unmatched custom items — send to consultant for pricing
  c.setState('awaiting_consultant', { ...QUOTE_CONTEXT_RESET, orderHistory: null, orderFollowups: 0, ackPending: true });
  c.notify(notifyNewQuotation, quotation, c.client);
  c.notify(notifyConsultantRequested, c.convo, c.client, fromOrder ? 'Order with items outside the catalogue (quote request)' : 'Quotation enquiry');
  return c.R(TEMPLATES.QUOTATION_DRAFT_ACK, { reference: quotation.reference, unmatched: unmatchedText, fromOrder });
}

// ── Accepting a quote ─────────────────────────────────────────────────────────
/**
 * Client accepts a quotation ("accept" / "accept BRQ-Q-…"), in any state. The
 * quotation is marked accepted and staff are emailed; the order is created by
 * staff. An expired quote offers a refresh at today's prices instead.
 */
export async function acceptQuote(c) {
  const reference = c.intent.ref ?? null;
  const accepted = await acceptQuotationByClient(c.client.id, { reference });
  if (accepted) {
    c.notify(notifyQuotationAccepted, accepted, c.client);
    return c.R(TEMPLATES.QUOTE_ACCEPTED, { reference: accepted.reference });
  }
  const lapsed = await latestSentQuote(c.client.id, { reference });
  if (lapsed && quoteStatus(lapsed) === 'expired' && !lapsed.order_reference) {
    offerRefresh(c, lapsed);
    return c.R(TEMPLATES.QUOTE_EXPIRED, { reference: lapsed.reference, expiredOn: fmtDate(lapsed.expires_on) });
  }
  return c.R(TEMPLATES.NO_PENDING_QUOTE);
}

/** Remember that "1" now means "refresh this expired quote" (one message only). */
function offerRefresh(c, quotation) {
  c.setState(c.state, { pending: { kind: 'refresh_quote', quotationId: quotation.id, reference: quotation.reference } });
}

/** "1" after an expired quote: ask staff to revise it at today's prices. */
export async function requestQuoteRefresh(c, { quotationId, reference }) {
  const { rows } = await query('SELECT * FROM quotations WHERE id = $1 AND client_id = $2', [quotationId, c.client.id]);
  c.setState(c.state, { pending: null });
  if (!rows.length) return c.R(TEMPLATES.NO_QUOTES);
  c.notify(notifyQuoteRevisionRequested, rows[0], c.client, { kind: 'refresh' });
  return c.R(TEMPLATES.QUOTE_REFRESH_REQUESTED, { reference: rows[0].reference ?? reference });
}

// ── Quote status / resend ─────────────────────────────────────────────────────
/** "where is my quote" / "resend my quotation" / a typed BRQ-Q reference. */
export async function showQuoteStatus(c, { reference = null } = {}) {
  const q = await findQuote(c.client.id, { reference });
  if (!q) return c.R(reference ? TEMPLATES.ORDER_QUOTE_NOT_FOUND : TEMPLATES.NO_QUOTES);
  const status = quoteStatus(q);
  let resent = false;
  if (status === 'sent') {
    try {
      await resendQuotation(q.id, null);
      resent = true;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
    }
  }
  if (status === 'expired' && !q.order_reference) offerRefresh(c, q);
  return c.R(TEMPLATES.QUOTE_STATUS, {
    reference: q.reference,
    status,
    total: q.total,
    validUntil: fmtDate(q.expires_on),
    expiredOn: fmtDate(q.expires_on),
    orderReference: q.order_reference,
    resent,
  });
}

// ── Changes to a sent quote ───────────────────────────────────────────────────
/**
 * "changes" / "changes: make it 40 shirts" about the client's sent quote.
 * Returns false when there is no sent quote to change (caller carries on), true once handled.
 */
export async function startQuoteChanges(c, inlineText = null) {
  const q = await findQuote(c.client.id);
  if (!q || quoteStatus(q) !== 'sent') return false;
  if (inlineText && inlineText.trim().length >= 5) {
    await logQuoteChanges(c, { quotationId: q.id, notes: inlineText.trim() });
    return true;
  }
  c.setState(c.state, { pending: { kind: 'quote_changes', quotationId: q.id, reference: q.reference } });
  c.R(TEMPLATES.QUOTE_CHANGES_ASK, { reference: q.reference });
  return true;
}

export async function logQuoteChanges(c, { quotationId, notes }) {
  const { rows } = await query('SELECT * FROM quotations WHERE id = $1 AND client_id = $2', [quotationId, c.client.id]);
  c.setState(c.state, { pending: null });
  if (!rows.length) return c.R(TEMPLATES.NO_QUOTES);
  c.notify(notifyQuoteRevisionRequested, rows[0], c.client, { kind: 'changes', notes });
  return c.R(TEMPLATES.QUOTE_CHANGES_LOGGED, { reference: rows[0].reference });
}
