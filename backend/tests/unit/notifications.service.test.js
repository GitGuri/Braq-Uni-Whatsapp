// Consultant notifications: who gets which email, and what it says. The
// notifiers queue an 'email.send' job on the caller's db client (the outbox);
// Resend delivery itself (routing, sender, errors) is integrations/email.client.js.
import './_setup.js';
import { describe, test, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src, nock, makeFakeDb, mockPool, assertClean } from './_setup.js';

const db = makeFakeDb();
let svc, email, config;
before(async () => {
  mockPool(db);
  ({ config } = await import(src('core/config.js')));
  svc = await import(src('modules/notifications/service.js'));
  email = await import(src('integrations/email.client.js'));
});

const tx = { query: (...a) => db.query(...a) };
const consultants = (rows) => db.on(/FROM staff WHERE role = 'consultant'/, { rows });
/** Emails queued so far: the email.send job payloads. */
const queued = () => db.find(/INSERT INTO jobs/)
  .filter((c) => c.params[0] === 'email.send')
  .map((c) => JSON.parse(c.params[1]));

beforeEach(() => {
  db.reset();
  db.on(/INSERT INTO jobs/, { rows: [{ id: 1 }] });
  config.resend.overrideEmail = '';
  config.resend.fromEmail = 'notifications@test.local';
});
afterEach(() => { nock.cleanAll(); mock.timers.reset(); });

describe('recipients (queued through the outbox)', () => {
  test('no active consultants → nothing queued, but notified_at is still stamped', async () => {
    consultants([]);
    await svc.notifyNewQuotation(tx, { id: 'q1', reference: 'Q', line_items: [] }, {});
    assert.equal(queued().length, 0);
    assert.deepEqual(db.find(/UPDATE quotations SET notified_at/)[0].params, ['q1']);
  });

  test('consultants without emails → skipped', async () => {
    consultants([{ name: 'A', email: null }, { name: 'B', email: '' }]);
    await svc.notifyQuotationAccepted(tx, { id: 'q', reference: 'Q', total: 1 }, {});
    assert.equal(queued().length, 0);
  });

  test('queues one email.send to every consultant email, on the caller\'s client', async () => {
    consultants([{ name: 'A', email: 'a@x.co' }, { name: 'B', email: null }, { name: 'C', email: 'c@x.co' }]);
    await svc.notifyNewOrder(tx, { id: 'o1', reference: 'BRQ-O-00001', deposit_amount: '600', created_at: '2026-10-20T08:00:00Z' }, { name: 'Ann', client_type: 'corporate', whatsapp_number: '2782' });
    const [e] = queued();
    assert.deepEqual(e.to, ['a@x.co', 'c@x.co']);
    assert.equal(e.subject, '🛒 New WhatsApp Order — Ref BRQ-O-00001');
    assert.match(e.text, /Deposit due \(60%\): R 600\.00/);
    assert.match(e.text, /http:\/\/dash\.test\/orders\/o1/);
    assert.ok(db.find(/pg_notify/).length >= 1, 'workers are woken');
  });
});

describe('email transport (integrations/email.client.js)', () => {
  let sent;
  function interceptResend({ status = 200, body = { id: 'email_1' } } = {}) {
    return nock('https://api.resend.com').post('/emails', (b) => { sent.push(b); return true; }).reply(status, body);
  }
  beforeEach(() => { sent = []; });

  test('sends from FROM_EMAIL with the API key', async () => {
    const scope = nock('https://api.resend.com', { reqheaders: { authorization: 'Bearer re_fake' } })
      .post('/emails', (b) => { sent.push(b); return true; }).reply(200, { id: 'e1' });
    assert.equal(await email.sendEmail({ to: ['a@x.co'], subject: 'S', text: 'T' }), 'e1');
    assert.ok(scope.isDone());
    assert.equal(sent[0].from, 'Braq Connect <notifications@test.local>');
  });

  test('NOTIFICATION_OVERRIDE_EMAIL routes all mail to the single override address', async () => {
    config.resend.overrideEmail = 'me@override.test';
    interceptResend();
    await email.sendEmail({ to: ['a@x.co', 'b@x.co'], subject: 'S', text: 'T' });
    assert.deepEqual(sent[0].to, ['me@override.test']);
  });

  test('onboarding@resend.dev sender still sends (warning branch)', async () => {
    config.resend.fromEmail = 'onboarding@resend.dev';
    interceptResend();
    await email.sendEmail({ to: 'a@x.co', subject: 'S', text: 'T' });
    assert.equal(sent[0].from, 'Braq Connect <onboarding@resend.dev>');
  });

  test('Resend error response → throws "Resend error" (the email.send job retries)', async () => {
    interceptResend({ status: 403, body: { name: 'validation_error', message: 'domain not verified', statusCode: 403 } });
    await assert.rejects(email.sendEmail({ to: 'a@x.co', subject: 'S', text: 'T' }), /Resend error: .*domain not verified/);
  });
});

