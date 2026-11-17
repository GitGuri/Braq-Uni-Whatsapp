// core/money, core/rbac, core/logger (redaction + request context),
// core/errors (error middleware) and core/http helpers — pure, no database.
import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src, nock } from './_setup.js';

let money, rbac, log, errors, http, express, request, z;
before(async () => {
  money = await import(src('core/money.js'));
  rbac = await import(src('core/rbac.js'));
  log = await import(src('core/logger.js'));
  errors = await import(src('core/errors.js'));
  http = await import(src('core/http.js'));
  express = (await import('express')).default;
  request = (await import('supertest')).default;
  ({ z } = await import('zod'));
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
});

describe('core/money', () => {
  test('business constants are defined once', () => {
    assert.deepEqual(
      [money.VAT_RATE_BP, money.VAT_PERCENT, money.DEPOSIT_PERCENT, money.QUOTE_VALIDITY_DAYS, money.TICKET_SLA_HOURS, money.QUOTE_SLA_HOURS],
      [1500, 15, 60, 30, 4, 4]);
  });

  test('toCents / toCentsOrNull / fromCents', () => {
    assert.equal(money.toCents('12.34'), 1234);
    assert.equal(money.toCents(0.1 + 0.2), 30);
    assert.equal(money.toCents('abc'), 0);
    assert.equal(money.toCents(undefined), 0);
    assert.equal(money.toCentsOrNull(''), null);
    assert.equal(money.toCentsOrNull(null), null);
    assert.equal(money.toCentsOrNull('x'), null);
    assert.equal(money.toCentsOrNull('0'), 0);
    assert.equal(money.fromCents(12345), 123.45);
  });

  test('formatting', () => {
    assert.equal(money.centsToFixed(5), '0.05');
    assert.equal(money.formatRand(123450), 'R 1234.50');
  });

  test('VAT is 15% half-up to the cent', () => {
    assert.equal(money.vatCents(15050), 2258);   // 22.575 → 22.58
    assert.equal(money.vatCents(10), 2);         // 1.5c → 2c
    assert.equal(money.vatCents(0), 0);
    assert.deepEqual(money.calcTotals([100000, 20000]), { subtotalCents: 120000, vatCents: 18000, totalCents: 138000 });
    assert.deepEqual(money.calcTotals([]), { subtotalCents: 0, vatCents: 0, totalCents: 0 });
  });

  test('deposit split: 60% rounded, balance is the remainder (sums exactly)', () => {
    assert.deepEqual(money.splitDeposit(33333), { depositCents: 20000, balanceCents: 13333 });
    assert.deepEqual(money.splitDeposit(15344), { depositCents: 9206, balanceCents: 6138 });
    assert.deepEqual(money.splitDeposit(100, 50), { depositCents: 50, balanceCents: 50 });
    for (let c = 0; c < 2000; c += 7) {
      const { depositCents, balanceCents } = money.splitDeposit(c);
      assert.equal(depositCents + balanceCents, c);
    }
    assert.equal(money.depositForTotal(115), 69);
    assert.equal(money.depositForTotal('153.44'), 92.06);
  });
});

describe('core/rbac', () => {
  const admin = { role: 'admin' };
  const manager = { role: 'manager' };
  const consultant = { role: 'consultant' };

  test('permission map', () => {
    for (const p of ['order.override', 'broadcast.send', 'analytics.view', 'settings.write', 'product.write', 'po.create', 'catalog.write']) {
      assert.ok(rbac.can(admin, p) && rbac.can(manager, p), p);
      assert.ok(!rbac.can(consultant, p), `consultant must not have ${p}`);
    }
    assert.ok(rbac.can(admin, 'staff.manage'));
    assert.ok(!rbac.can(manager, 'staff.manage'));
    assert.ok(!rbac.can(admin, 'no.such.permission'));
    assert.ok(!rbac.can(null, 'broadcast.send'));
    assert.ok(!rbac.can({}, 'broadcast.send'));
  });

  test('permissionsFor lists what a role holds', () => {
    assert.deepEqual(rbac.permissionsFor(consultant), []);
    assert.ok(rbac.permissionsFor(admin).includes('staff.manage'));
    assert.ok(!rbac.permissionsFor(manager).includes('staff.manage'));
  });

  test('requirePermission: 403 JSON unless allowed; unknown permission throws at startup', () => {
    const mw = rbac.requirePermission('broadcast.send');
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let next = 0;
    mw({ staff: consultant }, res, () => next++);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /Forbidden/);
    mw({ staff: manager }, res, () => next++);
    assert.equal(next, 1);
    assert.throws(() => rbac.requirePermission('typo.perm'), /Unknown permission/);
  });
});

