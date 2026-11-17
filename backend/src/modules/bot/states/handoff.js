// Hand-over to a human consultant: requesting one, and the bot's behaviour while
// a consultant owns the chat.
//
//  awaiting_consultant — the client's first message after the hand-over (and the
//    first one after 30 minutes without any reply) is acknowledged with our hours;
//    "9" says they are in the queue; "0" / "menu" / "cancel" cancels the request.
//  consultant_active — the bot stays silent; only "0" / "menu" hands the chat back.
//  Both: "accept" still accepts the client's sent quote (owner decision 1).
import { TEMPLATES } from '../templates.js';
import { logger } from '../../../core/logger.js';
import { isWithinBusinessHours } from '../../../core/businessHours.js';
import { notifyConsultantRequested } from '../../notifications/service.js';
import { minutesSinceLastOutbound } from '../lookups.js';
import { acceptQuote } from './quote.js';

/** Re-acknowledge a waiting client after this long without any message from us. */
export const ACK_AGAIN_AFTER_MINUTES = 30;

/** Client asks for a consultant → awaiting_consultant + staff email. */
export function requestConsultant(c, context = 'General enquiry', { reply = TEMPLATES.AWAITING_CONSULTANT } = {}) {
  c.setState('awaiting_consultant', { ackPending: true, pending: null });
  c.notify(notifyConsultantRequested, c.convo, c.client, context);
  return c.R(reply, { withinHours: isWithinBusinessHours() });
}

export async function consultantState(c) {
  const { intent, state } = c;

  // A sent, valid quote can be accepted at any time — also mid-chat with staff.
  if (intent.type === 'accept') return acceptQuote(c);

  if (state === 'awaiting_consultant') {
    if (intent.type === 'main_menu') {
      c.setState('main_menu', { ackPending: null });
      return c.R(TEMPLATES.CONSULTANT_CANCELLED);
    }
    if (intent.type === 'consultant') return c.R(TEMPLATES.CONSULTANT_QUEUE);

    const minutes = await minutesSinceLastOutbound(c.convo.id);
    if (c.convo.context.ackPending || minutes == null || minutes >= ACK_AGAIN_AFTER_MINUTES) {
      c.setState('awaiting_consultant', { ackPending: false });
      return c.R(TEMPLATES.CONSULTANT_ACK, { withinHours: isWithinBusinessHours() });
    }
    logger.info('Message queued for consultant', { conversationId: c.convo.id });
    return;
  }

  // consultant_active: a person is chatting — only an explicit "0" / "menu" leaves.
  if (intent.type === 'main_menu' && /^(0|menu|main menu)\b/.test(intent.word)) {
    c.setState('main_menu');
    return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name });
  }
  logger.info('Message queued for consultant', { conversationId: c.convo.id });
}
