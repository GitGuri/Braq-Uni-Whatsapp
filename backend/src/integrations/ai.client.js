// Gemini client (structured JSON answers for the bot and quotation parsing).
import { GoogleGenAI } from '@google/genai';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const MODEL = 'gemini-2.5-flash';
// A slow model call must not hold a WhatsApp reply hostage: callers fall back
// (escalate / manual pricing) when it throws.
const TIMEOUT_MS = Math.max(1000, Number(process.env.AI_TIMEOUT_MS) || 20000);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callGemini({ system, schema, userText, validate }) {
  const response = await withTimeout(ai.models.generateContent({
    model: MODEL,
    contents: userText,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  }), TIMEOUT_MS);
  const parsed = JSON.parse(response.text);
  // JSON.parse happily returns null / numbers / arrays — reject anything that
  // doesn't match the shape callers rely on so they fall back safely.
  if (validate && !validate(parsed)) {
    throw new Error('AI response did not match the expected shape');
  }
  return parsed;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const isFaqResult = (r) =>
  isPlainObject(r) && ['answer', 'escalate'].includes(r.type);

const isGatherResult = (r) =>
  isPlainObject(r) && ['need_more_info', 'ready'].includes(r.status);

const isItemsResult = (r) =>
  isPlainObject(r) && Array.isArray(r.items) && r.items.every(isPlainObject);

const isQuotationParse = (r) =>
  isItemsResult(r) && (r.unmatchedText === undefined || Array.isArray(r.unmatchedText));

function formatCatalog(products) {
  return products
    .map(p => `- ${p.name} (${p.category}): ${p.currency} ${p.price}, sizes: ${JSON.stringify(p.sizes)}`)
    .join('\n');
}

const FAQ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['answer', 'escalate'] },
    text: { type: 'STRING' },
    reason: { type: 'STRING' },
  },
  required: ['type'],
};

// ── Answer a retail FAQ grounded in the catalog, or flag for escalation ───────
export async function answerFaq(question, { products, hoursText, laybyText }) {
  const system =
    `You are a WhatsApp assistant for Braq Uni, a uniform manufacturer and retailer.\n` +
    `Answer the customer's question ONLY using the information below. If the question ` +
    `cannot be answered from this information (e.g. refunds, complaints, custom orders, ` +
    `anything not covered), respond with type "escalate" and a one-line reason instead.\n\n` +
    `Trading hours:\n${hoursText}\n\n` +
    `Lay-by terms:\n${laybyText}\n\n` +
    `Product catalog:\n${formatCatalog(products)}`;

  try {
    return await callGemini({ system, schema: FAQ_SCHEMA, userText: question, validate: isFaqResult });
  } catch (err) {
    logger.error('Gemini FAQ call failed', { error: err.message });
    return { type: 'escalate', reason: 'AI service unavailable' };
  }
}

const QUOTATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          productId:   { type: 'STRING' },
          quantity:    { type: 'INTEGER' },
          description: { type: 'STRING' },
          colour:      { type: 'STRING' },
          sizes: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                size: { type: 'STRING' },
                qty:  { type: 'INTEGER' },
              },
              required: ['size', 'qty'],
            },
          },
        },
        required: ['productId', 'quantity'],
      },
    },
    unmatchedText: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
  },
  required: ['items', 'unmatchedText'],
};

const QUOTATION_GATHER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    status:               { type: 'STRING', enum: ['need_more_info', 'ready'] },
    question:             { type: 'STRING' },
    consolidatedRequest:  { type: 'STRING' },
  },
  required: ['status'],
};

