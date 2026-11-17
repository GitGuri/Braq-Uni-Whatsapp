// Main menu: 1 School uniforms (parents) · 2 Bulk orders (schools/companies) ·
// 3 Get a quote · 4 Place an order · 5 Track my order · 6 Report a problem ·
// 7 Store hours & location · 9 Talk to a person (router) · 0 this menu.
// "8" still reaches a person (the old menu numbered it so).
import { TEMPLATES } from '../templates.js';
import { updateClientProfile } from '../../clients/service.js';
import { looksLikeSchool } from '../profile.js';
import { startQuote } from './quote.js';
import { startOrder, startTracking } from './order.js';
import { startTicket } from './ticket.js';
import { requestConsultant } from './handoff.js';
import { handleFreeText } from '../freeText.js';

export function showMainMenu(c, { welcomeBack = false } = {}) {
  c.setState('main_menu', { pending: null });
  return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name, welcomeBack });
}

/** Bulk orders: a retail client with a known school / company becomes a school or corporate client. */
async function markBulkClient(c) {
  const org = c.client.organisation || c.client.school_name;
  if (c.client.client_type !== 'retail' || !org || org === 'N/A') return;
  const updated = await updateClientProfile(c.client.id, { client_type: looksLikeSchool(org) ? 'school' : 'corporate' });
  Object.assign(c.client, updated);
}

export async function mainMenu(c) {
  if (c.intent.type !== 'menu') return handleFreeText(c, 'main');
  switch (c.intent.value) {
    case 1:
      c.setState('retail_menu', { parent: true, bulk: null });
      return c.R(TEMPLATES.RETAIL_MENU);
    case 2:
      await markBulkClient(c);
      c.setState('corporate_menu', { bulk: true, parent: null });
      return c.R(TEMPLATES.CORPORATE_MENU);
    case 3:
      return startQuote(c);
    case 4:
      return startOrder(c);
    case 5:
      return startTracking(c);
    case 6:
      return startTicket(c);
    case 7:
      return c.R(TEMPLATES.STORE_INFO);
    case 8:
      return requestConsultant(c, 'General enquiry');
    default:
      return c.R(TEMPLATES.UNKNOWN_INTENT);
  }
}
