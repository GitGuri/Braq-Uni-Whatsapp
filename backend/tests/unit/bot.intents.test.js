// Bot intent detection and registration parsing (pure, no database).
import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

let I, P;
before(async () => {
  I = await import(src('modules/bot/intents.js'));
  P = await import(src('modules/bot/profile.js'));
});

const type = (t) => I.detectIntent(t).type;
const kw = (t) => { const i = I.detectIntent(t); return i.type === 'keyword' ? i.value : i.type; };

describe('accept everywhere — before the "quote" keyword', () => {
  for (const t of ['accept', 'Accept', 'I accept', 'yes accept', 'Yes, I accept', 'accepted', 'go ahead', 'accept the quote',
    'I accept the quotation', 'we accept the quote please', 'Yes I want to accept']) {
    test(`"${t}" → accept`, () => assert.equal(type(t), 'accept'));
  }
  test('"accept BRQ-Q-…" carries the reference', () => {
    assert.deepEqual(I.detectIntent('accept brq-q-20261021-0101'), { type: 'accept', ref: 'BRQ-Q-20261021-0101' });
    assert.deepEqual(I.detectIntent('I accept quote BRQ-Q-00012'), { type: 'accept', ref: 'BRQ-Q-00012' });
  });
  for (const t of ["I don't accept", 'yes but I do not accept']) {
    test(`"${t}" is not an acceptance`, () => assert.notEqual(type(t), 'accept'));
  }
});

describe('escapes and consultant', () => {
  test('menu / cancel / back', () => {
    for (const t of ['0', 'menu', 'Main menu', 'cancel', 'start over']) assert.equal(type(t), 'main_menu', t);
    assert.equal(type('back'), 'back');
  });
  test('"9" is a digit consultant request; the words are exact (work inside data collection)', () => {
    assert.deepEqual(I.detectIntent('9'), { type: 'consultant', digit: true });
    for (const t of ['agent', 'Human', 'person', 'consultant', 'someone']) assert.deepEqual(I.detectIntent(t), { type: 'consultant', exact: true }, t);
    for (const t of ['Can I talk to a person?', 'I want to speak to a human', 'please call me', 'speak to a consultant']) {
      assert.equal(type(t), 'consultant', t);
      assert.equal(I.detectIntent(t).exact, undefined, t);
    }
  });
  test('menu digits 1–8', () => {
    assert.deepEqual(I.detectIntent('3'), { type: 'menu', value: 3 });
    assert.equal(type('10'), 'freetext');
  });
});

describe('keyword false positives fixed', () => {
  const cases = [
    ['print my invoice', 'freetext'],
    ['can you print my invoice please', 'freetext'],
    ['where do I place an order', 'make_order'],
    ['How do I place an order?', 'make_order'],
    ['Where is my order?', 'track'],
    ['how many hours does embroidery take', 'branding'],
    ['how many hours will it take', 'freetext'],
    ['What are your trading hours?', 'hours'],
    ['Are you open on Saturday?', 'hours'],
    ['do you do screen printing', 'branding'],
    ['can you print our logo on shirts', 'branding'],
    ['Do you sell school tracksuits?', 'freetext'],
    ['I want a brand new blazer', 'freetext'],
    ['Hi, I need a quote for 30 Dalview jerseys', 'quote'],
    ['where is my quote', 'quote_status'],
    ['please resend my quotation', 'quote_status'],
    ['Is my quote ready?', 'quote_status'],
    ['Can I get a quote?', 'quote'],
    ['order 2 jerseys size 10', 'make_order'],
    ['I want to order 20 polos', 'make_order'],
    ['order status', 'track'],
    ['my shirts arrived damaged', 'ticket'],
    ['report a problem', 'ticket'],
    ['Hello there', 'greeting'],
    ['good morning', 'greeting'],
    ['thanks!', 'thanks'],
  ];
  for (const [t, want] of cases) test(`"${t}" → ${want}`, () => assert.equal(kw(t), want));
});

describe('carriesDetail: does the first message already describe the request?', () => {
  test('items / quantities → yes; bare requests → no', () => {
    assert.equal(I.carriesDetail('Hi, I need a quote for 30 Dalview jerseys'), true);
    assert.equal(I.carriesDetail('order 2 jerseys size 10'), true);
    assert.equal(I.carriesDetail('I want a quote'), false);
    assert.equal(I.carriesDetail('Can I get a quotation please'), false);
    assert.equal(I.carriesDetail('place an order'), false);
  });
  test('confirmations', () => {
    for (const t of ['1', 'yes', 'OK', 'confirm', 'go ahead', '👍']) assert.ok(I.CONFIRM_RE.test(t), t);
    for (const t of ['2', 'no', 'cancel', 'something else']) assert.ok(I.DECLINE_RE.test(t), t);
    assert.ok(!I.CONFIRM_RE.test('yes but change the colour'));
  });
});