// ── Multi-turn quotation gathering — checks if enough info, or asks for everything missing at once
export async function gatherQuotationInfo(history, { products }) {
  const system =
    `You are a quotation assistant for Braq Uni, a uniform manufacturer.\n` +
    `Review the conversation below and decide if you have enough information to generate a quotation.\n\n` +
    `A complete quotation needs ALL of the following:\n` +
    `• Item types (e.g. polo shirts, hoodies, jackets) and quantities\n` +
    `• Colour(s) required (e.g. "Navy Blue", "Black/Red")\n` +
    `• Sizes needed (e.g. S×10, M×20, L×15) — "TBC" is acceptable\n` +
    `• Branding (logo type, embroidery, print, or none) — "TBC" is acceptable\n\n` +
    `Do NOT block if sizes or branding is "TBC" — that is enough to proceed. If the customer already ` +
    `answered a question (even with "not sure" / "TBC"), do not ask it again.\n\n` +
    `If key information is missing, set status to "need_more_info" and ask for EVERYTHING that is ` +
    `missing in ONE short, friendly WhatsApp message: one numbered line per missing detail ` +
    `(e.g. "1) colour  2) sizes"), and say the customer can answer them all in one reply.\n` +
    `Otherwise set status to "ready" and write a clean "consolidatedRequest" that lists ` +
    `the product items with quantities, colours, and sizes. ` +
    `Do NOT include greetings, filler words, or conversational phrases in consolidatedRequest.\n\n` +
    `Available product catalog:\n` +
    products.map(p => `${p.id} | ${p.name} | ${p.category} | sizes: ${JSON.stringify(p.sizes)}`).join('\n');

  const conversation = history
    .map(h => `${h.role === 'client' ? 'Customer' : 'Assistant'}: ${h.text}`)
    .join('\n');

  try {
    return await callGemini({ system, schema: QUOTATION_GATHER_SCHEMA, userText: conversation, validate: isGatherResult });
  } catch (err) {
    logger.error('Gemini quotation gather failed', { error: err.message });
    // Fail gracefully — proceed with what we have
    return {
      status: 'ready',
      consolidatedRequest: history.filter(h => h.role === 'client').map(h => h.text).join('\n'),
    };
  }
}

// ── Free text at a menu: answer it, route it to a flow, or hand it to a person ─
/** Flows a free-text message can be routed to (modules/bot/freeText.js). */
export const ROUTE_INTENTS = ['quote', 'order', 'track', 'ticket', 'consultant', 'hours', 'store', 'layby', 'branding', 'school_uniforms', 'menu'];

const ROUTE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type:   { type: 'STRING', enum: ['answer', 'route', 'escalate'] },
    intent: { type: 'STRING', enum: ROUTE_INTENTS },
    text:   { type: 'STRING' },
    reason: { type: 'STRING' },
  },
  required: ['type'],
};

const isRouteResult = (r) =>
  isPlainObject(r) && ['answer', 'route', 'escalate'].includes(r.type)
  && (r.type !== 'answer' || (typeof r.text === 'string' && r.text.trim().length > 0))
  && (r.type !== 'route' || ROUTE_INTENTS.includes(r.intent));

/**
 * A customer typed free text at a menu. Returns
 *   { type: 'route', intent }      — they want one of the bot's flows
 *   { type: 'answer', text }       — a short answer grounded in the info below
 *   { type: 'escalate', reason }   — a real question only a person can answer
 *   { type: 'unknown' }            — the AI is unavailable / answered nonsense
 */
export async function routeFreeText(text, { products = [], hoursText = '', laybyText = '', storeText = '' } = {}) {
  const system =
    `You are the WhatsApp assistant of Braq Uni, a South African school and corporate uniform ` +
    `manufacturer and shop. Classify the customer's message:\n` +
    `• type "route" + intent when they want to: get a quote ("quote"), place an order ("order"), ` +
    `track an existing order ("track"), report a problem with an order ("ticket"), talk to a person ` +
    `("consultant"), know trading hours ("hours") or the store location ("store"), lay-by ("layby"), ` +
    `branding/embroidery/printing services ("branding"), see school uniforms/prices for a school ` +
    `("school_uniforms"), or see the menu / greetings ("menu").\n` +
    `• type "answer" + text when it is a question you can answer ONLY from the information below — ` +
    `answer in at most 3 short sentences, friendly, plain WhatsApp text.\n` +
    `• type "escalate" + reason for a genuine question you cannot answer from this information ` +
    `(refunds, custom requests, anything not covered).\n` +
    `Never invent prices, stock or policies.\n\n` +
    `Trading hours:\n${hoursText}\n\nStore:\n${storeText}\n\nLay-by terms:\n${laybyText}\n\n` +
    `Product catalog:\n${formatCatalog(products)}`;
  try {
    return await callGemini({ system, schema: ROUTE_SCHEMA, userText: String(text).slice(0, 1000), validate: isRouteResult });
  } catch (err) {
    logger.error('Gemini free-text routing failed', { error: err.message });
    return { type: 'unknown' };
  }
}

