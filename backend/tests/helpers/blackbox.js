/**
 * Shared helpers for the lifecycle / order-creation / jobs black-box suites:
 * an HTTP client, staff tokens, fixtures through the API, and the WhatsApp
 * webhook (signed inbound messages + collecting the bot's replies).
 *
 *   const bb = await startBlackbox();   // env + db + admin/manager/consultant tokens
 *   bb.api(method, path, { token, body }) → { status, json, text }
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { startTestEnv, ADMIN, JWT_SECRET } from './env.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rnd = () => crypto.randomBytes(4).toString('hex');
export const newPhone = () => `2772${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
export const cents = (n) => Math.round(Number(n) * 100);

export function item(name, quantity, unitPrice, extra = {}) {
  return { name, quantity, unitPrice, sizes: [{ size: 'M', qty: quantity }], ...extra };
}

export async function startBlackbox({ env: extraEnv } = {}) {
  const env = await startTestEnv({ env: extraEnv });
  const db = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false }, max: 4 });

  async function api(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${env.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }

  async function makeStaff(role, name = `${role} ${rnd()}`) {
    const email = `${role}.${rnd()}@test.local`;
    const { rows } = await db.query(
      `INSERT INTO staff (name, email, password_hash, role) VALUES ($1,$2,'x',$3) RETURNING id`, [name, email, role]);
    const id = rows[0].id;
    return { id, name, email, role, token: jwt.sign({ id, email, role, name }, JWT_SECRET, { expiresIn: '1h' }) };
  }

  const login = await api('POST', '/api/staff/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(login.status, 200, login.text);
  const admin = { ...login.json.staff, token: login.json.token };
  const manager = await makeStaff('manager', 'Mandla Manager');
  const consultant = await makeStaff('consultant', 'Connie Consultant');

  async function makeClient({ name = `Client ${rnd()}`, wa = newPhone(), type = 'corporate', profileComplete = true } = {}) {
    const { rows } = await db.query(
      `INSERT INTO clients (whatsapp_number, name, client_type, organisation, profile_complete)
       VALUES ($1,$2,$3,'Acme Org',$4) RETURNING *`, [wa, name, type, profileComplete]);
    return rows[0];
  }

  /** Expect a status; returns json. */
  async function ok(res, status = 200) {
    const r = await res;
    assert.equal(r.status, status, `${r.status} ${r.text}`);
    return r.json;
  }

  /** Staff starts a quote, prices it and sends it (approve). Returns the sent quotation. */
  async function sentQuote(client, { token = admin.token, lineItems = [item('Golf shirt', 10, 100)] } = {}) {
    const { quotation } = await ok(api('POST', '/api/quotations', { token, body: { clientId: client.id, lineItems } }), 201);
    const r = await ok(api('POST', `/api/quotations/${quotation.id}/approve`, { token, body: { lineItems } }));
    return r.quotation;
  }

  async function acceptedQuote(client, opts = {}) {
    const q = await sentQuote(client, opts);
    const r = await ok(api('PATCH', `/api/quotations/${q.id}/status`, { token: opts.token ?? admin.token, body: { status: 'accepted' } }));
    return r.quotation;
  }

  /** An order (dashboard path, from line items). */
  async function order(client, { token = admin.token, lineItems = [item('Golf shirt', 10, 100)], ...rest } = {}) {
    const r = await ok(api('POST', '/api/orders', { token, body: { clientId: client.id, lineItems, ...rest } }), 201);
    return r.order;
  }

  const pay = (orderId, type, amount, token = admin.token) =>
    ok(api('POST', `/api/orders/${orderId}/payments`, { token, body: { type, amount } }), 201);
  const advance = (orderId, body = {}, token = admin.token) => api('POST', `/api/orders/${orderId}/advance`, { token, body });

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  const wamid = () => `wamid.TEST_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const signBody = (raw) => `sha256=${crypto.createHmac('sha256', 'fake').update(raw).digest('hex')}`;
  function textPayload(from, body, id = wamid()) {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '27110000000', phone_number_id: '000000' },
        contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
        messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
      } }] }],
    };
  }
  const outbound = (phone) => env.fakeCalls('whatsapp').filter((c) => c.body?.to === phone);
  const render = (c) => (c.body?.type === 'document'
    ? `[document:${c.body.document?.filename}] ${c.body.document?.caption ?? ''}`
    : c.body?.text?.body ?? JSON.stringify(c.body));
  const textsTo = (phone) => outbound(phone).map(render);

  /** POST an inbound text; resolves with the new outbound messages once they stop arriving. */
  async function sendInbound(phone, text, { timeout = 10000, settle = 700, expectReply = true } = {}) {
    const before = outbound(phone).length;
    const id = wamid();
    const raw = JSON.stringify(textPayload(phone, text, id));
    const r = await fetch(`${env.baseUrl}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw,
    });
    await r.text();
    assert.equal(r.status, 200);
    const deadline = Date.now() + timeout;
    if (expectReply) {
      while (outbound(phone).length <= before) {
        if (Date.now() > deadline) throw new Error(`No WhatsApp reply to ${phone} for "${text}". Log tail:\n${env.logs.slice(-6).join('')}`);
        await sleep(100);
      }
    } else {
      while (Date.now() < deadline) {
        const { rows } = await db.query('SELECT 1 FROM messages WHERE meta_message_id = $1', [id]);
        if (rows.length) break;
        await sleep(100);
      }
    }
    let n = outbound(phone).length;
    for (;;) {
      await sleep(settle);
      const m = outbound(phone).length;
      if (m === n) break;
      n = m;
    }
    return outbound(phone).slice(before).map(render);
  }

  const convoOf = async (phone) => (await db.query(
    `SELECT cv.* FROM conversations cv JOIN clients c ON c.id = cv.client_id
     WHERE c.whatsapp_number = $1 AND cv.is_open = true ORDER BY cv.created_at DESC LIMIT 1`, [phone])).rows[0];
  const clientOf = async (phone) => (await db.query('SELECT * FROM clients WHERE whatsapp_number = $1', [phone])).rows[0];

  /** A WhatsApp contact who has chatted once and completed the profile. */
  async function registeredPhone(name = `Reg ${rnd()}`) {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await db.query('UPDATE clients SET name = $2, profile_complete = true WHERE whatsapp_number = $1', [phone, name]);
    return phone;
  }

  return {
    env, db, api, ok, admin, manager, consultant, makeStaff, makeClient, sentQuote, acceptedQuote, order, pay, advance,
    sendInbound, textsTo, outbound, convoOf, clientOf, registeredPhone,
    async stop() { await db.end().catch(() => {}); await env.stop(); },
  };
}
