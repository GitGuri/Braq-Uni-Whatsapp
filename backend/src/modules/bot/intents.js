/**
 * Intent detection for one inbound text (pure — no database). The router
 * decides, per conversation state, which of these intents it acts on.
 *
 *   main_menu    "0", "menu", "cancel"…            (works everywhere)
 *   back         "back"
 *   consultant   "9", "agent", "talk to a person"… (exact: true → also inside data collection)
 *   menu         a bare digit 1–8
 *   accept       "accept", "I accept", "accept BRQ-Q-…", "go ahead"… (ref when given)
 *   order_ref    a bare BRQ-O-… / BRQ-Q-… reference
 *   quote_status "where is my quote", "resend my quotation"…
 *   keyword      track | make_order | quote | hours | layby | branding | store | ticket
 *   freetext     anything else
 */

const REF = String.raw`brq-q-(?:\d{8}-\d{4}|\d{5,})`;

export const MAIN_MENU_RE = /^(0|menu|main menu|cancel|start over|restart)[.!]*$/i;
export const BACK_RE = /^(back|go back)[.!]*$/i;

// Words that reach a person even inside data collection (a bare "9" there is data).
export const CONSULTANT_EXACT_RE = /^(consultant|agent|human|a human|person|a person|real person|someone|operator)[.!]*$/i;
const CONSULTANT_RE = new RegExp([
  String.raw`\b(speak|talk|chat)\s+(to|with)\s+(a\s+|an\s+|the\s+|your\s+)?(consultant|agent|human|person|someone|somebody|real person|staff|sales\s*(rep|person)?|manager)\b`,
  String.raw`^(i\s+)?(need|want|would like)\s+(to\s+(speak|talk)\s+to\s+)?(a|an)\s+(consultant|agent|human|person)\b`,
  String.raw`^(connect me to|can i get|get me)\s+(a|an)\s+(consultant|agent|human|person)\b`,
  String.raw`\bcall me\b|\bplease call\b|\bcan (someone|somebody|you) (please )?call\b`,
  String.raw`^(human|agent|consultant)\s*(please|pls)?[!.]*$`,
].join('|'), 'i');

const ACCEPT_REF_RE = new RegExp(String.raw`^(?:(?:yes|yep|yeah|ok|okay)[,!.\s]+)?(?:i\s+|we\s+)?accept(?:ed)?\s+(?:the\s+)?(?:quote\s+|quotation\s+)?(${REF})[.!\s]*$`, 'i');
const ACCEPT_RE = /^(?:(?:yes|yep|yeah|ok|okay)[,!.\s]+)?(?:i\s+|we\s+)?(?:accept(?:ed)?|go ahead|i'?ll take it|we'?ll take it)(?:\s+(?:the|your|this|my|our)\s+(?:quote|quotation|offer))?(?:[,\s]+(?:please|thanks|thank you))?[\s.!👍]*$/i;
const YES_ACCEPT_RE = /^(yes|yep|yeah)\b(?!.*\b(not|don'?t|do not|won'?t)\b).*\baccept(ed)?\b/i;

export const ORDER_REF_RE = /^brq-[oq]-(\d{8}-\d{4}|\d{5,})$/i;