describe('core/logger redaction', () => {
  test('phone numbers, emails and JWTs are masked in strings', () => {
    const s = log.redactString('to 27821234567 / +27821234567 mail ann.lee@example.co.za token eyJhbGciOi.eyJpZCI6MX0.abc_DEF-1');
    assert.ok(!s.includes('27821234567'));
    assert.ok(s.includes('27******567'));
    assert.ok(!s.includes('ann.lee@example.co.za'));
    assert.ok(s.includes('a***@example.co.za'));
    assert.ok(s.includes('[jwt]'));
  });

  test('ids, short numbers and UUIDs are left alone', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    assert.equal(log.redactString(`order ${uuid} qty 1200 ref BRQ-O-00042`), `order ${uuid} qty 1200 ref BRQ-O-00042`);
  });

  test('message bodies / secrets in meta objects are dropped; nesting handled', () => {
    const out = log.redact({ to: '27821234567', body: 'my address is 1 Main Rd', nested: { email: 'x@y.com', password: 'p' }, list: ['27821234567'] });
    assert.equal(out.body, '[redacted]');
    assert.equal(out.nested.password, '[redacted]');
    assert.equal(out.nested.email, 'x***@y.com');
    assert.deepEqual(out.list, ['27******567']);
    assert.equal(out.to, '27******567');
  });

  test('runWithContext exposes the request id to code running inside it', async () => {
    const seen = await log.runWithContext({ requestId: 'r-1' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return log.currentContext().requestId;
    });
    assert.equal(seen, 'r-1');
    assert.equal(log.currentContext().requestId, undefined);
  });
});

