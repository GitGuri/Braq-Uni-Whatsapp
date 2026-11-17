// Registration in one message: the bot asks for everything still missing at
// once ("1) your name 2) school or company 3) collect or delivery address"),
// reads the reply (simple parsing, the AI for free-form answers), re-asks only
// what is still missing, then carries on with what the client was doing — with
// the request they already typed ("a quote for 30 Dalview jerseys") kept.
//
// The WhatsApp profile name counts as the client's name (router.js), so most
// clients are only asked for their school / company. Collect-or-deliver is only
// asked when placing an order. State: registration_name (the older
// registration_org_or_school / registration_address states map here too).
import { query } from '../../../core/db.js';
import { logger } from '../../../core/logger.js';
import { TEMPLATES } from '../templates.js';
import { updateClientProfile } from '../../clients/service.js';
import { parseRegistrationDetails } from '../../../integrations/ai.client.js';
import { clip } from '../state.js';
import {
  missingFields, orgKindFor, parseAnswersSimple, isValidName, tidyName, looksLikeSchool,
  isNotApplicable, readFulfilment,
} from '../profile.js';

// VARCHAR limits of the client columns filled in during registration (0001_baseline.sql)
const COLUMN_LIMITS = {
  name:                     200,
  school_name:              200,
  organisation:             200,
  preferred_store_location: 120,
};

/** After this many replies that still miss something, carry on anyway (a consultant fills the gaps). */
const MAX_ATTEMPTS = 3;

// Older conversations parked in a registration state carry the state they were heading to.
const LEGACY_PENDING = { quotation_ask_description: 'quote', order_ask_method: 'order', corporate_menu: 'corporate_menu' };
const purposeFor = (pendingIntent) => (pendingIntent === 'order' || pendingIntent === 'order_ask_method' || pendingIntent === 'repeat'
  ? 'order' : pendingIntent === 'corporate_menu' ? 'account' : 'quote');

/**
 * Flows that need details on file: ask for what is missing (one message), then
 * continue with `pendingIntent` ('quote' | 'order' | 'repeat' | 'corporate_menu').
 */
export function gateOrProceed(c, { purpose, pendingIntent, pendingText = null }, proceed) {
  const missing = missingFields(c.client, purpose);
  if (!missing.length) return proceed();
  c.setState('registration_name', { pendingIntent, pendingText, regMissing: missing, regAttempts: 0, pending: null });
  return c.R(TEMPLATES.REGISTRATION_ASK_DETAILS, { missing, purpose, orgKind: orgKindFor(c.client, c.convo.context) });
}

/** Labels for the fields still missing ('fulfilment' becomes 'address' once they chose delivery). */
const displayMissing = (missing, needAddress) => missing.map((m) => (m === 'fulfilment' && needAddress ? 'address' : m));

/** registration_name / registration_org_or_school / registration_address */
export async function registrationReply(c) {
  const ctx = c.convo.context;
  const pendingIntent = LEGACY_PENDING[ctx.pendingIntent] ?? ctx.pendingIntent ?? 'menu';
  const purpose = purposeFor(pendingIntent);
  const orgKind = orgKindFor(c.client, ctx);
  const missing = missingFields(c.client, purpose);
  if (!missing.length) return finish(c, pendingIntent);

  const text = c.body.trim();
  const asked = displayMissing(missing, ctx.regNeedAddress);
  const parsed = text ? await readAnswers(text, asked) : {};

  // ── Validate and save what we got ──────────────────────────────────────────
  const patch = {};
  if (missing.includes('name') && parsed.name && isValidName(parsed.name)) {
    patch.name = clip(tidyName(parsed.name), COLUMN_LIMITS.name);
  }
  if (missing.includes('org') && parsed.org && parsed.org.trim().length >= 2) {
    Object.assign(patch, orgPatch(c.client, parsed.org.trim(), { orgKind, isSchool: parsed.isSchool }));
  }
  let needAddress = Boolean(ctx.regNeedAddress);
  let deliveryPreference = null;
  if (missing.includes('fulfilment')) {
    if (parsed.fulfilment === 'collect') {
      patch.preferred_store_location = 'Collect in store';
      deliveryPreference = 'collect';
      needAddress = false;
    } else if (parsed.fulfilment === 'delivery' && parsed.address && parsed.address.trim().length >= 5) {
      patch.physical_address = parsed.address.trim();
      deliveryPreference = 'delivery';
      needAddress = false;
    } else if (parsed.fulfilment === 'delivery') {
      needAddress = true;
    }
  }

  if (Object.keys(patch).length) {
    const updated = await updateClientProfile(c.client.id, patch);
    Object.assign(c.client, updated);
  }
  if (deliveryPreference) {
    await query('UPDATE clients SET delivery_preference = $2, updated_at = NOW() WHERE id = $1', [c.client.id, deliveryPreference]);
    c.client.delivery_preference = deliveryPreference;
  }

  const still = missingFields(c.client, purpose);
  const attempts = (ctx.regAttempts || 0) + 1;
  if (still.length && attempts < MAX_ATTEMPTS) {
    c.setState('registration_name', { regMissing: still, regAttempts: attempts, regNeedAddress: needAddress });
    return c.R(TEMPLATES.REGISTRATION_ASK_DETAILS, {
      missing: displayMissing(still, needAddress), purpose, orgKind, retry: still.length < missing.length,
    });
  }
  if (still.length) logger.info('Registration incomplete after several replies — continuing', { clientId: c.client.id, still });
  return finish(c, pendingIntent);
}

