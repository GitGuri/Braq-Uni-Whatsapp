/**
 * Black-box API tests: products, quotations (incl. PDF + WhatsApp delivery),
 * purchase orders and school catalog.
 *
 * Quotations / clients have no create endpoint (they are created by the bot),
 * so fixtures are inserted with SQL; everything under test goes over HTTP.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { startTestEnv, ADMIN, JWT_SECRET } from '../helpers/env.js';

let env;
let db;
let adminToken;
let adminId;
let consultant;   // { id, name, email, token }
let manager;

// ── local helpers ────────────────────────────────────────────────────────────
async function api(method, path, { token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${env.baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ } }
  return { status: r.status, headers: r.headers, json, buf, text: buf.toString('utf8') };
}

const rnd = () => crypto.randomBytes(4).toString('hex');
const phone = () => `2771${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const cents = (n) => Math.round(Number(n) * 100);

async function makeStaff(role) {
  const name = `${role} ${rnd()}`;
  const email = `${role}.${rnd()}@test.local`;
  const { rows } = await db.query(
    `INSERT INTO staff (name, email, password_hash, role) VALUES ($1,$2,'x',$3) RETURNING id`,
    [name, email, role],
  );
  const id = rows[0].id;
  const token = jwt.sign({ id, email, role, name }, JWT_SECRET, { expiresIn: '1h' });
  return { id, name, email, token };
}

async function makeClient({ type = 'corporate', name = `Client ${rnd()}`, wa = phone() } = {}) {
  const { rows } = await db.query(
    `INSERT INTO clients (whatsapp_number, name, client_type, organisation, physical_address)
     VALUES ($1,$2,$3,'Acme Org','1 Test Street') RETURNING *`,
    [wa, name, type],
  );
  return rows[0];
}

function item(name, quantity, price, extra = {}) {
  return {
    productId: null, name, category: 'corporate_wear', colour: 'Navy',
    sizes: [{ size: 'M', qty: quantity }], quantity,
    unitPrice: price, brandingSurcharge: 0, effectiveUnitPrice: price,
    branding: { type: 'none', position: null, detail: null },
    lineTotal: Math.round(quantity * price * 100) / 100,
    ...extra,
  };
}

async function makeQuote({ clientId, status = 'draft', lineItems = [item('Golf Shirt', 2, 100)], ageDays = 0 } = {}) {
  const subtotal = lineItems.reduce((s, i) => s + i.lineTotal, 0);
  const { rows } = await db.query(
    `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat, total,
                             created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() - ($8 || ' days')::interval, NOW() - ($8 || ' days')::interval)
     RETURNING *`,
    [`TST-Q-${rnd()}`, clientId, status, JSON.stringify(lineItems), subtotal,
      Math.round(subtotal * 15) / 100, Math.round(subtotal * 115) / 100, String(ageDays)],
  );
  return rows[0];
}

/** Hit a list of [method, path, body] and return every one that answered 5xx. */
async function fiveHundreds(calls, token) {
  const bad = [];
  for (const [method, path, body] of calls) {
    const r = await api(method, path, { token, body });
    if (r.status >= 500) bad.push(`${method} ${path} -> ${r.status}`);
  }
  return bad;
}

