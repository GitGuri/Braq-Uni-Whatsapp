import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const MODEL = 'gemini-2.5-flash';

async function callGemini({ system, schema, userText }) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: userText,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  return JSON.parse(response.text);
}

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
    return await callGemini({ system, schema: FAQ_SCHEMA, userText: question });
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
          productId: { type: 'STRING' },
          quantity: { type: 'INTEGER' },
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

// ── Multi-turn quotation gathering — checks if enough info, or asks one follow-up
export async function gatherQuotationInfo(history, { products }) {
  const system =
    `You are a quotation assistant for Braq Uni, a uniform manufacturer.\n` +
    `Review the conversation below and decide if you have enough information to generate a quotation.\n\n` +
    `A complete quotation needs ALL of the following:\n` +
    `• Item types (e.g. polo shirts, hoodies, jackets)\n` +
    `• Quantities per item\n` +
    `• Sizes needed (e.g. S/M/L/XL or age ranges like 5-6, 7-8)\n` +
    `• Branding requirements (logo, embroidery, printing, or none)\n\n` +
    `Colors are helpful but not mandatory — don't block on them.\n\n` +
    `If information is missing, set status to "need_more_info" and ask ONE short, friendly follow-up question.\n` +
    `If you have enough information, set status to "ready" and consolidate everything the customer said into a single structured "consolidatedRequest" string.\n\n` +
    `Available product catalog:\n` +
    products.map(p => `${p.id} | ${p.name} | ${p.category} | sizes: ${JSON.stringify(p.sizes)}`).join('\n');

  const conversation = history
    .map(h => `${h.role === 'client' ? 'Customer' : 'Assistant'}: ${h.text}`)
    .join('\n');

  try {
    return await callGemini({ system, schema: QUOTATION_GATHER_SCHEMA, userText: conversation });
  } catch (err) {
    logger.error('Gemini quotation gather failed', { error: err.message });
    // Fail gracefully — proceed with what we have
    return {
      status: 'ready',
      consolidatedRequest: history.filter(h => h.role === 'client').map(h => h.text).join('\n'),
    };
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
    return await callGemini({ system, schema: PRICING_SUGGESTION_SCHEMA, userText });
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
    `You extract a quotation request into structured line items for Braq Uni, a uniform manufacturer.\n` +
    `Match each item the customer describes to the closest product in the catalog below by its id, ` +
    `and extract the requested quantity. If an item cannot be confidently matched to any catalog ` +
    `product, put the original text describing it into "unmatchedText" instead of guessing a productId.\n\n` +
    `Product catalog (id | name | category | sizes):\n` +
    products.map(p => `${p.id} | ${p.name} | ${p.category} | ${JSON.stringify(p.sizes)}`).join('\n');

  try {
    return await callGemini({ system, schema: QUOTATION_SCHEMA, userText: freeText });
  } catch (err) {
    logger.error('Gemini quotation parse failed', { error: err.message });
    return { items: [], unmatchedText: [freeText] };
  }
}
