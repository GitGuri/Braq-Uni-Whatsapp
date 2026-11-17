import './_setup.js';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { src, nock, makeFakeDb, mockPool } from './_setup.js';

// Token parsing, requireRole and uploads (no database). requireAuth's account
// re-check against the staff table and the staff route guards are covered in
// tests/integration/auth.test.js.
let auth, upload, HttpError, jwt, express, request;
const db = makeFakeDb(); // requireAuth must reject bad tokens before touching the database
before(async () => {
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/); // supertest's in-process server only
  mockPool(db);
  auth = await import(src('middleware/auth.js'));
  upload = await import(src('middleware/upload.js'));
  ({ HttpError } = await import(src('core/errors.js')));
  jwt = (await import('jsonwebtoken')).default;
  express = (await import('express')).default;
  request = (await import('supertest')).default;
});
after(() => nock.disableNetConnect());

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function run(mw, req) {
  const res = fakeRes();
  let nextCalled = 0;
  mw(req, res, () => { nextCalled++; });
  return { res, nextCalled, req };
}

// ── HttpError ─────────────────────────────────────────────────────────────────
describe('HttpError', () => {
  test('is an Error carrying status and message', () => {
    const e = new HttpError(418, 'teapot');
    assert.ok(e instanceof Error);
    assert.equal(e.status, 418);
    assert.equal(e.message, 'teapot');
    assert.ok(e.stack.includes('teapot'));
  });
});

// ── requireAuth ───────────────────────────────────────────────────────────────
describe('requireAuth', () => {
  const staff = { id: 's1', email: 'a@b.co', role: 'consultant', name: 'Ann', passwordHash: 'SECRET' };

  for (const [label, header] of [
    ['no Authorization header', undefined],
    ['empty header', ''],
    ['Basic scheme', 'Basic abc'],
    ['lowercase bearer', 'bearer abc'],
    ['Bearer without space', 'Bearerabc'],
  ]) {
    test(`${label} → 401 no token`, () => {
      const { res, nextCalled } = run(auth.requireAuth, { headers: header === undefined ? {} : { authorization: header } });
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error, /no token provided/);
      assert.equal(nextCalled, 0);
    });
  }

  for (const [label, token] of [
    ['empty token', ''],
    ['garbage', 'not.a.jwt'],
    ['wrong secret', () => jwt.sign({ id: 's1' }, 'other-secret')],
    ['expired', () => jwt.sign({ id: 's1', exp: Math.floor(Date.now() / 1000) - 10 }, 'test')],
    ['alg=none', () => jwt.sign({ id: 's1', role: 'admin' }, null, { algorithm: 'none' })],
  ]) {
    test(`${label} → 401 invalid token`, () => {
      const t = typeof token === 'function' ? token() : token;
      const { res, nextCalled } = run(auth.requireAuth, { headers: { authorization: `Bearer ${t}` } });
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error, /invalid or expired/);
      assert.equal(nextCalled, 0);
      assert.equal(db.calls.length, 0, 'no database lookup for an invalid token');
    });
  }

  test('generateToken signs only id/email/role/name with configured expiry', () => {
    const p = jwt.verify(auth.generateToken(staff), 'test');
    assert.deepEqual(Object.keys(p).sort(), ['email', 'exp', 'iat', 'id', 'name', 'role']);
    assert.equal(p.exp - p.iat, 3600);
  });
});

// ── requireRole ───────────────────────────────────────────────────────────────
describe('requireRole', () => {
  test('allowed role → next', () => {
    assert.equal(run(auth.requireRole('admin', 'manager'), { staff: { role: 'manager' } }).nextCalled, 1);
  });
  for (const [label, req] of [['other role', { staff: { role: 'consultant' } }], ['no staff', {}], ['no role', { staff: {} }]]) {
    test(`${label} → 403`, () => {
      const { res, nextCalled } = run(auth.requireRole('admin'), req);
      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /Forbidden/);
      assert.equal(nextCalled, 0);
    });
  }
  test('no roles configured → everyone forbidden', () => {
    assert.equal(run(auth.requireRole(), { staff: { role: 'admin' } }).res.statusCode, 403);
  });
});

