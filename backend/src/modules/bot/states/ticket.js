// Support tickets from WhatsApp. The category is read from the message that
// raised the problem ("my shirts arrived damaged" → defective; the AI when the
// words don't say), and a detailed first message is the description — so most
// problems are logged in one step. The client gets the ticket number and the
// response time; photos sent while reporting (and just after) are linked to the
// ticket. Also used by the corporate "account query" option.
import { TEMPLATES } from '../templates.js';
import { classifyTicketCategory } from '../../../integrations/ai.client.js';
import { createTicket, findOrderForTicket } from '../../tickets/service.js';
import { notifyNewTicket, notifyConsultantRequested } from '../../notifications/service.js';

const CATEGORY_BY_OPTION = { '1': 'wrong_item', '2': 'defective', '3': 'missing_item', '4': 'other' };

/** Minimum length of a usable problem description. */
export const MIN_DESCRIPTION = 10;

/** Photos sent within this many minutes after the ticket is logged are added to it. */
export const ATTACH_WINDOW_MINUTES = 30;

const CATEGORY_RULES = [
  ['wrong_item',    /\bwrong\b|\bincorrect\b|\bnot (what|the one) i (ordered|asked)|\bdifferent (size|colour|color|item)|instead of\b|\bswapped\b/i],
  ['missing_item',  /\bmissing\b|\bnot (in|inside) the (parcel|box|bag)|\bshort(-|\s)?(delivered|supplied)|\bdidn'?t (get|receive)|\bonly (got|received)\b/i],
  ['defective',     /defect|faulty|damaged|broken|torn|\btear\b|\brip(ped)?\b|split|stain|\bhole\b|fad(ed|ing)|shrunk|poor quality|loose thread|\bseam/i],
  ['account_query', /\binvoice|\bstatement\b|\bpayment\b|\brefund\b|\bcredit note\b|\baccount\b|\bvat\b|\bbilled?\b|\bcharged\b/i],
];

/** Category the words make clear, or null. */
export function inferCategory(text) {
  const t = String(text ?? '');
  for (const [category, re] of CATEGORY_RULES) if (re.test(t)) return category;
  return null;
}

const GENERIC_RE = /^(hi|hello|hey|good (morning|afternoon|day))?[\s,!.]*((i|we)\s+(have|want to (make|log|report|lay)|need to (make|log|report)|would like to (make|log|report|lay))\s+)?(a\s+)?(complaint|problem|issue|query|complain|report a problem|report|ticket)s?[\s.!]*(please)?[\s.!]*$/i;

/** Detailed enough to be the ticket description (not just "I have a complaint"). */
export function isDetailed(text) {
  const t = String(text ?? '').trim();
  return t.length >= MIN_DESCRIPTION && !GENERIC_RE.test(t) && /\p{L}{3,}/u.test(t);
}

/** Short ticket number shown to the client (and searchable by staff): first 8 hex digits of the id. */
export const ticketNo = (ticket) => String(ticket?.id ?? '').replace(/-/g, '').slice(0, 8).toUpperCase();

/**
 * Start reporting a problem. text: the message that raised it — logged straight
 * away when it is detailed; otherwise the bot asks only for what is missing.
 */
export async function startTicket(c, { text = null } = {}) {
  const startedAt = new Date().toISOString();
  const description = text && isDetailed(text) ? text.trim() : null;
  let category = text ? inferCategory(text) : null;
  if (description) {
    if (!category) category = await classifyTicketCategory(description);
    await logTicket(c, { category, description, startedAt });
    return c.R(TEMPLATES.TICKET_LOGGED, { ticketNo: c.turn.lastTicketNo });
  }
  if (category) {
    c.setState('ticket_ask_description', { ticketCategory: category, ticketStartedAt: startedAt });
    return c.R(TEMPLATES.TICKET_ASK_DESCRIPTION);
  }
  c.setState('ticket_ask_category', { ticketCategory: null, ticketStartedAt: startedAt });
  return c.R(TEMPLATES.TICKET_ASK_CATEGORY);
}

/**
 * Log a ticket about `description`, hand the chat to a consultant and email
 * the consultants. Attachments the client sent since `startedAt` in this chat
 * are linked to the ticket. The caller sends its own confirmation; the ticket
 * number is left on turn.lastTicketNo.
 */
export async function logTicket(c, { category, description, startedAt = null }) {
  const linkedOrder = await findOrderForTicket(c.client.id, description);
  const ticket = await createTicket({
    clientId: c.client.id,
    orderId:  linkedOrder?.id,
    category,
    description,
  });
  const no = ticketNo(ticket);
  c.turn.lastTicketNo = no;
  c.setState('awaiting_consultant', {
    ticketId: ticket.id, ticketNo: no, ticketAt: new Date().toISOString(),
    ticketCategory: null, ticketStartedAt: null, ackPending: true,
  });
  const since = startedAt || c.convo.context.ticketStartedAt;
  if (since) {
    c.turn.onCommit((tx) => tx.query(
      `UPDATE messages SET ticket_id = $1
       WHERE conversation_id = $2 AND direction = 'inbound' AND ticket_id IS NULL
         AND created_at >= $3::timestamptz AND body LIKE '[%'`,
      [ticket.id, c.convo.id, since]
    ));
  }
  c.notify(notifyNewTicket, ticket, c.client, linkedOrder?.reference ?? null);
  c.notify(notifyConsultantRequested, c.convo, c.client, `Ticket #${no}: ${description}`);
  return ticket;
}

export async function ticketAskCategory(c) {
  const option = c.body.trim();
  const category = CATEGORY_BY_OPTION[option] || null;
  if (category) {
    c.setState('ticket_ask_description', { ticketCategory: category });
    return c.R(TEMPLATES.TICKET_ASK_DESCRIPTION);
  }
  // Described the problem instead of picking a number
  if (isDetailed(option)) {
    const inferred = inferCategory(option) || await classifyTicketCategory(option);
    await logTicket(c, { category: inferred, description: option });
    return c.R(TEMPLATES.TICKET_LOGGED, { ticketNo: c.turn.lastTicketNo });
  }
  return c.R(TEMPLATES.TICKET_ASK_CATEGORY);
}

export async function ticketAskDescription(c) {
  const description = c.body.trim();
  if (!isDetailed(description)) return c.R(TEMPLATES.TICKET_NEEDS_MORE_DETAIL);
  let category = c.convo.context.ticketCategory;
  if (!category) category = inferCategory(description) || await classifyTicketCategory(description);
  else if (category === 'other') category = inferCategory(description) || 'other';
  await logTicket(c, { category, description });
  return c.R(TEMPLATES.TICKET_LOGGED, { ticketNo: c.turn.lastTicketNo });
}