before(async () => {
  env = await startTestEnv();
  db = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await api('POST', '/api/staff/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(r.status, 200, r.text);
  adminToken = r.json.token;
  adminId = r.json.staff.id;
  consultant = await makeStaff('consultant');
  manager = await makeStaff('manager');
}, { timeout: 240000 });

after(async () => {
  await db?.end().catch(() => {});
  await env?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('products', () => {
  const created = {};

  test('unauthenticated requests are rejected with 401', async () => {
    assert.equal((await api('GET', '/api/products')).status, 401);
    assert.equal((await api('POST', '/api/products', { body: { name: 'x' } })).status, 401);
  });

  test('admin can create a product; response echoes normalised fields', async () => {
    const r = await api('POST', '/api/products', {
      token: adminToken,
      body: { category: 'knitwear', name: `Jersey ${rnd()}`, sizes: ['S', 'M'], price: 249.99, description: 'V-neck' },
    });
    assert.equal(r.status, 201, r.text);
    const p = r.json.product;
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    assert.equal(p.category, 'knitwear');
    assert.equal(Number(p.price), 249.99);
    assert.equal(p.currency, 'ZAR');
    assert.equal(p.is_active, true);
    assert.deepEqual(p.sizes, ['S', 'M']);
    created.knit = p;
  });

  test('manager can create a product (school wear with school name)', async () => {
    const school = `School ${rnd()}`;
    const r = await api('POST', '/api/products', {
      token: manager.token,
      body: { category: 'school_wear', name: 'Blazer', schoolName: school, price: 500, isActive: false },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.product.school_name, school);
    assert.equal(r.json.product.is_active, false);
    created.school = r.json.product;
  });

  test('consultant cannot create or update products (403)', async () => {
    const c = await api('POST', '/api/products', {
      token: consultant.token, body: { category: 'knitwear', name: 'Nope', price: 1 },
    });
    assert.equal(c.status, 403);
    const u = await api('PATCH', `/api/products/${created.knit.id}`, { token: consultant.token, body: { price: 1 } });
    assert.equal(u.status, 403);
  });

  test('create validation: bad category / missing name / negative price / string price → 400', async () => {
    const bodies = [
      { category: 'swimwear', name: 'X', price: 10 },
      { category: 'knitwear', price: 10 },
      { category: 'knitwear', name: 'X', price: -1 },
      { category: 'knitwear', name: 'X', price: '10' },
      { category: 'knitwear', name: 'X', price: 10, currency: 'RANDS' },
    ];
    for (const body of bodies) {
      const r = await api('POST', '/api/products', { token: adminToken, body });
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    }
  });

  test('consultant can list and read products; filters by category and schoolName', async () => {
    const all = await api('GET', '/api/products', { token: consultant.token });
    assert.equal(all.status, 200);
    assert.ok(all.json.products.some(p => p.id === created.knit.id));

    const knit = await api('GET', '/api/products?category=knitwear', { token: consultant.token });
    assert.equal(knit.status, 200);
    assert.ok(knit.json.products.length >= 1);
    assert.ok(knit.json.products.every(p => p.category === 'knitwear'));

    const bySchool = await api('GET', `/api/products?schoolName=${encodeURIComponent(created.school.school_name)}`, { token: consultant.token });
    assert.deepEqual(bySchool.json.products.map(p => p.id), [created.school.id]);

    const one = await api('GET', `/api/products/${created.knit.id}`, { token: consultant.token });
    assert.equal(one.status, 200);
    assert.equal(one.json.product.name, created.knit.name);
  });

  test('activeOnly=true hides inactive products', async () => {
    const r = await api('GET', '/api/products?activeOnly=true', { token: adminToken });
    assert.equal(r.status, 200);
    assert.ok(!r.json.products.some(p => p.id === created.school.id));
    assert.ok(r.json.products.every(p => p.is_active === true));
  });

  test('activeOnly=false includes inactive products (query string "false" is not truthy)', async () => {
    const r = await api('GET', '/api/products?activeOnly=false', { token: adminToken });
    assert.equal(r.status, 200);
    assert.ok(r.json.products.some(p => p.id === created.school.id),
      'inactive product should be listed when activeOnly=false');
  });

  test('listing with an invalid category filter returns 4xx/empty, not 500', async () => {
    const r = await api('GET', '/api/products?category=swimwear', { token: adminToken });
    assert.ok(r.status === 400 || (r.status === 200 && r.json.products.length === 0),
      `expected 400 or empty 200, got ${r.status} ${r.text}`);
  });

  test('admin can update price / sizes / active flag', async () => {
    const r = await api('PATCH', `/api/products/${created.knit.id}`, {
      token: adminToken, body: { price: 199.5, sizes: ['L'], isActive: false, description: null },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(Number(r.json.product.price), 199.5);
    assert.deepEqual(r.json.product.sizes, ['L']);
    assert.equal(r.json.product.is_active, false);
    assert.equal(r.json.product.description, null);
  });

  test('update validation: invalid category → 400, empty body → 400, unknown id → 404', async () => {
    assert.equal((await api('PATCH', `/api/products/${created.knit.id}`, { token: adminToken, body: { category: 'swimwear' } })).status, 400);
    assert.equal((await api('PATCH', `/api/products/${created.knit.id}`, { token: adminToken, body: {} })).status, 400);
    assert.equal((await api('PATCH', `/api/products/${crypto.randomUUID()}`, { token: adminToken, body: { price: 1 } })).status, 404);
    assert.equal((await api('GET', `/api/products/${crypto.randomUUID()}`, { token: adminToken })).status, 404);
  });

  test('non-UUID product ids return 400/404, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/products/not-a-uuid'],
      ['PATCH', '/api/products/123', { price: 1 }],
    ], adminToken);
    assert.deepEqual(bad, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('quotations', () => {
  let client;
  let quote;

  before(async () => {
    client = await makeClient();
    quote = await makeQuote({ clientId: client.id });
  });

  test('list and get require auth', async () => {
    assert.equal((await api('GET', '/api/quotations')).status, 401);
    assert.equal((await api('GET', `/api/quotations/${quote.id}`)).status, 401);
  });

  test('list returns quotations with client info and supports status filter', async () => {
    const r = await api('GET', '/api/quotations', { token: consultant.token });
    assert.equal(r.status, 200);
    const q = r.json.quotations.find(x => x.id === quote.id);
    assert.ok(q, 'fixture quotation listed');
    assert.equal(q.client_name, client.name);
    assert.equal(q.client_wa, client.whatsapp_number);

    const drafts = await api('GET', '/api/quotations?status=draft', { token: consultant.token });
    assert.ok(drafts.json.quotations.some(x => x.id === quote.id));
    assert.ok(drafts.json.quotations.every(x => x.status === 'draft'));
    const sent = await api('GET', '/api/quotations?status=sent', { token: consultant.token });
    assert.ok(!sent.json.quotations.some(x => x.id === quote.id));
  });

  test('invalid status filter returns 400/empty, not 500', async () => {
    const r = await api('GET', '/api/quotations?status=bogus', { token: consultant.token });
    assert.ok(r.status === 400 || (r.status === 200 && r.json.quotations.length === 0),
      `got ${r.status} ${r.text}`);
  });

  test('get by id returns the quotation joined with client; unknown id → 404', async () => {
    const r = await api('GET', `/api/quotations/${quote.id}`, { token: consultant.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.quotation.reference, quote.reference);
    assert.equal(r.json.quotation.client_address, '1 Test Street');
    assert.equal(r.json.quotation.order_id, null);
    assert.equal((await api('GET', `/api/quotations/${crypto.randomUUID()}`, { token: adminToken })).status, 404);
  });

  test('AUTH-4: the quotation PDF is never public — 401 without a staff token (drafts included)', async () => {
    const r = await api('GET', `/api/quotations/${quote.id}/pdf`, { raw: true });
    assert.equal(r.status, 401);
  });

  test('claim: first consultant wins, second gets 409 naming the claimer; unknown → 404', async () => {
    const a = await api('POST', `/api/quotations/${quote.id}/claim`, { token: consultant.token });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.quotation.assigned_staff_id, consultant.id);
    const b = await api('POST', `/api/quotations/${quote.id}/claim`, { token: adminToken });
    assert.equal(b.status, 409);
    assert.match(b.json.error, new RegExp(consultant.name));
    const c = await api('POST', `/api/quotations/${crypto.randomUUID()}/claim`, { token: adminToken });
    assert.equal(c.status, 404);
  });

  test('approve validation: empty lineItems / missing name / negative qty → 400', async () => {
    const bodies = [
      {},
      { lineItems: [] },
      { lineItems: [{ ...item('X', 1, 1), name: '' }] },
      { lineItems: [item('X', -1, 1)] },
    ];
    for (const body of bodies) {
      const r = await api('POST', `/api/quotations/${quote.id}/approve`, { token: consultant.token, body });
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
  });

  test('approve: recomputes totals (15% VAT), flips to sent, sends PDF via WhatsApp document', async () => {
    await env.waitForJobs(); env.clearFakeCalls();
    const lineItems = [
      item('Golf Shirt', 10, 150),                         // 1500.00
      item('Cap', 5, 80, { brandingSurcharge: 20, effectiveUnitPrice: 100, lineTotal: 500,
        branding: { type: 'embroidery', position: 'front', detail: 'Logo' } }), // 500.00
    ];
    const r = await api('POST', `/api/quotations/${quote.id}/approve`, { token: consultant.token, body: { lineItems } });
    assert.equal(r.status, 200, r.text);
    const q = r.json.quotation;
    assert.equal(q.status, 'sent');
    assert.equal(cents(q.subtotal), 200000);
    assert.equal(cents(q.vat), 30000);
    assert.equal(cents(q.total), 230000);
    assert.equal(q.approved_by, consultant.id);
    assert.ok(q.approved_at);
    assert.ok(q.line_items.every(i => i.priceConfirmed === true));
    assert.equal(r.json.whatsappSent, true);

    await env.waitForJobs();   // the PDF is rendered, uploaded and sent by the job worker
    assert.equal(env.fakeCalls('whatsapp-media').length, 1, 'PDF uploaded once');
    const docs = env.fakeCalls('whatsapp').filter(c => c.body?.type === 'document');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].body.to, client.whatsapp_number);
    assert.equal(docs[0].body.document.id, 'FAKE_MEDIA_ID');
    assert.equal(docs[0].body.document.filename, `${quote.reference}.pdf`);
    assert.match(docs[0].body.document.caption, /R 2300\.00/);
  });

  test('approving an already-sent quotation → 400; unknown id → 404', async () => {
    const r = await api('POST', `/api/quotations/${quote.id}/approve`, { token: consultant.token, body: { lineItems: [item('X', 1, 1)] } });
    assert.equal(r.status, 400);
    const u = await api('POST', `/api/quotations/${crypto.randomUUID()}/approve`, { token: consultant.token, body: { lineItems: [item('X', 1, 1)] } });
    assert.equal(u.status, 404);
  });

  test('PDF endpoint (staff) returns a valid application/pdf document, not cacheable', async () => {
    assert.equal((await api('GET', `/api/quotations/${quote.id}/pdf`, { raw: true })).status, 401, 'no token → 401');
    const r = await api('GET', `/api/quotations/${quote.id}/pdf`, { raw: true, token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.match(r.headers.get('content-type'), /^application\/pdf/);
    assert.match(r.headers.get('content-disposition'), new RegExp(`${quote.reference}\\.pdf`));
    assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(r.buf.subarray(-32).toString('latin1').includes('%%EOF'), 'PDF trailer present');
    assert.ok(r.buf.length > 1500);
  });

  test('PDF of an unknown quotation → 404; quotation with no line items → 422', async () => {
    assert.equal((await api('GET', `/api/quotations/${crypto.randomUUID()}/pdf`, { raw: true, token: adminToken })).status, 404);
    const empty = await makeQuote({ clientId: client.id, status: 'sent', lineItems: [] });
    assert.equal((await api('GET', `/api/quotations/${empty.id}/pdf`, { raw: true, token: adminToken })).status, 422);
  });

  test('status update: missing/invalid → 400, unknown id → 404, accepted → 200', async () => {
    assert.equal((await api('PATCH', `/api/quotations/${quote.id}/status`, { token: adminToken, body: {} })).status, 400);
    assert.equal((await api('PATCH', `/api/quotations/${quote.id}/status`, { token: adminToken, body: { status: 'paid' } })).status, 400);
    assert.equal((await api('PATCH', `/api/quotations/${crypto.randomUUID()}/status`, { token: adminToken, body: { status: 'accepted' } })).status, 404);
    const r = await api('PATCH', `/api/quotations/${quote.id}/status`, { token: adminToken, body: { status: 'accepted' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.quotation.status, 'accepted');
  });

  test('accepted quotation converts to an order with a 60% deposit; second conversion → 409', async () => {
    await env.waitForJobs(); env.clearFakeCalls();
    const r = await api('POST', `/api/orders/convert-from-quotation/${quote.id}`, { token: adminToken, body: { poNumber: 'PO-1' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.order.quotation_id, quote.id);
    assert.equal(cents(r.json.order.deposit_amount), 138000);
    assert.equal(cents(r.json.order.balance_amount), 92000);
    await env.waitForJobs();
    assert.ok(env.fakeCalls('whatsapp').some(c => c.body?.to === client.whatsapp_number), 'client notified');

    const again = await api('POST', `/api/orders/convert-from-quotation/${quote.id}`, { token: adminToken, body: {} });
    assert.equal(again.status, 409);

    const g = await api('GET', `/api/quotations/${quote.id}`, { token: adminToken });
    assert.equal(g.json.quotation.order_id, r.json.order.id);
  });

  test('quotation that already has an order cannot be reset to draft', async () => {
    const r = await api('PATCH', `/api/quotations/${quote.id}/status`, { token: adminToken, body: { status: 'draft' } });
    assert.ok(r.status === 400 || r.status === 409, `expected 400/409, got ${r.status}`);
  });

  test('VAT is rounded to the cent and subtotal + VAT == total (7 x R14.30)', async () => {
    const q = await makeQuote({ clientId: client.id });
    const r = await api('POST', `/api/quotations/${q.id}/approve`, {
      token: adminToken, body: { lineItems: [item('Socks', 7, 14.30)] },  // 100.10
    });
    assert.equal(r.status, 200, r.text);
    const { subtotal, vat, total } = r.json.quotation;
    assert.equal(cents(subtotal), 10010);
    // 15% of 100.10 = 15.015 → 15.02 (half-up); total 115.12
    assert.equal(cents(vat), 1502, `vat ${vat}`);
    assert.equal(cents(total), 11512, `total ${total}`);
    assert.equal(cents(subtotal) + cents(vat), cents(total), 'subtotal + vat must equal total');
  });

  test('approve rejects (or recomputes) a lineTotal inconsistent with quantity x unit price', async () => {
    const q = await makeQuote({ clientId: client.id });
    const r = await api('POST', `/api/quotations/${q.id}/approve`, {
      token: adminToken, body: { lineItems: [item('Jacket', 10, 100, { lineTotal: 1 })] },
    });
    assert.ok(r.status === 400 || (r.status === 200 && cents(r.json.quotation.subtotal) === 100000),
      `expected 400 or subtotal 1000.00, got ${r.status} subtotal=${r.json?.quotation?.subtotal}`);
  });

  test('an approved quotation carries a future valid_until expiry date', async () => {
    const q = await makeQuote({ clientId: client.id });
    const r = await api('POST', `/api/quotations/${q.id}/approve`, { token: adminToken, body: { lineItems: [item('Tie', 1, 50)] } });
    assert.equal(r.status, 200);
    const vu = r.json.quotation.valid_until;
    assert.ok(vu, 'valid_until missing — purchaseOrders.service relies on it');
    assert.ok(new Date(vu) > new Date(), 'valid_until should be in the future');
  });

  test('a sent quotation older than its 30-day validity is reported as expired', async () => {
    const stale = await makeQuote({ clientId: client.id, status: 'sent', ageDays: 60 });
    const r = await api('GET', `/api/quotations/${stale.id}`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.quotation.status, 'expired');
  });

  test('expired quotations: filterable, cannot be accepted (409), excluded from ?status=sent', async () => {
    const stale = await makeQuote({ clientId: client.id, status: 'sent', ageDays: 45 });
    const exp = await api('GET', '/api/quotations?status=expired', { token: adminToken });
    assert.ok(exp.json.quotations.some(x => x.id === stale.id));
    assert.ok(exp.json.quotations.every(x => x.status === 'expired'));
    const sent = await api('GET', '/api/quotations?status=sent', { token: adminToken });
    assert.ok(!sent.json.quotations.some(x => x.id === stale.id));
    const acc = await api('PATCH', `/api/quotations/${stale.id}/status`, { token: adminToken, body: { status: 'accepted' } });
    assert.equal(acc.status, 409, acc.text);
    assert.match(acc.json.error, /expired/);
  });

  test('concurrent approvals of one draft: exactly one succeeds and one PDF is sent', async () => {
    const q = await makeQuote({ clientId: client.id });
    await env.waitForJobs(); env.clearFakeCalls();
    const body = { lineItems: [item('Vest', 3, 40)] };
    const results = await Promise.all([
      api('POST', `/api/quotations/${q.id}/approve`, { token: adminToken, body }),
      api('POST', `/api/quotations/${q.id}/approve`, { token: consultant.token, body }),
    ]);
    const ok = results.filter(r => r.status === 200);
    assert.equal(ok.length, 1, results.map(r => `${r.status} ${r.text}`).join(' | '));
    assert.ok(results.some(r => r.status === 400 || r.status === 409));
    await env.waitForJobs();
    assert.equal(env.fakeCalls('whatsapp').filter(c => c.body?.type === 'document').length, 1);
  });

  test('approve rejects zero quantity and non-numeric prices (400)', async () => {
    const q = await makeQuote({ clientId: client.id });
    for (const li of [item('Z', 0, 10), { ...item('P', 1, 10), unitPrice: 'abc' }]) {
      const r = await api('POST', `/api/quotations/${q.id}/approve`, { token: adminToken, body: { lineItems: [li] } });
      assert.equal(r.status, 400, JSON.stringify(li));
    }
  });

  test('non-UUID quotation ids return 400/404, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/quotations/abc'],
      ['GET', '/api/quotations/abc/pdf'],
      ['POST', '/api/quotations/abc/claim'],
      ['POST', '/api/quotations/abc/approve', { lineItems: [item('X', 1, 1)] }],
      ['PATCH', '/api/quotations/abc/status', { status: 'sent' }],
      ['POST', '/api/orders/convert-from-quotation/abc', {}],
    ], adminToken);
    assert.deepEqual(bad, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Purchase orders & school catalog: the frontend calls these endpoints, routers
// exist in src/routes, but index.js never mounts them (and migrate.js never
// creates purchase_orders / school_catalog tables).
describe('purchase orders', () => {
  let client;
  let quote;
  before(async () => {
    client = await makeClient();
    quote = await makeQuote({ clientId: client.id, status: 'sent', lineItems: [item('Overall', 4, 250)] }); // 1000 + 150 VAT
  });

  test('GET /api/purchase-orders is reachable and lists purchase orders', async () => {
    const r = await api('GET', '/api/purchase-orders', { token: adminToken });
    assert.equal(r.status, 200, `got ${r.status} ${r.text}`);
    assert.ok(Array.isArray(r.json.purchaseOrders));
  });

  test('POST /api/purchase-orders validates input (400 for missing poNumber / non-UUID quotationId)', async () => {
    const a = await api('POST', '/api/purchase-orders', { token: adminToken, body: { quotationId: quote.id } });
    assert.equal(a.status, 400, `got ${a.status}`);
    const b = await api('POST', '/api/purchase-orders', { token: adminToken, body: { quotationId: 'x', poNumber: 'P1' } });
    assert.equal(b.status, 400, `got ${b.status}`);
  });

  // NOTE: originally asserted stage 'purchase_order_received' / payment_status 'deposit_required',
  // neither of which exists in the 4-stage pipeline (deposit_pending → in_production → ready →
  // completed; payment_status unpaid | deposit_paid | paid_in_full). A validated PO converts the
  // quotation via convertFromQuotation: stage deposit_pending, 60% deposit owed, status unpaid.
  test('valid PO against an active quotation creates an order at deposit_pending with deposit requirement', async () => {
    await env.waitForJobs(); env.clearFakeCalls();
    const r = await api('POST', '/api/purchase-orders', {
      token: adminToken, body: { quotationId: quote.id, poNumber: `PO-${rnd()}`, status: 'valid' },
    });
    assert.equal(r.status, 201, `got ${r.status} ${r.text}`);
    const { rows } = await db.query('SELECT * FROM orders WHERE quotation_id = $1', [quote.id]);
    assert.equal(rows.length, 1, 'order created for the quotation');
    assert.equal(rows[0].stage, 'deposit_pending');
    assert.equal(rows[0].payment_status, 'unpaid');
    assert.equal(cents(rows[0].deposit_amount), 69000); // 60% of 1150.00
    assert.equal(cents(rows[0].balance_amount), 46000);
    assert.equal(r.json.purchaseOrder.status, 'valid');
    assert.equal(r.json.purchaseOrder.order_id, rows[0].id);
    await env.waitForJobs();
    assert.ok(env.fakeCalls('whatsapp').some(c => c.body?.to === client.whatsapp_number), 'client asked for deposit');
    const q = await api('GET', `/api/quotations/${quote.id}`, { token: adminToken });
    assert.equal(q.json.quotation.status, 'accepted', 'PO accepts the sent quotation');

    const list = await api('GET', '/api/purchase-orders', { token: adminToken });
    assert.ok(list.json.purchaseOrders.some(p => p.quotation_id === quote.id && p.order_reference === rows[0].reference));
  });

  test('a second PO for an already-converted quotation is recorded as invalid (422), no second order', async () => {
    const r = await api('POST', '/api/purchase-orders', {
      token: adminToken, body: { quotationId: quote.id, poNumber: `PO-${rnd()}` },
    });
    assert.equal(r.status, 422, r.text);
    assert.match(r.json.error, /already been converted/);
    assert.equal(r.json.purchaseOrder.status, 'invalid');
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id = $1', [quote.id]);
    assert.equal(rows[0].n, 1);
  });

  test('PO against an expired or draft quotation → 422 with reason; unknown quotation → 404', async () => {
    const stale = await makeQuote({ clientId: client.id, status: 'sent', ageDays: 45 });
    const a = await api('POST', '/api/purchase-orders', { token: adminToken, body: { quotationId: stale.id, poNumber: 'PO-OLD' } });
    assert.equal(a.status, 422, a.text);
    assert.match(a.json.error, /expired/);
    const draft = await makeQuote({ clientId: client.id });
    const b = await api('POST', '/api/purchase-orders', { token: adminToken, body: { quotationId: draft.id, poNumber: 'PO-DRAFT' } });
    assert.equal(b.status, 422);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id IN ($1,$2)', [stale.id, draft.id]);
    assert.equal(rows[0].n, 0);
    const c = await api('POST', '/api/purchase-orders', { token: adminToken, body: { quotationId: crypto.randomUUID(), poNumber: 'PO-X' } });
    assert.equal(c.status, 404);
  });

  test('consultants cannot record purchase orders (403)', async () => {
    const r = await api('POST', '/api/purchase-orders', { token: consultant.token, body: { quotationId: quote.id, poNumber: 'PO-C' } });
    assert.equal(r.status, 403);
  });
});

describe('school catalog', () => {
  test('GET /api/school-catalog and /schools are reachable', async () => {
    const a = await api('GET', '/api/school-catalog', { token: consultant.token });
    assert.equal(a.status, 200, `got ${a.status} ${a.text}`);
    assert.ok(Array.isArray(a.json.entries));
    const b = await api('GET', '/api/school-catalog/schools', { token: consultant.token });
    assert.equal(b.status, 200, `got ${b.status}`);
    assert.ok(Array.isArray(b.json.schools));
  });

  test('school catalog CRUD works for admin and is forbidden for consultants', async () => {
    const school = `High ${rnd()}`;
    const body = { schoolName: school, uniformType: 'Blazer', sizes: ['28', '30'], price: 650, sortOrder: 1 };

    const denied = await api('POST', '/api/school-catalog', { token: consultant.token, body });
    assert.equal(denied.status, 403, `consultant create got ${denied.status}`);

    const c = await api('POST', '/api/school-catalog', { token: adminToken, body });
    assert.equal(c.status, 201, `create got ${c.status} ${c.text}`);
    const id = c.json.entry.id;

    const missing = await api('POST', '/api/school-catalog', { token: adminToken, body: { schoolName: school } });
    assert.equal(missing.status, 400);

    const l = await api('GET', `/api/school-catalog?school=${encodeURIComponent(school)}`, { token: adminToken });
    assert.deepEqual(l.json.entries.map(e => e.id), [id]);

    const u = await api('PATCH', `/api/school-catalog/${id}`, { token: adminToken, body: { price: 700 } });
    assert.equal(u.status, 200);
    assert.equal(Number(u.json.entry.price), 700);

    const d = await api('DELETE', `/api/school-catalog/${id}`, { token: adminToken });
    assert.equal(d.status, 200);
    const d2 = await api('DELETE', `/api/school-catalog/${id}`, { token: adminToken });
    assert.equal(d2.status, 404);
  });
});