describe('message bodies', () => {
  beforeEach(() => { consultants([{ name: 'A', email: 'a@x.co' }]); });

  test('notifyNewQuotation summarises line items (name → description → "item") and stamps notified_at', async () => {
    await svc.notifyNewQuotation(tx, {
      id: 'q1', reference: 'BRQ-Q-1', created_at: '2026-10-20T08:00:00Z',
      line_items: [{ quantity: 5, name: 'Polo' }, { quantity: 2, description: 'Cap' }, { quantity: 1 }],
    }, { name: 'Ann', client_type: 'school', whatsapp_number: '2782' });
    const [e] = queued();
    assert.equal(e.subject, '🆕 New Quotation Enquiry — Ref BRQ-Q-1');
    assert.match(e.text, /Summary: 5× Polo, 2× Cap, 1× item/);
    assert.match(e.text, /Client: Ann \(school\)/);
    assert.match(e.text, /WhatsApp: 2782/);
    assert.match(e.text, /http:\/\/dash\.test\/jobs\/q1/, 'links to the job page');
    assertClean(assert, e.text);
    assert.deepEqual(db.find(/UPDATE quotations SET notified_at/)[0].params, ['q1']);
  });

  test('notifyNewQuotation falls back to notes, then "—"; client fallbacks', async () => {
    await svc.notifyNewQuotation(tx, { id: 'q', reference: 'R', line_items: [], notes: 'n'.repeat(200) }, { wa_id: 'WA1' });
    await svc.notifyNewQuotation(tx, { id: 'q', reference: 'R' }, {});
    const [a, b] = queued();
    assert.match(a.text, new RegExp(`Summary: ${'n'.repeat(150)}…\n`));
    assert.match(a.text, /Client: Unknown \(unknown\)/);
    assert.match(a.text, /WhatsApp: WA1/);
    assert.match(b.text, /Summary: —/);
    assert.match(b.text, /WhatsApp: —/);
  });

  test('notifyNewTicket: category labels, unknown category passthrough, order ref', async () => {
    await svc.notifyNewTicket(tx, { id: 't1', category: 'missing_item', description: 'short' }, { name: 'B' }, 'BRQ-O-00009');
    await svc.notifyNewTicket(tx, { id: 't2', category: 'weird' }, {});
    const [a, b] = queued();
    assert.equal(a.subject, '🎫 New Ticket — Missing item');
    assert.match(a.text, /Order ref \(if linked\): BRQ-O-00009/);
    assert.equal(b.subject, '🎫 New Ticket — weird');
    assert.match(b.text, /Order ref \(if linked\): N\/A/);
    assert.match(b.text, /Description: —/);
    assert.deepEqual(db.find(/UPDATE tickets SET notified_at/).map((c) => c.params[0]), ['t1', 't2']);
  });

  test('notifyConsultantRequested: subject falls back to WhatsApp number, context excerpt 200', async () => {
    await svc.notifyConsultantRequested(tx, { id: 'cv1' }, { whatsapp_number: '2782' }, 'c'.repeat(250));
    const [e] = queued();
    assert.equal(e.subject, '💬 Customer wants to speak to a consultant — 2782');
    assert.match(e.text, new RegExp(`Context: ${'c'.repeat(200)}…`));
    assert.match(e.text, /inbox\/cv1/);
    assert.deepEqual(db.find(/UPDATE conversations SET notified_at/)[0].params, ['cv1']);
  });

  test('notifyConsultantRequested default context and Unknown subject', async () => {
    await svc.notifyConsultantRequested(tx, { id: 'cv1' }, {});
    const [e] = queued();
    assert.match(e.subject, /— Unknown$/);
    assert.match(e.text, /Context: General enquiry/);
  });

  test('job links: an order with a quotation links to /jobs/<quotationId>; accepted quotation too', async () => {
    await svc.notifyNewOrder(tx, { id: 'o9', quotation_id: 'q9', reference: 'R' }, {});
    await svc.notifyQuotationAccepted(tx, { id: 'q8', reference: 'Q', total: 1 }, {});
    const [a, b] = queued();
    assert.match(a.text, /http:\/\/dash\.test\/jobs\/q9/);
    assert.match(b.text, /http:\/\/dash\.test\/jobs\/q8/);
    assert.match(b.text, /Total: R 1\.00 \(incl\. VAT\)/);
  });

  test('timestamps rendered in Africa/Johannesburg', async () => {
    await svc.notifyNewOrder(tx, { id: 'o', reference: 'R', created_at: '2026-10-20T22:30:00Z' }, {});
    const [e] = queued();
    assert.match(e.text, /Received: 2026\/10\/21,? 00:30:00/);
    assert.match(e.text, /Deposit due \(60%\): R 0\.00/);
  });
});

