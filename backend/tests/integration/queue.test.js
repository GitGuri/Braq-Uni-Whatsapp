// core/queue.js + workers/loop.js + scheduler + whatsapp.send / email.send handlers
// against a real Postgres.
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const queue = await t.load('core/queue.js');
const { startWorker } = await t.load('workers/loop.js');
const { scheduleDue, SCHEDULES } = await t.load('workers/scheduler.js');
const { handlers } = await t.load('workers/handlers/index.js');

beforeEach(() => t.reset());
after(() => t.stop());

const job = (id) => t.one('SELECT * FROM jobs WHERE id = $1', [id]);
async function waitFor(fn, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('enqueue', () => {
  test('inserts a pending job with defaults and returns its id', async () => {
    const id = await queue.enqueue(t.db.pool, 'email.send', { to: 'a@b.c' });
    const j = await job(id);
    assert.equal(j.type, 'email.send');
    assert.deepEqual(j.payload, { to: 'a@b.c' });
    assert.equal(j.status, 'pending');
    assert.equal(j.attempts, 0);
    assert.equal(j.max_attempts, queue.DEFAULT_MAX_ATTEMPTS);
    assert.equal(j.queue_key, null);
  });

  test('duplicate dedupeKey is ignored (returns null, one row)', async () => {
    const a = await queue.enqueue(t.db.pool, 'x', {}, { dedupeKey: 'k1' });
    const b = await queue.enqueue(t.db.pool, 'x', {}, { dedupeKey: 'k1' });
    assert.ok(a);
    assert.equal(b, null);
    assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM jobs WHERE dedupe_key = 'k1'`)).n, 1);
  });

  test('uses the caller transaction: rolled back with the domain write', async () => {
    await assert.rejects(t.db.withTransaction(async (tx) => {
      await queue.enqueue(tx, 'x', {});
      throw new Error('domain write failed');
    }), /domain write failed/);
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM jobs')).n, 0);
  });

  test('runAt / queueKey / maxAttempts are stored', async () => {
    const runAt = new Date(Date.now() + 3600_000);
    const id = await queue.enqueue(t.db.pool, 'x', {}, { runAt, queueKey: 'wa:27', maxAttempts: 2 });
    const j = await job(id);
    assert.equal(j.queue_key, 'wa:27');
    assert.equal(j.max_attempts, 2);
    assert.equal(new Date(j.run_at).getTime(), runAt.getTime());
  });
});

describe('claim / complete / fail / reclaim / prune', () => {
  test('claimBatch skips future jobs and marks claimed ones running', async () => {
    const now = await queue.enqueue(t.db.pool, 'x', {});
    await queue.enqueue(t.db.pool, 'x', {}, { runAt: new Date(Date.now() + 60_000) });
    const claimed = await queue.claimBatch(t.db.pool, 'w1', 10);
    assert.deepEqual(claimed.map((j) => Number(j.id)), [now]);
    const j = await job(now);
    assert.equal(j.status, 'running');
    assert.equal(j.locked_by, 'w1');
    assert.equal(j.attempts, 1);
  });

  test('FIFO per queue_key: the second job of a key waits for the first', async () => {
    const a = await queue.enqueue(t.db.pool, 'x', { n: 1 }, { queueKey: 'wa:1' });
    const b = await queue.enqueue(t.db.pool, 'x', { n: 2 }, { queueKey: 'wa:1' });
    const c = await queue.enqueue(t.db.pool, 'x', { n: 3 }, { queueKey: 'wa:2' });
    const first = (await queue.claimBatch(t.db.pool, 'w', 10)).map((j) => Number(j.id)).sort();
    assert.deepEqual(first, [a, c].sort());
    assert.deepEqual(await queue.claimBatch(t.db.pool, 'w', 10), [], 'b is blocked while a is running');
    await queue.complete(t.db.pool, a);
    assert.deepEqual((await queue.claimBatch(t.db.pool, 'w', 10)).map((j) => Number(j.id)), [b]);
  });

  test('concurrent claimers never get the same job (SKIP LOCKED)', async () => {
    for (let i = 0; i < 20; i++) await queue.enqueue(t.db.pool, 'x', { i });
    const batches = await Promise.all([1, 2, 3, 4].map((w) => queue.claimBatch(t.db.pool, `w${w}`, 10)));
    const ids = batches.flat().map((j) => Number(j.id));
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
  });

  test('fail → retry with backoff, then dead after max attempts', async () => {
    const id = await queue.enqueue(t.db.pool, 'x', {}, { maxAttempts: 2 });
    let [j] = await queue.claimBatch(t.db.pool, 'w', 1);
    assert.equal(await queue.fail(t.db.pool, j, new Error('boom 1')), 'retry');
    let row = await job(id);
    assert.equal(row.status, 'pending');
    assert.match(row.last_error, /boom 1/);
    assert.ok(new Date(row.run_at) > new Date(Date.now() - 1000));
    await t.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);
    [j] = await queue.claimBatch(t.db.pool, 'w', 1);
    assert.equal(j.attempts, 2);
    assert.equal(await queue.fail(t.db.pool, j, new Error('boom 2')), 'dead');
    row = await job(id);
    assert.equal(row.status, 'dead');
    assert.ok(row.finished_at);
  });

  test('PermanentJobError dead-letters immediately', async () => {
    const id = await queue.enqueue(t.db.pool, 'x', {});
    const [j] = await queue.claimBatch(t.db.pool, 'w', 1);
    assert.equal(await queue.fail(t.db.pool, j, new queue.PermanentJobError('bad payload')), 'dead');
    assert.equal((await job(id)).status, 'dead');
  });

  test('backoff grows exponentially and is capped at 1 hour', () => {
    assert.ok(queue.backoffMs(1, 5000) >= 10000 && queue.backoffMs(1, 5000) < 11000);
    assert.ok(queue.backoffMs(3, 5000) >= 40000);
    assert.ok(queue.backoffMs(30, 5000) <= 3600_000 + 1000);
  });

  test('reclaimStale returns abandoned running jobs to pending (dead when out of attempts)', async () => {
    const a = await queue.enqueue(t.db.pool, 'x', {});
    const b = await queue.enqueue(t.db.pool, 'x', {}, { maxAttempts: 1 });
    await queue.claimBatch(t.db.pool, 'crashed', 10);
    await t.query(`UPDATE jobs SET locked_at = now() - interval '10 minutes'`);
    assert.equal(await queue.reclaimStale(t.db.pool), 2);
    assert.equal((await job(a)).status, 'pending');
    assert.equal((await job(a)).locked_by, null);
    assert.equal((await job(b)).status, 'dead');
  });

  test('prune deletes done jobs older than 14 days only', async () => {
    const old = await queue.enqueue(t.db.pool, 'x', {});
    const fresh = await queue.enqueue(t.db.pool, 'x', {});
    await t.query(`UPDATE jobs SET status = 'done', finished_at = now() - interval '15 days' WHERE id = $1`, [old]);
    await t.query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [fresh]);
    assert.equal(await queue.prune(t.db.pool), 1);
    assert.equal(await job(old), undefined);
    assert.ok(await job(fresh));
  });
});

describe('worker loop', () => {
  test('runs handlers, completes jobs, retries failures and dead-letters unknown types', async () => {
    const seen = [];
    let failOnce = true;
    const worker = startWorker({
      pollMs: 20,
      listen: false,
      handlers: {
        ok: async (p) => { seen.push(p.n); },
        flaky: async () => { if (failOnce) { failOnce = false; throw new Error('transient'); } },
      },
    });
    try {
      const ok = await queue.enqueue(t.db.pool, 'ok', { n: 1 });
      const flaky = await queue.enqueue(t.db.pool, 'flaky', {});
      const unknown = await queue.enqueue(t.db.pool, 'nope', {});
      await waitFor(async () => (await job(ok)).status === 'done');
      assert.deepEqual(seen, [1]);
      await waitFor(async () => (await job(unknown)).status === 'dead');
      assert.match((await job(unknown)).last_error, /No handler for job type "nope"/);
      await waitFor(async () => (await job(flaky)).status === 'done', { timeoutMs: 8000 });
      assert.equal((await job(flaky)).attempts, 2);
    } finally {
      await worker.stop();
    }
  });

  test('jobs with the same queue_key run strictly in order', async () => {
    const order = [];
    const worker = startWorker({
      pollMs: 10, listen: false, concurrency: 4,
      handlers: { step: async (p) => { await new Promise((r) => setTimeout(r, 5 * (5 - p.n))); order.push(p.n); } },
    });
    try {
      for (let n = 1; n <= 5; n++) await queue.enqueue(t.db.pool, 'step', { n }, { queueKey: 'wa:same' });
      await waitFor(async () => (await t.one(`SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'done'`)).n === 5);
      assert.deepEqual(order, [1, 2, 3, 4, 5]);
    } finally {
      await worker.stop();
    }
  });
});

describe('scheduler', () => {
  test('one job per schedule per time bucket, across repeated calls / instances', async () => {
    const now = Date.UTC(2026, 9, 21, 8, 10);
    const first = await scheduleDue({ now });
    assert.deepEqual(first.map((e) => e.type).sort(), SCHEDULES.map((s) => s.type).sort());
    assert.deepEqual(await scheduleDue({ now: now + 60_000 }), [], 'same bucket → deduped');
    const next = await scheduleDue({ now: now + 30 * 60_000 });
    assert.equal(next.length, SCHEDULES.length, 'next bucket → new jobs');
    const keys = (await t.query(`SELECT dedupe_key FROM jobs ORDER BY id`)).rows.map((r) => r.dedupe_key);
    assert.ok(keys.every((k) => /^(reminder\.scan|quotation\.expire):\d+$/.test(k)));
  });
});

describe('handlers', () => {
  const run = async (type, payload) => {
    const id = await queue.enqueue(t.db.pool, type, payload);
    const [j] = await queue.claimBatch(t.db.pool, 'test', 1);
    assert.equal(Number(j.id), id);
    return { result: await handlers[type](j.payload, { job: j }), job: j };
  };

  test('whatsapp.send: sends the text and stores the outbound message with job_id', async () => {
    const client = await t.factory.client();
    const convo = await t.factory.conversation({ client_id: client.id });
    const { result, job: j } = await run('whatsapp.send', { to: client.whatsapp_number, kind: 'text', body: 'Hello there' });
    assert.equal(result.stored, true);
    assert.deepEqual(t.wa.texts(client.whatsapp_number), ['Hello there']);
    const m = await t.one('SELECT * FROM messages WHERE job_id = $1', [j.id]);
    assert.equal(m.conversation_id, convo.id);
    assert.equal(m.direction, 'outbound');
    assert.equal(m.body, 'Hello there');
    assert.equal(m.status, 'sent');
    assert.equal(m.is_read_by_staff, true);
    assert.equal(m.meta_message_id, t.wa.sent[0].id);
  });

  test('whatsapp.send: a retry of an already-sent job does not send twice', async () => {
    const client = await t.factory.client();
    await t.factory.conversation({ client_id: client.id });
    const { job: j } = await run('whatsapp.send', { to: client.whatsapp_number, body: 'Once' });
    const again = await handlers['whatsapp.send'](j.payload, { job: j });
    assert.deepEqual(again, { skipped: 'already sent' });
    assert.equal(t.wa.sent.length, 1);
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM messages WHERE job_id = $1', [j.id])).n, 1);
  });

  test('whatsapp.send: document by media id; stored body names the file', async () => {
    const client = await t.factory.client();
    const convo = await t.factory.conversation({ client_id: client.id });
    const { job: j } = await run('whatsapp.send', {
      to: client.whatsapp_number, kind: 'document', mediaId: 'M1', filename: 'Q.pdf', caption: 'Your quote', conversationId: convo.id,
    });
    assert.deepEqual(t.wa.sent[0].document, { id: 'M1', filename: 'Q.pdf', caption: 'Your quote' });
    assert.equal((await t.one('SELECT body FROM messages WHERE job_id = $1', [j.id])).body, '[document: Q.pdf] Your quote');
  });

  test('whatsapp.send: no conversation → sent but not stored; Graph failure throws (job retried)', async () => {
    const { result } = await run('whatsapp.send', { to: '27999999999', body: 'hi' });
    assert.equal(result.stored, false);
    t.wa.failNext(1);
    await assert.rejects(run('whatsapp.send', { to: '27999999999', body: 'again' }), /WhatsApp send failed/);
  });

  test('whatsapp.send: invalid payload is a permanent error', async () => {
    await assert.rejects(run('whatsapp.send', { kind: 'text', body: 'x' }), (e) => e.permanent === true);
    await assert.rejects(run('whatsapp.send', { to: '27', kind: 'image' }), (e) => e.permanent === true);
  });

  test('email.send: delivers through Resend; missing recipient is permanent', async () => {
    await run('email.send', { to: ['a@test.local'], subject: 'Hi', text: 'Body' });
    assert.equal(t.email.sent.length, 1);
    assert.deepEqual(t.email.sent[0].to, ['a@test.local']);
    assert.equal(t.email.sent[0].subject, 'Hi');
    await assert.rejects(run('email.send', { subject: 'x' }), (e) => e.permanent === true);
  });

  test('reminder.scan: reminds about items unclaimed for 2h+, once', async () => {
    await t.factory.staff({ role: 'consultant', email: 'c1@test.local' });
    const client = await t.factory.client({ name: 'Waiting Co' });
    const q = await t.factory.quotation({ client_id: client.id, status: 'draft' });
    await t.query(`UPDATE quotations SET notified_at = now() - interval '3 hours' WHERE id = $1`, [q.id]);
    const fresh = await t.factory.quotation({ client_id: client.id, status: 'draft' });
    await t.query(`UPDATE quotations SET notified_at = now() - interval '1 hour' WHERE id = $1`, [fresh.id]);

    const { result } = await run('reminder.scan', {});
    assert.deepEqual(result, { quotations: 1, tickets: 0, conversations: 0 });
    await t.drainJobs(); // the reminder email is queued (email.send)
    assert.equal(t.email.sent.length, 1);
    assert.match(t.email.sent[0].subject, /Reminder — still unclaimed/);
    assert.ok((await t.one('SELECT staff_reminder_sent_at FROM quotations WHERE id = $1', [q.id])).staff_reminder_sent_at);

    const { result: second } = await run('reminder.scan', {});
    assert.deepEqual(second, { quotations: 0, tickets: 0, conversations: 0 });
  });

  test('quotation.expire: persists expired on lapsed sent quotations', async () => {
    const lapsed = await t.factory.quotation({ status: 'sent', valid_until: '2020-01-01' });
    const valid = await t.factory.quotation({ status: 'sent', valid_until: '2999-01-01' });
    const { result } = await run('quotation.expire', {});
    assert.deepEqual(result, { expired: 1 });
    assert.equal((await t.one('SELECT status FROM quotations WHERE id = $1', [lapsed.id])).status, 'expired');
    assert.equal((await t.one('SELECT status FROM quotations WHERE id = $1', [valid.id])).status, 'sent');
  });
});