/** One reply → { name?, org?, isSchool?, fulfilment?, address? } (simple parsing first, then the AI). */
async function readAnswers(text, asked) {
  const simple = parseAnswersSimple(text, asked);
  const nameOk = !asked.includes('name') || (simple.name && isValidName(simple.name));
  if (simple.complete && nameOk) return simple;

  const ai = await parseRegistrationDetails(text, { missing: asked });
  if (ai) {
    // The AI read the free-form reply; the simple split only fills what it left out.
    const out = {};
    if (asked.includes('name')) out.name = ai.name || (simple.name && isValidName(simple.name) ? simple.name : null);
    if (asked.includes('org')) {
      out.org = ai.organisation || null;
      out.isSchool = ai.organisation ? ai.isSchool : undefined;
    }
    if (asked.includes('fulfilment') || asked.includes('address')) {
      if (['collect', 'delivery'].includes(ai.fulfilment)) out.fulfilment = ai.fulfilment;
      if (ai.address) { out.fulfilment = 'delivery'; out.address = ai.address; }
      if (!out.fulfilment && simple.fulfilment) { out.fulfilment = simple.fulfilment; out.address = simple.address; }
    }
    return out;
  }

  // No AI: a single answer goes to the field it most looks like.
  if (!simple.name && !simple.org && !simple.fulfilment && simple.answersCount <= 1) {
    const f = readFulfilment(text);
    if ((asked.includes('fulfilment') || asked.includes('address')) && f.fulfilment) return { ...f };
    if (asked.includes('org') && (looksLikeSchool(text) || isNotApplicable(text) || !asked.includes('name'))) return { org: text };
    if (asked.includes('name')) return { name: text };
    if (asked.includes('address')) return { fulfilment: 'delivery', address: text };
  }
  return out;
}

/** Where the school / company answer is stored, and the client type it implies. */
function orgPatch(client, org, { orgKind, isSchool = null }) {
  const school = isSchool ?? looksLikeSchool(org);
  if (isNotApplicable(org)) {
    return orgKind === 'company' ? { organisation: 'N/A' } : { school_name: 'N/A' };
  }
  const value = clip(org, COLUMN_LIMITS.organisation);
  if (orgKind === 'school' || (orgKind === 'either' && school)) {
    return { school_name: clip(org, COLUMN_LIMITS.school_name) };
  }
  // A company or a school ordering in bulk — never asked "which school" again.
  const patch = { organisation: value };
  if (school) patch.school_name = clip(org, COLUMN_LIMITS.school_name);
  if (!client.client_type || client.client_type === 'retail') patch.client_type = school ? 'school' : 'corporate';
  return patch;
}

/** Profile done (or as done as it gets): mark it complete and continue where the client was going. */
async function finish(c, pendingIntent) {
  if (!c.client.profile_complete && String(c.client.name ?? '').trim()) {
    const updated = await updateClientProfile(c.client.id, { profile_complete: true });
    Object.assign(c.client, updated);
  }
  const text = c.convo.context.pendingText || null;
  c.setState('main_menu', { pendingIntent: null, pendingText: null, regMissing: null, regAttempts: 0, regNeedAddress: null });

  // Lazy imports: these flows import gateOrProceed from this module.
  if (pendingIntent === 'quote') {
    const { beginQuote } = await import('./quote.js');
    return beginQuote(c, { text, thanks: true });
  }
  if (pendingIntent === 'order') {
    const { beginOrder } = await import('./order.js');
    return beginOrder(c, { text, thanks: true });
  }
  if (pendingIntent === 'repeat') {
    const { beginRepeatOrder } = await import('./corporate.js');
    return beginRepeatOrder(c);
  }
  if (pendingIntent === 'corporate_menu') {
    c.setState('corporate_menu');
    return c.R(TEMPLATES.CORPORATE_MENU);
  }
  return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name });
}
