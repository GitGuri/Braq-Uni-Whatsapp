import './_setup.js';
import { describe, test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

// The Gemini SDK is replaced with a fake so no request ever leaves the process.
const gem = { ctor: [], requests: [], impl: null };
class FakeGoogleGenAI {
  constructor(opts) {
    gem.ctor.push(opts);
    this.models = { generateContent: async (req) => { gem.requests.push(req); return gem.impl(req); } };
  }
}

let ai;
before(async () => {
  mock.module('@google/genai', { namedExports: { GoogleGenAI: FakeGoogleGenAI } });
  ai = await import(src('integrations/ai.client.js'));
});
beforeEach(() => { gem.requests.length = 0; gem.impl = async () => ({ text: '{}' }); });

const products = [
  { id: 'p1', name: 'Polo', category: 'corporate_wear', currency: 'ZAR', price: '120.5', sizes: ['S', 'M'] },
  { id: 'p2', name: 'Hoodie', category: 'outdoor_wear', currency: 'ZAR', price: 250, sizes: null },
];
const reply = (obj) => async () => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const MALFORMED = ['', 'not json', '{"type":"answer",', '```json\n{"type":"answer"}\n```', undefined];

test('client is constructed once with the configured API key', () => {
  assert.deepEqual(gem.ctor, [{ apiKey: 'fake' }]);
});

describe('answerFaq', () => {
  test('request shape: model, JSON mime type, schema, grounded system prompt', async () => {
    gem.impl = reply({ type: 'answer', text: 'Yes, M is available.' });
    const r = await ai.answerFaq('Do you have M polos?', { products, hoursText: 'HOURS-TXT', laybyText: 'LAYBY-TXT' });
    assert.deepEqual(r, { type: 'answer', text: 'Yes, M is available.' });
    const req = gem.requests[0];
    assert.equal(req.model, 'gemini-2.5-flash');
    assert.equal(req.contents, 'Do you have M polos?');
    assert.equal(req.config.responseMimeType, 'application/json');
    assert.deepEqual(req.config.responseSchema.properties.type.enum, ['answer', 'escalate']);
    const sys = req.config.systemInstruction;
    assert.match(sys, /Trading hours:\nHOURS-TXT/);
    assert.match(sys, /Lay-by terms:\nLAYBY-TXT/);
    assert.match(sys, /- Polo \(corporate_wear\): ZAR 120\.5, sizes: \["S","M"\]/);
    assert.match(sys, /- Hoodie \(outdoor_wear\): ZAR 250, sizes: null/);
  });

  test('escalate passthrough', async () => {
    gem.impl = reply({ type: 'escalate', reason: 'refund' });
    assert.deepEqual(await ai.answerFaq('refund?', { products: [], hoursText: '', laybyText: '' }), { type: 'escalate', reason: 'refund' });
  });

  for (const bad of MALFORMED) {
    test(`malformed model output ${JSON.stringify(bad)} → escalate fallback`, async () => {
      gem.impl = async () => ({ text: bad });
      assert.deepEqual(await ai.answerFaq('q', { products, hoursText: '', laybyText: '' }), { type: 'escalate', reason: 'AI service unavailable' });
    });
  }

  test('SDK rejection (network / quota) → escalate fallback', async () => {
    gem.impl = async () => { throw new Error('429 RESOURCE_EXHAUSTED'); };
    assert.equal((await ai.answerFaq('q', { products, hoursText: '', laybyText: '' })).type, 'escalate');
  });

  test('syntactically valid but non-object output ("null") still yields an object with a type', async () => {
    gem.impl = reply('null');
    const r = await ai.answerFaq('q', { products, hoursText: '', laybyText: '' });
    assert.ok(r && typeof r === 'object' && typeof r.type === 'string', `got ${JSON.stringify(r)}`);
  });

  for (const bad of ['null', '42', '"answer"', '[]', '{}', '{"type":"maybe"}']) {
    test(`valid JSON with the wrong shape ${bad} → escalate fallback`, async () => {
      gem.impl = reply(bad);
      assert.deepEqual(await ai.answerFaq('q', { products, hoursText: '', laybyText: '' }), { type: 'escalate', reason: 'AI service unavailable' });
    });
  }
});

describe('gatherQuotationInfo', () => {
  const history = [
    { role: 'client', text: '50 polos' },
    { role: 'bot', text: 'What colour?' },
    { role: 'client', text: 'navy, sizes TBC' },
  ];

  test('formats conversation turns and catalog with ids', async () => {
    gem.impl = reply({ status: 'ready', consolidatedRequest: '50 navy polos, sizes TBC' });
    const r = await ai.gatherQuotationInfo(history, { products });
    assert.equal(r.status, 'ready');
    const req = gem.requests[0];
    assert.equal(req.contents, 'Customer: 50 polos\nAssistant: What colour?\nCustomer: navy, sizes TBC');
    assert.match(req.config.systemInstruction, /p1 \| Polo \| corporate_wear \| sizes: \["S","M"\]/);
    assert.deepEqual(req.config.responseSchema.properties.status.enum, ['need_more_info', 'ready']);
  });

  test('need_more_info passthrough', async () => {
    gem.impl = reply({ status: 'need_more_info', question: 'Which sizes?' });
    assert.deepEqual(await ai.gatherQuotationInfo(history, { products }), { status: 'need_more_info', question: 'Which sizes?' });
  });

  for (const bad of MALFORMED) {
    test(`malformed output ${JSON.stringify(bad)} → ready with client turns only`, async () => {
      gem.impl = async () => ({ text: bad });
      assert.deepEqual(await ai.gatherQuotationInfo(history, { products }), {
        status: 'ready', consolidatedRequest: '50 polos\nnavy, sizes TBC',
      });
    });
  }

  for (const bad of ['null', '7', '[]', '{}', '{"status":"done"}']) {
    test(`valid JSON with the wrong shape ${bad} → ready with client turns only`, async () => {
      gem.impl = reply(bad);
      assert.deepEqual(await ai.gatherQuotationInfo(history, { products }), {
        status: 'ready', consolidatedRequest: '50 polos\nnavy, sizes TBC',
      });
    });
  }

  test('empty history + failure → empty consolidated request', async () => {
    gem.impl = async () => { throw new Error('x'); };
    assert.deepEqual(await ai.gatherQuotationInfo([], { products: [] }), { status: 'ready', consolidatedRequest: '' });
  });
});

describe('suggestLineItemPricing', () => {
  test('prompt includes catalog prices with 2dp and the items to price', async () => {
    const out = { items: [{ description: 'Swim cap', quantity: 10, unitPrice: 35.5, confidence: 'low', notes: 'est' }] };
    gem.impl = reply(out);
    assert.deepEqual(await ai.suggestLineItemPricing(['10 swim caps', 'boots'], { products, originalRequest: 'caps and boots' }), out);
    const req = gem.requests[0];
    assert.equal(req.contents, 'Full customer request:\ncaps and boots\n\nItems to price:\n10 swim caps\nboots');
    assert.match(req.config.systemInstruction, / {2}Polo \(corporate_wear\): R 120\.50/);
    assert.match(req.config.systemInstruction, / {2}Hoodie \(outdoor_wear\): R 250\.00/);
    assert.deepEqual(req.config.responseSchema.required, ['items']);
  });

  for (const bad of MALFORMED) {
    test(`malformed output ${JSON.stringify(bad)} → one zero-priced low-confidence item per description`, async () => {
      gem.impl = async () => ({ text: bad });
      const r = await ai.suggestLineItemPricing(['a', 'b'], { products, originalRequest: 'x' });
      assert.deepEqual(r.items.map((i) => [i.description, i.quantity, i.unitPrice, i.confidence, i.sizes, i.branding]), [
        ['a', 1, 0, 'low', 'TBC', 'TBC'], ['b', 1, 0, 'low', 'TBC', 'TBC'],
      ]);
      assert.match(r.items[0].notes, /Manual pricing required/);
    });
  }
});

describe('suggestLineItemPricing — wrong-shape output', () => {
  for (const bad of ['null', '{}', '{"items":"x"}', '{"items":[null]}']) {
    test(`${bad} → manual-pricing fallback`, async () => {
      gem.impl = reply(bad);
      const r = await ai.suggestLineItemPricing(['a'], { products, originalRequest: 'x' });
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].description, 'a');
      assert.equal(r.items[0].confidence, 'low');
    });
  }
});