describe('SEC-4 catchAsyncRoutes: unwrapped handlers can no longer crash the process', () => {
  let app;
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  before(() => {
    process.on('unhandledRejection', onUnhandled);
    app = express();
    const r = express.Router();
    r.use((req, _res, next) => { req.seen = true; next(); });
    r.get('/reject', async () => { throw new Error('db down'); });
    r.get('/sync-throw', (req) => { req.body.message.trim(); });
    r.get('/http-error', async () => { throw new errors.HttpError(409, 'Nope'); });
    r.get('/ok', async (req, res) => res.json({ seen: req.seen }));
    r.use((err, _req, res, _next) => res.status(599).json({ own: err.message })); // router error handler untouched
    const nested = express.Router();
    nested.get('/n', async () => { throw new Error('nested'); });
    const outer = express.Router();
    outer.use('/nested', nested);
    http.catchAsyncRoutes(r);
    http.catchAsyncRoutes(outer);
    app.use(r);
    app.use(outer);
    app.use(errors.errorMiddleware);
  });

  test('a rejected async handler → 500 through the error middleware, no unhandled rejection', async () => {
    const res = await request(app).get('/reject');
    assert.equal(res.status, 599, 'reaches the router-level error handler first');
    const n = await request(app).get('/nested/n');
    assert.deepEqual([n.status, n.body], [500, { error: 'Internal server error' }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
    process.off('unhandledRejection', onUnhandled);
  });

  test('a synchronous throw is caught too; normal handlers and middleware are unchanged', async () => {
    assert.equal((await request(app).get('/sync-throw')).status, 599);
    assert.deepEqual((await request(app).get('/ok')).body, { seen: true });
  });

  test('wrapping twice is harmless', () => {
    const r = express.Router();
    r.get('/x', async () => {});
    http.catchAsyncRoutes(r);
    const first = r.stack[0].route.stack[0].handle;
    http.catchAsyncRoutes(r);
    assert.equal(r.stack[0].route.stack[0].handle, first);
  });
});

describe('core/errors + core/http through express', () => {
  let app;
  before(() => {
    app = express();
    app.use(log.requestContext);
    app.use(express.json({ limit: '1kb' }));
    app.get('/zod', http.asyncHandler(async () => { z.object({ a: z.string() }).parse({}); }));
    app.get('/http', http.asyncHandler(async () => { throw new errors.HttpError(409, 'Conflict here', { code: 'X_CONFLICT' }); }));
    app.get('/pg', http.asyncHandler(async () => { throw Object.assign(new Error('dup'), { code: '23505' }); }));
    app.get('/boom', http.asyncHandler(async () => { throw new Error('secret internals'); }));
    app.get('/sync', http.asyncHandler(() => { throw new errors.HttpError(418, 'teapot'); }));
    app.post('/echo', (req, res) => res.json(req.body));
    app.post('/valid', http.validate({ body: z.object({ n: z.coerce.number() }) }), (req, res) => res.json(req.valid.body));
    const r = express.Router();
    r.param('id', http.uuidParam('widget'));
    r.get('/w/:id', (req, res) => res.json({ ok: true }));
    app.use(r);
    app.get('/paged', (req, res) => http.paged(res, 'orders', { items: [1, 2], total: 9, page: 1, limit: 2 }));
    app.get('/rid', (req, res) => res.json({ id: log.currentContext().requestId }));
    app.use(errors.errorMiddleware);
  });

  test('ZodError → 400 with readable message', async () => {
    const r = await request(app).get('/zod');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /a: Required/);
  });

  test('HttpError → its status, message and extra fields', async () => {
    const r = await request(app).get('/http');
    assert.deepEqual([r.status, r.body], [409, { error: 'Conflict here', code: 'X_CONFLICT' }]);
    assert.deepEqual((await request(app).get('/sync')).body, { error: 'teapot' });
  });

  test('mapped Postgres codes → client errors; anything else → generic 500', async () => {
    assert.deepEqual([(await request(app).get('/pg')).status, (await request(app).get('/pg')).body], [409, { error: 'Record already exists' }]);
    const boom = await request(app).get('/boom');
    assert.deepEqual([boom.status, boom.body], [500, { error: 'Internal server error' }]);
  });

  test('body-parser errors keep their 400 / 413', async () => {
    const bad = await request(app).post('/echo').set('Content-Type', 'application/json').send('{"x":');
    assert.deepEqual([bad.status, bad.body], [400, { error: 'Malformed JSON body' }]);
    const big = await request(app).post('/echo').set('Content-Type', 'application/json').send(JSON.stringify({ x: 'y'.repeat(2048) }));
    assert.deepEqual([big.status, big.body], [413, { error: 'Request body too large' }]);
  });

  test('validate() puts parsed values on req.valid or answers 400', async () => {
    assert.deepEqual((await request(app).post('/valid').send({ n: '5' })).body, { n: 5 });
    assert.equal((await request(app).post('/valid').send({ n: 'x' })).status, 400);
  });

  test('uuidParam rejects malformed ids with a labelled 400', async () => {
    assert.deepEqual((await request(app).get('/w/abc')).body, { error: 'Invalid widget id' });
    assert.equal((await request(app).get('/w/11111111-1111-4111-8111-111111111111')).status, 200);
  });

  test('paged() returns { items, total, page, limit } plus the legacy key', async () => {
    assert.deepEqual((await request(app).get('/paged')).body, { items: [1, 2], total: 9, page: 1, limit: 2, orders: [1, 2] });
  });

  test('request id is available to handlers and echoed in X-Request-Id', async () => {
    const r = await request(app).get('/rid').set('X-Request-Id', 'req-42');
    assert.equal(r.body.id, 'req-42');
    assert.equal(r.headers['x-request-id'], 'req-42');
  });
});
