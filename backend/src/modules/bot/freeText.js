/**
 * Free text typed at a menu (main, school uniforms, bulk orders). Never just
 * re-sends the menu: greetings get the menu with the client's name, a school
 * name shows that school's uniforms, and anything else goes to the AI, which
 * routes it to a flow, answers it from our information, or hands a genuine
 * question to a consultant. Gibberish (or no AI) gets a short "didn't catch
 * that" with the options.
 */
import { TEMPLATES } from './templates.js';
import { routeFreeText } from '../../integrations/ai.client.js';
import { listProducts } from '../catalog/service.js';
import { hasLetters } from './intents.js';
import { startQuote } from './states/quote.js';
import { startOrder, startTracking } from './states/order.js';
import { startTicket } from './states/ticket.js';
import { requestConsultant } from './states/handoff.js';
import { findSchools, showSchool, showSchoolMatches } from './states/retail.js';

/** Worth handing to a person: a real question, not "asdf". */
const looksLikeQuestion = (text) => /\?\s*$/.test(text) || text.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length >= 4;

export function showMenuFor(c, where) {
  if (where === 'retail') { c.setState('retail_menu'); return c.R(TEMPLATES.RETAIL_MENU); }
  if (where === 'corporate') { c.setState('corporate_menu'); return c.R(TEMPLATES.CORPORATE_MENU); }
  c.setState('main_menu');
  return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name, welcomeBack: Boolean(c.welcomeBack) });
}

/** Run a flow the AI (or a school name) pointed to. */
async function route(c, intent, text, where) {
  switch (intent) {
    case 'quote':      return startQuote(c, { text });
    case 'order':      return startOrder(c, { text });
    case 'track':      return startTracking(c);
    case 'ticket':     return startTicket(c, { text });
    case 'consultant': return requestConsultant(c, `Asked: ${text}`);
    case 'hours':
    case 'store':      return c.R(TEMPLATES.STORE_INFO);
    case 'layby':      return c.R(TEMPLATES.RETAIL_LAYBY);
    case 'branding':   return c.R(TEMPLATES.BRANDING_INFO);
    case 'school_uniforms': {
      const matches = await findSchools(text);
      if (matches.length === 1) return showSchool(c, matches[0]);
      if (matches.length > 1) return showSchoolMatches(c, matches);
      c.setState('retail_menu', { parent: true });
      return c.R(TEMPLATES.RETAIL_MENU);
    }
    default:           return showMenuFor(c, where);
  }
}

/**
 * @param {object} c
 * @param {'main'|'retail'|'corporate'} where  the menu the client is at
 */
export async function handleFreeText(c, where = 'main') {
  const text = c.body.trim();
  if (c.intent.type === 'greeting') return showMenuFor(c, where);
  if (c.intent.type === 'thanks') return c.R(TEMPLATES.THANKS_REPLY, { name: c.client.name });
  if (!hasLetters(text)) return notUnderstood(c, where);

  // A school name typed at the main / school-uniform menu
  if (where !== 'corporate') {
    const matches = await findSchools(text);
    if (matches.length === 1) return showSchool(c, matches[0]);
    if (matches.length > 1 && where === 'retail') return showSchoolMatches(c, matches);
  }

  const products = await listProducts({ activeOnly: true });
  const r = await routeFreeText(text, {
    products,
    hoursText: TEMPLATES.RETAIL_HOURS(),
    laybyText: TEMPLATES.RETAIL_LAYBY(),
    storeText: TEMPLATES.STORE_INFO(),
  });
  if (r?.type === 'route') return route(c, r.intent, text, where);
  if (r?.type === 'answer') return c.R(TEMPLATES.FREE_TEXT_ANSWER, { text: r.text });
  if (r?.type === 'escalate' && looksLikeQuestion(text)) {
    return requestConsultant(c, `Question the bot could not answer: ${text}`, { reply: TEMPLATES.FAQ_ESCALATED });
  }
  return notUnderstood(c, where);
}

/** "Didn't catch that" with the main menu options (the client is put back at the main menu). */
function notUnderstood(c, where) {
  if (c.welcomeBack) return showMenuFor(c, where);
  if (where !== 'main') c.setState('main_menu');
  return c.R(TEMPLATES.UNKNOWN_INTENT);
}