describe('parseQuotationRequest', () => {
  test('passes through structured items', async () => {
    const out = { items: [{ productId: 'p1', quantity: 5, sizes: [{ size: 'M', qty: 5 }] }], unmatchedText: [] };
    gem.impl = reply(out);
    assert.deepEqual(await ai.parseQuotationRequest('5 polos M', { products }), out);
    const req = gem.requests[0];
    assert.equal(req.contents, '5 polos M');
    assert.match(req.config.systemInstruction, /p2 \| Hoodie \| outdoor_wear \| null/);
    assert.deepEqual(req.config.responseSchema.required, ['items', 'unmatchedText']);
  });

  test('missing unmatchedText is normalised to an empty array', async () => {
    gem.impl = reply({ items: [{ productId: 'p1', quantity: 2 }] });
    assert.deepEqual(await ai.parseQuotationRequest('2 polos', { products }), { items: [{ productId: 'p1', quantity: 2 }], unmatchedText: [] });
  });

  for (const bad of [...MALFORMED, 'null', '[]', '{}', '{"items":{}}', '{"items":[],"unmatchedText":"x"}']) {
    test(`malformed output ${JSON.stringify(bad)} → whole text becomes unmatched`, async () => {
      gem.impl = async () => ({ text: bad });
      assert.deepEqual(await ai.parseQuotationRequest('300 tees', { products }), { items: [], unmatchedText: ['300 tees'] });
    });
  }
});