// ── Registration details from one free-text reply ────────────────────────────
const REGISTRATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:         { type: 'STRING' },
    organisation: { type: 'STRING' },
    isSchool:     { type: 'BOOLEAN' },
    fulfilment:   { type: 'STRING', enum: ['collect', 'delivery', 'unknown'] },
    address:      { type: 'STRING' },
  },
};

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const isRegistrationResult = (r) =>
  isPlainObject(r) && (nonEmpty(r.name) || nonEmpty(r.organisation) || nonEmpty(r.address)
    || ['collect', 'delivery'].includes(r.fulfilment));

/**
 * Pull the customer's name, school/company and collect-or-deliver choice out of
 * one reply (they may answer in any order or format). Returns null when the AI
 * is unavailable or found nothing — callers fall back to simple parsing.
 */
export async function parseRegistrationDetails(text, { missing = [] } = {}) {
  const system =
    `Extract customer details from a WhatsApp reply to Braq Uni (uniform supplier). We asked for: ` +
    `${missing.join(', ')}.\n` +
    `• name — the person's own name only (not a greeting, not a company)\n` +
    `• organisation — the school or company the uniforms are for ("N/A" if they say none)\n` +
    `• isSchool — true when organisation is a school/college/academy\n` +
    `• fulfilment — "collect" if they will collect in store, "delivery" if they want delivery, else "unknown"\n` +
    `• address — the delivery address, only when given\n` +
    `Leave a field empty when it is not in the message. Never invent values.`;
  try {
    return await callGemini({ system, schema: REGISTRATION_SCHEMA, userText: String(text).slice(0, 1000), validate: isRegistrationResult });
  } catch (err) {
    logger.warn('Gemini registration parse failed — simple parsing used', { error: err.message });
    return null;
  }
}

// ── Ticket category from the customer's description ───────────────────────────
const TICKET_CATEGORIES = ['wrong_item', 'defective', 'missing_item', 'account_query', 'other'];
const TICKET_CATEGORY_SCHEMA = {
  type: 'OBJECT',
  properties: { category: { type: 'STRING', enum: TICKET_CATEGORIES } },
  required: ['category'],
};
const isTicketCategory = (r) => isPlainObject(r) && TICKET_CATEGORIES.includes(r.category);

/** 'wrong_item' | 'defective' | 'missing_item' | 'account_query' | 'other' (fallback). */
export async function classifyTicketCategory(text) {
  const system =
    `Classify a customer's complaint to a uniform supplier into one category: wrong_item (received the ` +
    `wrong item/size/colour), defective (damaged, faulty, poor quality), missing_item (items missing from ` +
    `the order), account_query (invoice, payment, statement), other.`;
  try {
    return (await callGemini({ system, schema: TICKET_CATEGORY_SCHEMA, userText: String(text).slice(0, 1000), validate: isTicketCategory })).category;
  } catch (err) {
    logger.warn('Gemini ticket classification failed', { error: err.message });
    return 'other';
  }
}

// ── Suggest ZAR prices for items that didn't match the product catalog ────────
const PRICING_SUGGESTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          quantity:    { type: 'INTEGER' },
          unitPrice:   { type: 'NUMBER' },
          sizes:       { type: 'STRING' },
          branding:    { type: 'STRING' },
          confidence:  { type: 'STRING', enum: ['high', 'medium', 'low'] },
          notes:       { type: 'STRING' },
        },
        required: ['description', 'quantity', 'unitPrice', 'confidence'],
      },
    },
  },
  required: ['items'],
};