describe('notifyProofFeedback', () => {
  test('approved → emails the order owner, links to the job', async () => {
    consultants([{ name: 'A', email: 'a@x.co' }]);
    db.on(/FROM staff WHERE id = \$1 AND is_active/, { rows: [{ id: 's1', name: 'Owner', email: 'owner@x.co' }] });
    await svc.notifyProofFeedback(tx, { id: 'o1', reference: 'BRQ-O-00010', quotation_id: 'q1', assigned_staff_id: 's1' }, { name: 'Ann' }, { status: 'approved' });
    const [e] = queued();
    assert.deepEqual(e.to, ['owner@x.co']);
    assert.equal(e.subject, '✅ Proof approved — Order BRQ-O-00010');
    assert.match(e.text, /http:\/\/dash\.test\/jobs\/q1/);
    assertClean(assert, e.text);
  });

  test('changes requested on an unowned order → every consultant, with the requested changes', async () => {
    consultants([{ name: 'A', email: 'a@x.co' }, { name: 'B', email: 'b@x.co' }]);
    await svc.notifyProofFeedback(tx, { id: 'o2', reference: 'BRQ-O-00011' }, {}, { status: 'revision_requested', notes: 'Bigger logo please' });
    const [e] = queued();
    assert.deepEqual(e.to, ['a@x.co', 'b@x.co']);
    assert.equal(e.subject, '✏️ Proof changes requested — Order BRQ-O-00011');
    assert.match(e.text, /Requested changes: Bigger logo please/);
    assert.match(e.text, /http:\/\/dash\.test\/orders\/o2/);
  });
});

describe('sendReminder', () => {
  beforeEach(() => {
    consultants([{ name: 'A', email: 'a@x.co' }]);
    db.on(/^UPDATE \w+ SET \w+ = NOW\(\)\s+WHERE id = \$1 AND assigned_staff_id IS NULL/, (_t, params) => ({ rows: [{ id: params[0] }] }));
  });
  const NOW = new Date('2026-10-20T12:00:00Z').getTime();

  const cases = [
    ['quotation', 'quotations', 'staff_reminder_sent_at', '/jobs/i1', 'Quotation'],
    ['ticket', 'tickets', 'reminder_sent_at', '/tickets/i1', 'Ticket'],
    ['conversation', 'conversations', 'reminder_sent_at', '/inbox/i1', 'Consultant Request'],
  ];
  for (const [type, table, col, link, label] of cases) {
    test(`${type}: link, label, and ${table}.${col} stamped`, async () => {
      mock.timers.enable({ apis: ['Date'], now: NOW });
      await svc.sendReminder(tx, { id: 'i1', reference: 'REF', client_name: 'Ann', notified_at: new Date(NOW - 3 * 3600_000).toISOString() }, type);
      const [e] = queued();
      assert.equal(e.subject, '⏰ Reminder — still unclaimed: REF');
      assert.match(e.text, /3 hours after it came in/);
      assert.match(e.text, new RegExp(`Type: ${label}`));
      assert.ok(e.text.includes(`http://dash.test${link}`));
      const up = db.find(/^UPDATE /).at(-1);
      assert.equal(up.text.replace(/\s+/g, ' '),
        `UPDATE ${table} SET ${col} = NOW() WHERE id = $1 AND assigned_staff_id IS NULL AND ${col} IS NULL RETURNING id`);
      assert.deepEqual(up.params, ['i1']);
    });
  }

  test('Q-3: claimed (or already reminded) after the scan read it → no email, returns false', async () => {
    db.reset();
    consultants([{ name: 'A', email: 'a@x.co' }]);
    db.on(/^UPDATE \w+ SET/, { rows: [] }); // the conditional stamp matched nothing
    const sent = await svc.sendReminder(tx, { id: 'i9', reference: 'REF', notified_at: new Date().toISOString() }, 'quotation');
    assert.equal(sent, false);
    assert.equal(queued().length, 0);
  });

  test('singular "hour"; subject falls back to client name then Unknown', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    await svc.sendReminder(tx, { id: 'i', client_name: 'Bob', notified_at: new Date(NOW - 3600_000) }, 'ticket');
    await svc.sendReminder(tx, { id: 'i', notified_at: new Date(NOW - 7200_000) }, 'conversation');
    const [a, b] = queued();
    assert.match(a.text, /1 hour after/);
    assert.equal(a.subject, '⏰ Reminder — still unclaimed: Bob');
    assert.match(a.text, /Reference: N\/A/);
    assert.equal(b.subject, '⏰ Reminder — still unclaimed: Unknown');
    assert.match(b.text, /Client: —/);
  });
});
