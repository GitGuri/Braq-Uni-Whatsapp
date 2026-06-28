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