// ── upload middleware ─────────────────────────────────────────────────────────
describe('upload middleware', () => {
  let app;
  before(() => {
    app = express();
    const wrap = (mw) => (req, res) => mw(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code ?? null });
      res.json({ name: req.file?.originalname ?? null, size: req.file?.size ?? null, mimetype: req.file?.mimetype ?? null, inMemory: Buffer.isBuffer(req.file?.buffer) });
    });
    app.post('/size', wrap(upload.uploadSizeFile));
    app.post('/attach', wrap(upload.uploadAttachment));
  });
  const send = (path, field, buf, filename, contentType) =>
    request(app).post(path).attach(field, buf, { filename, contentType });

  for (const ct of ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/csv', 'application/vnd.ms-excel']) {
    test(`size file: ${ct} accepted into memory`, async () => {
      const r = await send('/size', 'file', Buffer.from('Name,Size\nA,M\n'), 'r.csv', ct);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.inMemory, true);
      assert.equal(r.body.mimetype, ct);
    });
  }

  for (const ct of ['application/pdf', 'text/plain', 'application/zip', 'image/png']) {
    test(`size file: ${ct} rejected`, async () => {
      const r = await send('/size', 'file', Buffer.from('x'), 'x.bin', ct);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'Only .xlsx or .csv files are accepted');
    });
  }

  test('size file: exactly 5 MB accepted, 5 MB + 1 byte rejected (LIMIT_FILE_SIZE)', async () => {
    const ok = await send('/size', 'file', Buffer.alloc(5 * 1024 * 1024), 'a.csv', 'text/csv');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.size, 5 * 1024 * 1024);
    const big = await send('/size', 'file', Buffer.alloc(5 * 1024 * 1024 + 1), 'a.csv', 'text/csv');
    assert.equal(big.status, 400);
    assert.equal(big.body.code, 'LIMIT_FILE_SIZE');
  });

  test('size file: wrong field name → LIMIT_UNEXPECTED_FILE; no file → passes with req.file undefined', async () => {
    const r = await send('/size', 'upload', Buffer.from('x'), 'a.csv', 'text/csv');
    assert.equal(r.body.code, 'LIMIT_UNEXPECTED_FILE');
    const none = await request(app).post('/size').field('x', 'y');
    assert.equal(none.status, 200);
    assert.equal(none.body.name, null);
  });

  for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    test(`attachment: ${ct} accepted`, async () => {
      const r = await send('/attach', 'attachment', Buffer.from('x'), 'a', ct);
      assert.equal(r.status, 200);
      assert.equal(r.body.mimetype, ct);
    });
  }

  for (const ct of ['image/gif', 'image/svg+xml', 'text/html', 'application/octet-stream']) {
    test(`attachment: ${ct} rejected`, async () => {
      const r = await send('/attach', 'attachment', Buffer.from('x'), 'a', ct);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'Only JPG, PNG, WebP, or PDF files are accepted');
    });
  }

  test('attachment: 20 MB + 1 rejected; field "file" not accepted', async () => {
    const big = await send('/attach', 'attachment', Buffer.alloc(20 * 1024 * 1024 + 1), 'a.pdf', 'application/pdf');
    assert.equal(big.body.code, 'LIMIT_FILE_SIZE');
    const wrong = await send('/attach', 'file', Buffer.from('x'), 'a.pdf', 'application/pdf');
    assert.equal(wrong.body.code, 'LIMIT_UNEXPECTED_FILE');
  });

  test('filter trusts the client-declared mimetype (extension/content not checked)', async () => {
    const r = await send('/attach', 'attachment', Buffer.from('MZ\x90\x00'), 'evil.exe', 'image/png');
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'evil.exe');
  });
});