export async function suggestLineItemPricing(unmatchedDescriptions, { products, originalRequest }) {
  const system =
    `You are a pricing specialist for Braq Uni, a South African uniform manufacturer.\n` +
    `Some items in a customer's quotation request could not be matched to our product catalog.\n` +
    `Suggest a realistic ZAR price for each unmatched item.\n\n` +
    `Pricing guidelines:\n` +
    `• Base prices on similar catalog items (see reference list below)\n` +
    `• Apply bulk discount logic: > 50 units = -5%, > 100 units = -10%, > 500 units = -15%\n` +
    `• Add branding surcharge: embroidery +R15/unit, screen print +R12/unit, sublimation +R25/unit\n` +
    `• Round to nearest R0.50\n` +
    `• All prices in ZAR, numbers only (no R symbol in unitPrice field)\n\n` +
    `Catalog reference (name: price):\n` +
    products.map(p => `  ${p.name} (${p.category}): R ${Number(p.price).toFixed(2)}`).join('\n') +
    `\n\nFor each item return:\n` +
    `  description  — clean item name\n` +
    `  quantity     — units ordered (extract from customer text)\n` +
    `  unitPrice    — suggested price per unit in ZAR\n` +
    `  sizes        — sizes or "TBC"\n` +
    `  branding     — branding description or "None"\n` +
    `  confidence   — "high" if near-identical catalog item, "medium" if similar, "low" if estimated\n` +
    `  notes        — one-line reason for the price\n\n` +
    `These are AI suggestions. A consultant will review and approve before the PDF is sent.`;

  const userText =
    `Full customer request:\n${originalRequest}\n\n` +
    `Items to price:\n${unmatchedDescriptions.join('\n')}`;

  try {
    return await callGemini({ system, schema: PRICING_SUGGESTION_SCHEMA, userText, validate: isItemsResult });
  } catch (err) {
    logger.error('Gemini pricing suggestion failed', { error: err.message });
    return {
      items: unmatchedDescriptions.map((desc) => ({
        description: desc,
        quantity:    1,
        unitPrice:   0,
        sizes:       'TBC',
        branding:    'TBC',
        confidence:  'low',
        notes:       'Manual pricing required — AI unavailable',
      })),
    };
  }
}

// ── Parse a free-text quotation request against the catalog ──────────────────
export async function parseQuotationRequest(freeText, { products }) {
  const system =
    `You extract a quotation request into structured line items for Braq Uni, a uniform manufacturer.\n\n` +
    `RULES:\n` +
    `1. Match each GARMENT TYPE the customer describes to the closest product in the catalog by its id.\n` +
    `2. Extract the requested total quantity for the item.\n` +
    `3. Extract the colour mentioned (e.g. "Navy Blue", "Black/Red") into the "colour" field. If multiple colours, join with "/".\n` +
    `4. Extract sizes into a structured "sizes" array — each entry has "size" (e.g. "S", "M", "L", "XL", "2XL", "6", "8") ` +
    `and "qty" (integer). If the customer says e.g. "S×10 M×20" parse each. If only total qty with no breakdown, ` +
    `use one entry with size "TBC" and the full quantity.\n` +
    `5. unmatchedText is ONLY for garment types that cannot be matched to any catalog product ` +
    `(e.g. "safety boots", "swim caps"). Each entry must be a full item description, never a bare word or size.\n` +
    `6. Completely ignore conversational noise — greetings, filler words are NOT items.\n` +
    `7. If the input contains no recognisable product descriptions, return empty arrays.\n\n` +
    `Product catalog (id | name | category | sizes):\n` +
    products.map(p => `${p.id} | ${p.name} | ${p.category} | ${JSON.stringify(p.sizes)}`).join('\n');

  try {
    const parsed = await callGemini({ system, schema: QUOTATION_SCHEMA, userText: freeText, validate: isQuotationParse });
    if (parsed.unmatchedText === undefined) parsed.unmatchedText = [];
    return parsed;
  } catch (err) {
    logger.error('Gemini quotation parse failed', { error: err.message });
    return { items: [], unmatchedText: [freeText] };
  }
}
