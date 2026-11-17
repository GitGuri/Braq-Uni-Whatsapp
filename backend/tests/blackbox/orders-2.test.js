/**
 * Black-box API tests — order listing/filtering/pagination, malformed ids,
 * size rosters, size run sheet, and clients (list / detail / CRM update).
 *
 * Tests named "BUG: ..." assert the CORRECT behaviour and currently fail
 * because of a genuine defect in the app (see the test comments).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { startTestEnv, ADMIN } from '../helpers/env.js';

let env;
let db;
let token;
let adminId;

before(async () => {
  env = await startTestEnv();
  db = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false }, max: 3 });
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  token = j.token;
  adminId = j.staff.id;
}, { timeout: 240000 });

after(async () => {
  await db?.end().catch(() => {});
  await env?.stop();
});

// ── local helpers ─────────────────────────────────────────────────────────────
let requestCount = 0;
async function api(method, path, body, { formData } = {}) {
  requestCount++;
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (formData) payload = formData;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${env.baseUrl}${path}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, buf, headers: res.headers };
}

const randPhone = () => `2771${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const uniq = () => Math.random().toString(36).slice(2, 10);
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

async function makeClient(o = {}) {
  const { rows } = await db.query(
    `INSERT INTO clients (whatsapp_number, name, client_type, organisation, physical_address, school_name)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [o.whatsapp_number ?? randPhone(), o.name ?? `Client ${uniq()}`, o.client_type ?? 'retail',
      o.organisation ?? null, o.physical_address ?? null, o.school_name ?? null],
  );
  return rows[0];
}

// Every order comes from a quotation; the dashboard path builds an accepted one from line items.
async function makeOrder(clientId, extra = {}) {
  const r = await api('POST', '/api/orders', { clientId, lineItems: [{ name: 'Golf shirt', quantity: 2, unitPrice: 100 }], ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json.order;
}

/** Run a list of [label, method, path, body] and return "label=>status" strings. */
async function statuses(cases) {
  const out = [];
  for (const [label, method, path, body] of cases) {
    const r = await api(method, path, body);
    out.push({ label, status: r.status, text: r.text.slice(0, 120) });
  }
  return out;
}
const fmt = (rs) => rs.map((r) => `${r.label}=>${r.status}`).join(', ');

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/orders filtering & pagination', () => {
  let client, staffClient, orders, consultantId;

  before(async () => {
    const tag = uniq();
    client = await makeClient({ name: `Filter ${tag}`, client_type: 'school', school_name: 'Hilltop High' });
    staffClient = await makeClient({ name: `Filter2 ${tag}` });
    const s = await api('POST', '/api/staff', { name: 'Filter Consultant', email: `fc${tag}@test.local`, password: 'Password123!' });
    assert.equal(s.status, 201, s.text);
    consultantId = s.json.staff.id;
    orders = [];
    for (let i = 0; i < 3; i++) orders.push(await makeOrder(client.id, { clientType: 'school' }));
    orders.push(await makeOrder(staffClient.id, { clientType: 'hospitality', assignedStaffId: consultantId }));
    // orders[0] -> in_production, orders[1] -> on hold, orders[2] -> completed (direct SQL setup)
    await db.query(`UPDATE orders SET stage='in_production' WHERE id=$1`, [orders[0].id]);
    await db.query(`UPDATE orders SET is_on_hold=true, hold_reason='x' WHERE id=$1`, [orders[1].id]);
    await db.query(`UPDATE orders SET stage='completed' WHERE id=$1`, [orders[2].id]);
  });

  test('filters by stage, clientType, staffId, onHold, active', async () => {
    const ids = (r) => r.json.orders.map((o) => o.id);
    let r = await api('GET', '/api/orders?stage=in_production&limit=100');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.orders.every((o) => o.stage === 'in_production'));
    assert.ok(ids(r).includes(orders[0].id));

    r = await api('GET', '/api/orders?clientType=hospitality&limit=100');
    assert.ok(r.json.orders.length >= 1 && r.json.orders.every((o) => o.client_type === 'hospitality'));
    assert.ok(ids(r).includes(orders[3].id));

    r = await api('GET', `/api/orders?staffId=${consultantId}`);
    assert.deepEqual(ids(r), [orders[3].id]);
    assert.equal(r.json.orders[0].staff_name, 'Filter Consultant');
    assert.equal(r.json.orders[0].whatsapp_number, staffClient.whatsapp_number);

    r = await api('GET', '/api/orders?onHold=true&limit=100');
    assert.ok(r.json.orders.every((o) => o.is_on_hold === true));
    assert.ok(ids(r).includes(orders[1].id));

    r = await api('GET', '/api/orders?active=true&limit=100');
    assert.ok(r.json.orders.every((o) => o.stage !== 'completed'));
    assert.ok(!ids(r).includes(orders[2].id));
  });

  test('pagination returns disjoint pages in created_at DESC order', async () => {
    const p1 = await api('GET', '/api/orders?limit=2&page=1');
    const p2 = await api('GET', '/api/orders?limit=2&page=2');
    assert.equal(p1.status, 200);
    assert.equal(p1.json.orders.length, 2);
    assert.equal(p2.json.orders.length, 2);
    const a = p1.json.orders.map((o) => o.id);
    const b = p2.json.orders.map((o) => o.id);
    assert.equal(a.filter((x) => b.includes(x)).length, 0, 'pages overlap');
    const times = [...p1.json.orders, ...p2.json.orders].map((o) => Date.parse(o.created_at));
    assert.deepEqual([...times].sort((x, y) => y - x), times);
    const far = await api('GET', '/api/orders?page=100000&limit=20');
    assert.equal(far.status, 200, far.text);
    assert.deepEqual(far.json.orders, []);
  });

  test('injection-looking / garbage text filters are treated as data, not SQL', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM orders');
    const rs = await statuses([
      ['stage-sqli', 'GET', `/api/orders?stage=${encodeURIComponent("x' OR '1'='1")}`],
      ['stage-drop', 'GET', `/api/orders?stage=${encodeURIComponent("'; DROP TABLE orders; --")}`],
      ['search-sqli', 'GET', `/api/orders?search=${encodeURIComponent("' OR 1=1 --")}`],
      ['onHold-garbage', 'GET', '/api/orders?onHold=maybe&active=perhaps'],
      ['stage-array', 'GET', '/api/orders?stage[]=a&stage[]=b'],
    ]);
    assert.ok(rs.every((r) => r.status === 200), fmt(rs));
    const r = await api('GET', `/api/orders?stage=${encodeURIComponent("x' OR '1'='1")}`);
    assert.deepEqual(r.json.orders, []);
    const after = await db.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  // listOrders (orders.service.js:36-63) passes parseInt(limit/page) straight
  // into LIMIT/OFFSET and casts clientType/staffId without validation, so
  // Postgres errors ("LIMIT must not be negative", invalid NaN bigint, invalid
  // enum / uuid input, bigint out of range) become 500s.
  test('garbage pagination / filter params on GET /api/orders return 200 or 400, never 500', async () => {
    const rs = await statuses([
      ['limit=-1', 'GET', '/api/orders?limit=-1'],
      ['limit=abc', 'GET', '/api/orders?limit=abc'],
      ['page=0', 'GET', '/api/orders?page=0'],
      ['page=-5', 'GET', '/api/orders?page=-5'],
      ['page=huge', 'GET', '/api/orders?page=99999999999999999999'],
      ['limit=huge', 'GET', '/api/orders?limit=99999999999999999999'],
      ['clientType=alien', 'GET', '/api/orders?clientType=alien'],
      ['staffId=not-uuid', 'GET', '/api/orders?staffId=not-a-uuid'],
    ]);
    assert.ok(rs.every((r) => r.status < 500), fmt(rs));
  });

  test('KPIs endpoint returns numeric counters', async () => {
    const r = await api('GET', '/api/orders/kpis');
    assert.equal(r.status, 200, r.text);
    for (const k of ['active_orders', 'on_hold_orders', 'open_tickets']) {
      assert.ok(Number.isInteger(Number(r.json.kpis[k])), `${k}=${r.json.kpis[k]}`);
    }
    assert.ok(Number(r.json.kpis.on_hold_orders) >= 1);
    assert.ok(Array.isArray(r.json.attention));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('malformed ids', () => {
  test('unknown (well-formed) ids return 404', async () => {
    const rs = await statuses([
      ['GET order', 'GET', `/api/orders/${NIL_UUID}`],
      ['advance', 'POST', `/api/orders/${NIL_UUID}/advance`, {}],
      ['hold', 'PATCH', `/api/orders/${NIL_UUID}/hold`, { isOnHold: true }],
      ['size-run-sheet', 'GET', `/api/orders/${NIL_UUID}/size-run-sheet`],
      ['materials', 'PATCH', `/api/orders/${NIL_UUID}/materials`, { fabric: 'x' }],
      ['GET client', 'GET', `/api/clients/${NIL_UUID}`],
      ['PATCH client', 'PATCH', `/api/clients/${NIL_UUID}`, { name: 'x' }],
    ]);
    assert.ok(rs.every((r) => r.status === 404), fmt(rs));
  });

  // Every handler forwards req.params.id unvalidated into "WHERE id = $1" on a
  // UUID column; Postgres raises 22P02 (invalid input syntax for type uuid),
  // which handleError maps to 500 (orders.controller.js:42-46,
  // clients.controller.js:19-23).
  test('non-UUID ids return 400/404, never 500', async () => {
    const rs = await statuses([
      ['GET order', 'GET', '/api/orders/abc'],
      ['GET order sqli', 'GET', `/api/orders/${encodeURIComponent("1' OR '1'='1")}`],
      ['advance', 'POST', '/api/orders/abc/advance', {}],
      ['hold', 'PATCH', '/api/orders/abc/hold', { isOnHold: true }],
      ['pay', 'POST', '/api/orders/abc/payments', { type: 'deposit', amount: 10 }],
      ['list payments', 'GET', '/api/orders/abc/payments'],
      ['GET client', 'GET', '/api/clients/abc'],
      ['PATCH client', 'PATCH', '/api/clients/abc', { name: 'x' }],
    ]);
    assert.ok(rs.every((r) => r.status === 400 || r.status === 404), fmt(rs));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('size roster', () => {
  async function xlsxBuffer(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Roster');
    ws.addRow(['Name', 'Size', 'Notes']);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function form(buf, filename, type) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), filename);
    return fd;
  }

  let order;
  before(async () => {
    const client = await makeClient({ client_type: 'school', school_name: 'Roster High' });
    order = await makeOrder(client.id, { clientType: 'school' });
  });

  // README documents POST /api/orders/:id/sizes/upload and GET /api/orders/:id/sizes.
  // Neither route exists in orders.routes.js (uploadSizeFile in middleware/upload.js
  // and services/sizes.service.js are never wired), and the order_size_entries
  // table is never created by any script (migrate.js only drops it).
  test('uploading an .xlsx roster stores entries, listable via GET /sizes', async () => {
    const buf = await xlsxBuffer([['Thandi M', 'M', 'long sleeve'], ['Pieter V', 'XL', null], ['Ayesha K', '32', 'girls cut']]);
    const up = await api('POST', `/api/orders/${order.id}/sizes/upload`, undefined, { formData: form(buf, 'roster.xlsx', XLSX) });
    assert.ok(up.status === 200 || up.status === 201, `upload: ${up.status} ${up.text}`);
    const list = await api('GET', `/api/orders/${order.id}/sizes`);
    assert.equal(list.status, 200, list.text);
    const entries = list.json.sizes ?? list.json.entries ?? list.json;
    assert.deepEqual(entries.map((e) => [e.person_name, e.size]), [['Thandi M', 'M'], ['Pieter V', 'XL'], ['Ayesha K', '32']]);
  });

  test('uploading a .csv roster stores entries', async () => {
    const csv = 'Name,Size,Notes\nSipho N,L,\n"Smith, Jo",S,"needs ""slim"" fit"\n';
    const up = await api('POST', `/api/orders/${order.id}/sizes/upload`, undefined, { formData: form(Buffer.from(csv), 'roster.csv', 'text/csv') });
    assert.ok(up.status === 200 || up.status === 201, `upload: ${up.status} ${up.text}`);
  });

  test('bad roster files are rejected with 400/413/415 (wrong type, empty, malformed, no Size column, oversized)', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x41);
    const noSize = await (async () => {
      const wb = new ExcelJS.Workbook(); wb.addWorksheet('x').addRow(['Name', 'Shoe']);
      return Buffer.from(await wb.xlsx.writeBuffer());
    })();
    const cases = [
      ['wrong type .txt', form(Buffer.from('Name,Size\nA,M'), 'roster.txt', 'text/plain')],
      ['empty csv', form(Buffer.alloc(0), 'roster.csv', 'text/csv')],
      ['header-only csv', form(Buffer.from('Name,Size\n'), 'roster.csv', 'text/csv')],
      ['malformed xlsx', form(Buffer.from('this is not a zip file'), 'roster.xlsx', XLSX)],
      ['xlsx without Size column', form(noSize, 'roster.xlsx', XLSX)],
      ['oversized (>5MB)', form(big, 'roster.csv', 'text/csv')],
      ['no file field', new FormData()],
    ];
    const out = [];
    for (const [label, fd] of cases) {
      const r = await api('POST', `/api/orders/${order.id}/sizes/upload`, undefined, { formData: fd });
      out.push({ label, status: r.status });
    }
    assert.ok(out.every((r) => [400, 413, 415, 422].includes(r.status)), fmt(out));
  });

  test('size run sheet returns a PDF built from the quotation line items', async () => {
    const client = await makeClient();
    const items = [{ name: 'Blazer', colour: 'Navy', quantity: 5, sizes: [{ size: '30', qty: 2 }, { size: '32', qty: 3 }] }];
    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (reference, client_id, status, line_items, total) VALUES ($1,$2,'accepted',$3,100) RETURNING id`,
      [`Q-${uniq()}`, client.id, JSON.stringify(items)]);
    const o = await makeOrder(client.id, { quotationId: q.id });
    const r = await api('GET', `/api/orders/${o.id}/size-run-sheet`);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), new RegExp(`size-run-${o.reference}\\.pdf`));
    assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('clients', () => {
  let tag, c1, c2, c3;
  before(async () => {
    tag = uniq();
    c1 = await makeClient({ name: `Zola ${tag}`, client_type: 'school', school_name: 'Zola High' });
    c2 = await makeClient({ name: `Zola2 ${tag}`, client_type: 'corporate', organisation: `Org${tag}` });
    c3 = await makeClient({ name: `Other ${tag}` });
    await makeOrder(c1.id);
    await makeOrder(c1.id);
  });

  test('list supports search (name / phone / organisation), clientType and pagination; includes order counts', async () => {
    let r = await api('GET', `/api/clients?search=Zola&limit=100`);
    assert.equal(r.status, 200, r.text);
    const names = r.json.clients.map((c) => c.name);
    assert.ok(names.includes(c1.name) && names.includes(c2.name) && !names.includes(c3.name), names.join('|'));
    assert.equal(Number(r.json.clients.find((c) => c.id === c1.id).total_orders), 2);

    r = await api('GET', `/api/clients?search=${c3.whatsapp_number}`);
    assert.deepEqual(r.json.clients.map((c) => c.id), [c3.id]);
    r = await api('GET', `/api/clients?search=Org${tag}`);
    assert.deepEqual(r.json.clients.map((c) => c.id), [c2.id]);

    r = await api('GET', '/api/clients?clientType=school&limit=200');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.clients.length >= 1 && r.json.clients.every((c) => c.client_type === 'school'),
      r.json.clients.map((c) => c.client_type).join('|'));
    assert.ok(r.json.clients.some((c) => c.id === c1.id) && !r.json.clients.some((c) => c.id === c2.id));
    assert.equal(typeof r.json.total, 'number');
    assert.ok(r.json.total >= r.json.clients.length);

    r = await api('GET', `/api/clients?search=${tag}&clientType=school`);
    assert.deepEqual(r.json.clients.map((c) => c.id), [c1.id]);

    const p1 = await api('GET', `/api/clients?search=${tag}&limit=2&page=1`);
    const p2 = await api('GET', `/api/clients?search=${tag}&limit=2&page=2`);
    assert.equal(p1.json.clients.length, 2);
    assert.equal(p2.json.clients.length, 1);
    const all = [...p1.json.clients, ...p2.json.clients].map((c) => c.id).sort();
    assert.deepEqual(all, [c1.id, c2.id, c3.id].sort());

    r = await api('GET', `/api/clients?search=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.clients, []);
  });

  // listClients (clients.service.js:72-101) has the same unvalidated
  // parseInt/LIMIT/OFFSET and enum cast as listOrders.
  test('garbage pagination / filter params on GET /api/clients return 200 or 400, never 500', async () => {
    const rs = await statuses([
      ['limit=-1', 'GET', '/api/clients?limit=-1'],
      ['limit=abc', 'GET', '/api/clients?limit=abc'],
      ['page=0', 'GET', '/api/clients?page=0'],
      ['clientType=alien', 'GET', '/api/clients?clientType=alien'],
    ]);
    assert.ok(rs.every((r) => r.status < 500), fmt(rs));
  });

  test('get client returns the profile with order and quotation history', async () => {
    const r = await api('GET', `/api/clients/${c1.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.client.id, c1.id);
    assert.equal(r.json.orders.length, 2);
    assert.ok(r.json.orders.every((o) => o.client_id === c1.id));
    // Each order was created through its own (accepted) quotation.
    assert.equal(r.json.quotations.length, 2);
    assert.deepEqual(r.json.orders.map((o) => o.quotation_id).sort(), r.json.quotations.map((q) => q.id).sort());
  });

  test('PATCH updates CRM fields (camelCase) and validates input', async () => {
    const body = {
      name: 'Renamed Client', email: 'buyer@example.com', clientType: 'church', organisation: 'Grace Chapel',
      contactPerson: 'Pastor P', physicalAddress: '9 Church St', vatNumber: '4123456789',
      preferredStoreLocation: 'Brakpan', schoolName: 'n/a',
    };
    const r = await api('PATCH', `/api/clients/${c3.id}`, body);
    assert.equal(r.status, 200, r.text);
    const { rows: [row] } = await db.query('SELECT * FROM clients WHERE id=$1', [c3.id]);
    assert.equal(row.name, 'Renamed Client');
    assert.equal(row.email, 'buyer@example.com');
    assert.equal(row.client_type, 'church');
    assert.equal(row.organisation, 'Grace Chapel');
    assert.equal(row.contact_person, 'Pastor P');
    assert.equal(row.physical_address, '9 Church St');
    assert.equal(row.vat_number, '4123456789');
    assert.equal(row.preferred_store_location, 'Brakpan');
    assert.equal(row.school_name, 'n/a');
    assert.equal(row.whatsapp_number, c3.whatsapp_number, 'phone is not editable');

    const rs = await statuses([
      ['bad email', 'PATCH', `/api/clients/${c3.id}`, { email: 'not-an-email' }],
      ['bad clientType', 'PATCH', `/api/clients/${c3.id}`, { clientType: 'pirate' }],
      ['numeric name', 'PATCH', `/api/clients/${c3.id}`, { name: 42 }],
      ['empty body', 'PATCH', `/api/clients/${c3.id}`, {}],
      ['read-only field only', 'PATCH', `/api/clients/${c3.id}`, { whatsappNumber: '27000000000' }],
    ]);
    assert.ok(rs.every((x) => x.status === 400), fmt(rs));
  });

  // VARCHAR(200) name/organisation; UpdateClientSchema (clients.controller.js:6-17)
  // has no max lengths → Postgres 22001 → 500.
  test('over-long CRM values return 400, not 500', async () => {
    const r = await api('PATCH', `/api/clients/${c2.id}`, { name: 'x'.repeat(500) });
    assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
  });

  // DASHBOARD_FIELD_MAP (clients.service.js:10) maps deliveryPreference, but
  // UpdateClientSchema omits it, so zod strips it and the update is a no-op (400).
  test('deliveryPreference can be updated via PATCH', async () => {
    const r = await api('PATCH', `/api/clients/${c2.id}`, { deliveryPreference: 'delivery' });
    assert.equal(r.status, 200, `got ${r.status} ${r.text}`);
    const { rows: [row] } = await db.query('SELECT delivery_preference FROM clients WHERE id=$1', [c2.id]);
    assert.equal(row.delivery_preference, 'delivery');
  });

  // The dashboard edit modal (frontend/src/pages/Clients/ClientDetail.jsx:155-161,
  // 188) PATCHes snake_case keys and nulls for empty fields; the API schema only
  // knows camelCase and rejects null, so school_name / physical_address /
  // client_type edits are silently dropped (or the whole save fails with 400).
  test('PATCH accepts the payload the dashboard edit form actually sends', async () => {
    const payload = {
      name: 'Edited From Dashboard', organisation: null,
      school_name: 'Edited High', physical_address: '5 Edit Rd', client_type: 'school',
    };
    const r = await api('PATCH', `/api/clients/${c2.id}`, payload);
    assert.equal(r.status, 200, `got ${r.status} ${r.text}`);
    const { rows: [row] } = await db.query('SELECT * FROM clients WHERE id=$1', [c2.id]);
    assert.equal(row.school_name, 'Edited High');
    assert.equal(row.physical_address, '5 Edit Rd');
    assert.equal(row.client_type, 'school');
  });
});

test('request budget stays under the API rate limit', () => {
  assert.ok(requestCount < 190, `used ${requestCount} requests`);
});