describe('registration: names and one-message answers', () => {
  test('isValidName rejects greetings, numbers, emoji and links', () => {
    for (const ok of ['Thabo Mokoena', 'Zoë Ñandú', "Anne-Marie O'Neil", 'J. Smith', 'Test User']) assert.ok(P.isValidName(ok), ok);
    for (const bad of ['hi', 'Hello', 'yes', '12345', 'Thabo 2', '👍', '😊😊', 'a', 'www.x.com', 'menu', 'x'.repeat(61),
      'one two three four five six seven', '']) assert.ok(!P.isValidName(bad), bad);
  });
  test('tidyName capitalises all-lower / all-upper input only', () => {
    assert.equal(P.tidyName('thabo mokoena'), 'Thabo Mokoena');
    assert.equal(P.tidyName('THABO'), 'Thabo');
    assert.equal(P.tidyName('McDonald Smith'), 'McDonald Smith');
  });
  test('comma, numbered and multi-line answers', () => {
    const want = ['name', 'org', 'fulfilment'];
    let r = P.parseAnswersSimple('Thabo Mokoena, Dalview Primary, collect', want);
    assert.deepEqual([r.name, r.org, r.fulfilment, r.complete], ['Thabo Mokoena', 'Dalview Primary', 'collect', true]);
    r = P.parseAnswersSimple('1) Thabo Mokoena 2) Acme Security 3) deliver to 12 Main Rd, Brakpan', want);
    assert.deepEqual([r.name, r.org, r.fulfilment, r.address], ['Thabo Mokoena', 'Acme Security', 'delivery', '12 Main Rd, Brakpan']);
    r = P.parseAnswersSimple('Thabo\nI will collect\nDalpark Primary', want);
    assert.deepEqual([r.name, r.org, r.fulfilment], ['Thabo', 'Dalpark Primary', 'collect']);
    r = P.parseAnswersSimple('Name: Lerato\nSchool: Anzac Primary', ['name', 'org']);
    assert.deepEqual([r.name, r.org, r.complete], ['Lerato', 'Anzac Primary', true]);
  });
  test('a single answer for a single missing field', () => {
    assert.equal(P.parseAnswersSimple('Dalview Primary', ['org']).org, 'Dalview Primary');
    assert.equal(P.parseAnswersSimple('collect please', ['fulfilment']).fulfilment, 'collect');
    assert.equal(P.parseAnswersSimple('Only one answer', ['name', 'org']).complete, false, 'not enough answers → AI / re-ask');
  });
  test('readFulfilment and school detection', () => {
    assert.deepEqual(P.readFulfilment('I will collect'), { fulfilment: 'collect', address: null });
    assert.equal(P.readFulfilment('please deliver to 5 Long Street, Benoni 1501').fulfilment, 'delivery');
    assert.equal(P.readFulfilment('deliver').address, null);
    assert.ok(P.looksLikeSchool('Laerskool Dalview') && P.looksLikeSchool('Dalpark Secondary'));
    assert.ok(!P.looksLikeSchool('Acme Security'));
  });
  test('missingFields: profile name counts; complete profiles only miss collect/deliver for orders', () => {
    assert.deepEqual(P.missingFields({ name: 'Test User', profile_complete: false }), ['org']);
    assert.deepEqual(P.missingFields({ name: 'hi', profile_complete: false }), ['name', 'org']);
    assert.deepEqual(P.missingFields({ name: 'Client 3fa9', profile_complete: true }), []);
    assert.deepEqual(P.missingFields({ name: 'Ann', profile_complete: true }, 'order'), ['fulfilment']);
    assert.deepEqual(P.missingFields({ name: 'Ann', profile_complete: true, physical_address: 'x' }, 'order'), []);
    assert.equal(P.orgKindFor({ client_type: 'corporate' }), 'company');
    assert.equal(P.orgKindFor({ client_type: 'retail' }, { bulk: true }), 'company');
    assert.equal(P.orgKindFor({ client_type: 'retail' }, { parent: true }), 'school');
    assert.equal(P.orgKindFor({ client_type: 'retail' }), 'either');
  });
});