/** "where is my quote", "resend my quotation", "is my quote ready?" — not a request for a new one. */
export function isQuoteStatus(t) {
  if (!/\bquot/i.test(t)) return false;
  if (/\b(a|an|another|new|some|me a)\s+quot|\bquot\w*\s+(for|on|please|pls)\b/i.test(t)) return false;
  return /\b(resend|re-send|again|where|status|ready|update|check|news|received?|got|lost|find|haven'?t|my quot\w*|the quot\w*)\b/i.test(t);
}

const MAKE_ORDER_RE = new RegExp([
  String.raw`^(make|place|new)\s*(an?\s*)?order[.!]*$`,
  String.raw`^order\b(?!\s*(status|update|ref|number|no\b|#))`,
  String.raw`^(i\s+)?(want|would like|wanna|need)\s+to\s+(place\s+an?\s+|make\s+an?\s+)?order\b`,
  String.raw`^i'?d like to (place an? )?order\b`,
  String.raw`^can i (place an? |make an? )?order\b`,
  String.raw`\b(where|how)\s+(do|can)\s+i\s+(place|make)\s+an?\s+order\b`,
  String.raw`\bplace an? order\b`,
].join('|'), 'i');

const TRACK_RE = /\btrack(ing)?\b|\border status\b|\bwhere('?s| is)\b.*\border\b|\bstatus of (my |the )?order\b|\bis my order (ready|done|finished|on its way)\b|\bhas my order\b|\bwhen will my order\b/i;
const QUOTE_RE = /\bquot/i;
const HOURS_RE = new RegExp([
  String.raw`\b(trading|opening|business|store|shop|office)\s+hours?\b`,
  String.raw`\byour hours\b`,
  String.raw`^hours\??$`,
  String.raw`\bwhat are (your|the) hours\b`,
  String.raw`\bclosing time\b`,
  String.raw`\b(are|is) (you|the (shop|store)) (still )?open\b`,
  String.raw`\bwhen (do|are|does|is) (you|the (shop|store))\b.*\b(open|close)\b`,
  String.raw`\bwhat time\b.*\b(open|close)\b`,
  String.raw`\bopen(ing)? (time|times|today|tomorrow|now)\b`,
  String.raw`\bopen on (saturdays?|sundays?|public holidays?|weekends?|the weekend)\b`,
].join('|'), 'i');
const LAYBY_RE = /\blay[\s-]?bys?\b/i;
const BRANDING_RE = new RegExp([
  String.raw`\bbrand(ing|ed)?\b(?!\s*new)`,
  String.raw`\bembroider`,
  String.raw`\bsublimat`,
  String.raw`\bscreen[\s-]?print`,
  String.raw`\bheat[\s-]?(transfer|press)`,
  String.raw`\b(logo|logos|name|names|design|designs)\b.*\bprint`,
  String.raw`\bprint(ing|ed)?\b.*\b(logo|logos|shirt|shirts|t-?shirts?|tees?|hoodies?|name|names|design|designs)\b`,
  String.raw`^(do you do |can you do )?printing\??$`,
].join('|'), 'i');
const STORE_RE = /\bstore info|\bwhere\b.*\b(shop|store)\b|\bstore location|\byour address\b|\bwhere are you (based|located)\b/i;
const TICKET_RE = /wrong item|\b(wrong|incorrect) (size|sizes|colour|color)\b|defective|faulty|damaged|broken|\btorn\b|\bripped\b|\bsplit (seam|seams|open)\b|seams? (split|came apart|is coming apart)|\bstain(ed|s)?\b|\bpoor quality\b|missing items?\b|\bmissing from\b|\bcomplaint\b|\bcomplain\b|\breport a problem\b/i;

export const GREETING_RE = /^(hi+|hello+|hey+|hiya|howzit|heita|sawubona|molo|dumela|hallo|haai|hola|yo|greetings|morning|good\s*(morning|afternoon|evening|day)|goeie\s*(more|middag|naand))\b[\s,!.]*([a-z']+[\s,!.]*){0,2}[\s!.🙂😊👋]*$/i;
export const THANKS_RE = /^(thanks|thank you|thank u|thanx|thx|ty|shot|cheers|appreciated|ok thanks|okay thanks|great thanks)\b[\s!.,a-z]*[🙏👍😊]*$/i;

/** Order / quote confirmations ("1", "yes", "ok", "confirm", 👍). */
export const CONFIRM_RE = /^(1|yes|y|yep|yeah|yebo|ok|okay|sure|confirm(ed)?|go ahead|place it|place (the )?order|accept|👍|👌|✅)\b[\s!.👍]*$|^(1|👍|👌|✅)$/i;
export const DECLINE_RE = /^(2|no|nope|n|cancel|stop|not now|something else)\b[\s!.]*$/i;

/** Text with no letters at all ("42", "👍🏽🔥", "-1") — not worth an AI call. */
export const hasLetters = (t) => /\p{L}/u.test(t);

export function detectIntent(body) {
  const raw = String(body ?? '').trim();
  const t = raw.toLowerCase();

  if (MAIN_MENU_RE.test(t)) return { type: 'main_menu', word: t };
  if (BACK_RE.test(t)) return { type: 'back' };
  if (t === '9') return { type: 'consultant', digit: true };
  if (CONSULTANT_EXACT_RE.test(t)) return { type: 'consultant', exact: true };
  if (/^[1-8]$/.test(t)) return { type: 'menu', value: parseInt(t, 10) };

  const acceptRef = ACCEPT_REF_RE.exec(t);
  if (acceptRef) return { type: 'accept', ref: acceptRef[1].toUpperCase() };
  if (ACCEPT_RE.test(t) || YES_ACCEPT_RE.test(t)) return { type: 'accept', ref: null };

  // Order reference: old format BRQ-O-YYYYMMDD-XXXX or new global BRQ-O-XXXXX (5+ digits, keeps
  // working past BRQ-O-99999) and quotation BRQ-Q-...
  if (ORDER_REF_RE.test(t)) return { type: 'order_ref', value: t.toUpperCase() };

  if (CONSULTANT_RE.test(t)) return { type: 'consultant' };
  if (isQuoteStatus(t)) return { type: 'quote_status' };

  // Global keyword shortcuts — word boundaries so e.g. "tracksuits", "blueprint",
  // "brand new" or "opening an account" are not mistaken for commands
  if (MAKE_ORDER_RE.test(t)) return { type: 'keyword', value: 'make_order' };
  if (TRACK_RE.test(t))      return { type: 'keyword', value: 'track' };
  if (QUOTE_RE.test(t))      return { type: 'keyword', value: 'quote' };
  if (TICKET_RE.test(t))     return { type: 'keyword', value: 'ticket' };
  if (HOURS_RE.test(t))      return { type: 'keyword', value: 'hours' };
  if (LAYBY_RE.test(t))      return { type: 'keyword', value: 'layby' };
  if (BRANDING_RE.test(t))   return { type: 'keyword', value: 'branding' };
  if (STORE_RE.test(t))      return { type: 'keyword', value: 'store' };

  if (GREETING_RE.test(t)) return { type: 'greeting' };
  if (THANKS_RE.test(t)) return { type: 'thanks' };
  return { type: 'freetext', value: raw };
}

/**
 * Does `text` describe what the client wants beyond the bare keyword?
 * "Hi, I need a quote for 30 Dalview jerseys" → true; "I want a quote" → false.
 */
export function carriesDetail(text) {
  const words = String(text ?? '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER.has(w));
  return words.length >= 2 && (words.some((w) => /\d/.test(w)) || words.length >= 3);
}
const FILLER = new Set([
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'please', 'pls', 'thanks', 'thank', 'you',
  'i', 'we', 'me', 'us', 'my', 'our', 'a', 'an', 'the', 'need', 'want', 'would', 'like', 'to', 'get', 'can', 'could',
  'quote', 'quotes', 'quotation', 'quotations', 'price', 'prices', 'pricing', 'request', 'requesting', 'some', 'for', 'on',
  'order', 'orders', 'place', 'make', 'new', 'do', 'you', 'have', 'is', 'it', 'there', 'just', 'kindly', 'id', 'i\'d', 'wanna',
]);
