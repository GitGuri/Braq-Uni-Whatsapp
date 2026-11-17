/**
 * Client profile for the bot (pure helpers + parsing): which details a flow
 * still needs, name validation, and reading several answers from one reply
 * ("Thabo Mokoena, Dalview Primary, collect").
 */

const GREETING_WORDS = new Set([
  'hi', 'hii', 'hello', 'hey', 'hiya', 'howzit', 'yo', 'morning', 'good', 'thanks', 'thank', 'ok', 'okay',
  'yes', 'no', 'menu', 'quote', 'order', 'test', 'help', 'please', 'na', 'n/a', 'none', 'unknown', 'sir', 'madam',
]);

const SENTENCE_START = new Set(['we', 'i', "i'm", 'im', 'my', 'our', 'it', 'this', 'please', 'can', 'need', 'want', 'the', 'a', 'an']);
const SENTENCE_WORDS = new Set(['am', 'are', 'is', 'need', 'needs', 'want', 'would', 'uniforms', 'quote', 'order', 'school', 'company']);

/**
 * A plausible person's name: 2–60 characters, letters (any script) with spaces,
 * hyphens, apostrophes or dots, at most 6 words, no digits / emoji / links, and
 * not a greeting or command ("hi", "menu", "yes").
 */
export function isValidName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) return false;
  if (!/^[\p{L}][\p{L}\p{M}' .-]*$/u.test(name)) return false;
  if (/www\.|\.(com|co|za|net|org|io)\b/i.test(name)) return false;
  const letters = name.match(/\p{L}/gu) || [];
  if (letters.length < 2) return false;
  const words = name.toLowerCase().split(' ');
  if (words.length > 6) return false;
  if (words.every((w) => GREETING_WORDS.has(w.replace(/[.!']/g, '')))) return false;
  // A sentence, not a name: "we are Acme", "I need uniforms", "my school is…"
  if (SENTENCE_START.has(words[0]) || words.some((w) => SENTENCE_WORDS.has(w))) return false;
  return true;
}

/** "thabo mokoena" → "Thabo Mokoena" (only when typed all lower- or upper-case). */
export function tidyName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

const SCHOOL_RE = /\b(school|skool|laerskool|hoerskool|hoërskool|primary|secondary|high|college|academy|akademie|educational|preparatory|prep|creche|crèche|montessori|kindergarten|pre-?school|gymnasium)\b/i;
export const looksLikeSchool = (text) => SCHOOL_RE.test(String(text ?? ''));

const NA_RE = /^(n\/?a|none|no|not applicable|nothing|-|no school|not sure)$/i;
export const isNotApplicable = (text) => NA_RE.test(String(text ?? '').trim());

const COLLECT_RE = /\b(collect(ing|ion)?|pick\s?-?up|pick it up|come (in|through|fetch)|fetch|in store|at the store|from the (shop|store)|i'?ll come)\b/i;
const DELIVERY_RE = /\b(deliver(y|ed)?|courier|send it|ship|address)\b/i;
const ADDRESS_HINT_RE = /\d+\s+\p{L}+.*\b(st|street|rd|road|ave|avenue|drive|dr|lane|ln|crescent|cres|way|close|boulevard|blvd|ext|extension|park|estate|complex|unit)\b|\b\d{4}\b/iu;

/** 'collect' | 'delivery' | null, plus the address when the text contains one. */
export function readFulfilment(text) {
  const t = String(text ?? '').trim();
  if (!t) return { fulfilment: null, address: null };
  if (COLLECT_RE.test(t) && !ADDRESS_HINT_RE.test(t)) return { fulfilment: 'collect', address: null };
  if (/^(yes|yep|yeah|y)\b[\s!.]*$/i.test(t)) return { fulfilment: 'collect', address: null }; // "Will you collect?" → "yes"
  const address = t
    .replace(/^(please\s+)?(deliver(y)?|courier|send it|ship)(\s+(it|them))?(\s+to)?[\s:,-]*/i, '')
    .replace(/^(my\s+)?(delivery\s+)?address(\s+is)?[\s:,-]*/i, '')
    .trim();
  if (ADDRESS_HINT_RE.test(t)) return { fulfilment: 'delivery', address: address || t };
  if (DELIVERY_RE.test(t)) return { fulfilment: 'delivery', address: address.length >= 8 ? address : null };
  return { fulfilment: null, address: null };
}

/** What the client's org answer should be called: the school (parents) or the company (bulk). */
export function orgKindFor(client, context = {}) {
  if (context.bulk || (client.client_type && client.client_type !== 'retail')) return 'company';
  return context.parent ? 'school' : 'either';
}

const hasOrg = (client) => Boolean((client.organisation && String(client.organisation).trim())
  || (client.school_name && String(client.school_name).trim()));
const hasFulfilment = (client) => Boolean((client.preferred_store_location && String(client.preferred_store_location).trim())
  || (client.physical_address && String(client.physical_address).trim())
  || (client.delivery_preference && String(client.delivery_preference).trim()));

/**
 * Details still missing before a flow can continue. A profile marked complete
 * (by an earlier registration or by staff) counts as having its name and school
 * / company; the collect-or-deliver choice is only needed to place an order.
 * @param {'quote'|'order'|'account'} purpose
 * @returns {Array<'name'|'org'|'fulfilment'>}
 */
export function missingFields(client, purpose = 'quote') {
  const missing = [];
  const nameOk = client.profile_complete ? Boolean(String(client.name ?? '').trim()) : isValidName(client.name);
  if (!nameOk) missing.push('name');
  if (!client.profile_complete && !hasOrg(client)) missing.push('org');
  if (purpose === 'order' && !hasFulfilment(client)) missing.push('fulfilment');
  return missing;
}

/**
 * Split one reply into answers: one per line, or "1) … 2) …", or comma /
 * semicolon separated. Leading numbering and "name:" style labels are kept
 * apart so labelled answers can be matched to their field.
 * @returns {{ label: string|null, text: string }[]}
 */
export function splitAnswers(text) {
  const raw = String(text ?? '').trim();
  let parts;
  if (/\n/.test(raw)) parts = raw.split(/\n+/);
  else if (/(^|\s)\d\s*[).:-]\s*\S/.test(raw) && (raw.match(/(^|\s)\d\s*[).:-]/g) || []).length >= 2) {
    parts = raw.split(/(?:^|\s)\d\s*[).:-]\s*/);
  } else parts = raw.split(/\s*[;,|]\s*/);
  return parts
    .map((p) => p.replace(/^\s*\d\s*[).:-]\s*/, '').trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(name|full name|my name is|i am|i'm|school|company|organisation|organization|business|collect(ion)?|delivery|address|deliver to)\s*[:=-]?\s+(.*)$/i.exec(p);
      if (!m) return { label: null, text: p };
      const key = m[1].toLowerCase();
      const label = /name|i am|i'm/.test(key) ? 'name'
        : /school|company|organi|business/.test(key) ? 'org'
        : 'fulfilment';
      return { label, text: label === 'fulfilment' && /collect/.test(key) ? `collect ${m[3]}` : (label === 'fulfilment' && /deliver|address/.test(key) ? `deliver to ${m[3]}` : m[3]) };
    });
}

/**
 * Simple (no-AI) reading of a registration reply against the fields asked for.
 * @returns {{ name?: string, org?: string, fulfilment?: 'collect'|'delivery', address?: string, complete: boolean }}
 */
export function parseAnswersSimple(text, missing) {
  const out = {};
  const answers = splitAnswers(text);
  const remaining = [...missing];
  const take = (field, value) => {
    if (field === 'fulfilment') {
      const f = readFulfilment(value);
      if (!f.fulfilment) return false;
      out.fulfilment = f.fulfilment;
      if (f.address) out.address = f.address;
    } else if (field === 'address') {
      out.fulfilment = 'delivery';
      out.address = value;
    } else {
      out[field] = value;
    }
    remaining.splice(remaining.indexOf(field), 1);
    return true;
  };

  // Labelled answers first, then the collect/deliver answer wherever it is, then in order.
  const unlabelled = [];
  for (const a of answers) {
    if (a.label && remaining.includes(a.label)) take(a.label, a.text);
    else unlabelled.push(a.text);
  }
  if (remaining.includes('fulfilment') || remaining.includes('address')) {
    const field = remaining.includes('fulfilment') ? 'fulfilment' : 'address';
    const idx = unlabelled.findIndex((t) => readFulfilment(t).fulfilment);
    if (idx >= 0 && (unlabelled.length > 1 || remaining.length === 1)) {
      take(field, unlabelled[idx]);
      unlabelled.splice(idx, 1);
    } else if (field === 'address' && remaining.length === 1 && unlabelled.length) {
      take('address', unlabelled.join(', '));
      unlabelled.length = 0;
    }
  }
  const ordered = remaining.filter((f) => f !== 'fulfilment' && f !== 'address');
  if (unlabelled.length === ordered.length || (ordered.length === 1 && unlabelled.length >= 1)) {
    if (ordered.length === 1) take(ordered[0], unlabelled.join(', '));
    else ordered.forEach((f, i) => take(f, unlabelled[i]));
  } else if (unlabelled.length > ordered.length && ordered.length > 1) {
    ordered.forEach((f, i) => take(f, i === ordered.length - 1 ? unlabelled.slice(i).join(', ') : unlabelled[i]));
  }
  out.complete = remaining.length === 0;
  out.answersCount = answers.length;
  return out;
}
