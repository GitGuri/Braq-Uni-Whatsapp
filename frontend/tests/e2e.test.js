/**
 * Black-box browser E2E for the Braq Connect dashboard.
 *
 *  backend : real API + throwaway embedded Postgres (backend/tests/helpers/env.js),
 *            WhatsApp / Gemini / Resend faked, demo data from seed-testing.js
 *  frontend: Vite dev server started programmatically, /api proxied to the test API
 *  browser : system Microsoft Edge (or Chrome) via playwright-core, headless
 *
 * Every test fails on uncaught page errors, non-warning console errors and
 * unexpected 4xx/5xx /api responses. React/antd dev "Warning:" messages are
 * collected and reported by the final test instead.
 * Tests prefixed "BUG:" assert correct behaviour and currently fail.
 *
 * Run: cd frontend && node --test tests/   (≈3–5 min; first boot of Postgres is slow)
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { startTestEnv, ADMIN, JWT_SECRET } from '../../backend/tests/helpers/env.js';

const here  = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(here, '..');
const SHOTS = process.env.E2E_SHOTS ||
  'C:/Users/LEEROY/AppData/Local/Temp/claude/c--Users-LEEROY-Desktop-QX-Projects-Braq-Uni/7855ab4e-2386-482e-baa8-2675d30c8cb6/scratchpad/e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });

let env = null;
let seedError = null;
let vite = null;
let browser = null;
let APP = '';            // Vite origin, e.g. http://127.0.0.1:5xxxx
let session = null;      // { token, staff } for the seeded admin
const devWarnings = new Map(); // text → first page it appeared on

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);

// ── lifecycle ──────────────────────────────────────────────────────────────────
before(async () => {
  try {
    env = await startTestEnv({ seedTestingData: true });
  } catch (err) {
    // Report the seed failure (dedicated test below) and continue on an unseeded DB.
    seedError = String(err.stderr || err.stdout || err.message).slice(0, 2000);
    env = await startTestEnv({ seedTestingData: false });
  }

  const port = await freePort();
  vite = await createServer({
    configFile: path.join(FRONT, 'vite.config.js'),
    root: FRONT,
    logLevel: 'error',
    clearScreen: false,
    cacheDir: path.join(os.tmpdir(), 'braq-e2e-vite-cache'),
    optimizeDeps: { entries: ['index.html', 'src/**/*.{js,jsx}'] },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      proxy: { '/api': { target: env.baseUrl, changeOrigin: true } },
    },
  });
  await vite.listen();
  APP = `http://127.0.0.1:${port}`;

  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }

  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(r.status, 200, 'admin login via API failed');
  session = await r.json();

  // Warm up Vite (first transform of antd etc. is slow) so per-test timeouts are meaningful.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`, { waitUntil: 'load', timeout: 180000 });
  await p.getByText('Welcome back').waitFor({ timeout: 120000 });
  await ctx.close();
}, { timeout: 420000 });

after(async () => {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await env?.stop().catch(() => {});
}, { timeout: 120000 });

// ── harness ────────────────────────────────────────────────────────────────────
function watch(page) {
  const errs = { page: [], console: [], api: [] };
  page.on('pageerror', (e) => errs.page.push(e.message.split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (/Failed to load resource/.test(text)) return;          // covered by the response listener
    if (/^Warning: |\[antd: |React Router Future Flag/.test(text)) {
      const key = text.split('\n')[0].replace(/%s/g, '').slice(0, 220);
      if (!devWarnings.has(key)) devWarnings.set(key, new URL(page.url()).pathname);
      return;
    }
    if (m.type() === 'error') errs.console.push(text.split('\n')[0].slice(0, 300));
  });
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/') && res.status() >= 400) {
      errs.api.push(`${res.status()} ${res.request().method()} ${u.pathname}`);
    }
  });
  return errs;
}

async function loginViaStorage(page, { token = session.token, staff = session.staff } = {}) {
  await page.goto(`${APP}/login`);
  await page.evaluate(([t, s]) => {
    localStorage.setItem('braq_token', t);
    localStorage.setItem('braq_staff', JSON.stringify(s));
  }, [token, staff]);
}

/**
 * e2e(name, fn, opts) — fresh browser context per test, screenshots on failure,
 * asserts no page errors / console errors / unexpected API errors at the end.
 *   opts.login      (default true) seed localStorage with a valid session
 *   opts.allowApi   regexes of "<status> <METHOD> <path>" that are expected
 *   opts.viewport   { width, height }
 */
function e2e(name, fn, opts = {}) {
  test(name, { timeout: opts.timeout ?? 120000 }, async () => {
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 } });
    ctx.setDefaultTimeout(20000);
    const page = await ctx.newPage();
    const errs = watch(page);
    try {
      if (opts.login !== false) await loginViaStorage(page);
      await fn(page, errs);
      await page.waitForTimeout(300); // let late errors surface
      const api = errs.api.filter((e) => !(opts.allowApi ?? []).some((re) => re.test(e)));
      assert.deepEqual({ pageErrors: errs.page, consoleErrors: errs.console, apiErrors: api },
        { pageErrors: [], consoleErrors: [], apiErrors: [] }, 'browser reported errors');
    } catch (err) {
      const file = path.join(SHOTS, `${slug(name)}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      throw new Error(`${err.message}\n  screenshot: ${file}\n  url: ${page.url()}\n  pageErrors: ${JSON.stringify(errs.page)}\n` +
        `  consoleErrors: ${JSON.stringify(errs.console)}\n  apiErrors: ${JSON.stringify(errs.api)}`, { cause: err });
    } finally {
      await ctx.close();
    }
  });
}

const pathname = (page) => new URL(page.url()).pathname;
const rows = (page) => page.locator('.ant-table-tbody tr.ant-table-row');

async function pickOption(page, inputId, text) {
  await page.locator(`.ant-select:has(#${inputId}) .ant-select-selector`).click();
  await page.locator(`#${inputId}`).fill(text).catch(() => {});
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: text }).first().click();
}

/** Call the test API directly (setup / checks), as the admin unless a token is given. */
async function call(method, p, body, token = session.token) {
  const r = await fetch(`${env.baseUrl}${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  assert.ok(r.ok, `${method} ${p} → ${r.status} ${text}`);
  return j;
}

/**
 * The client just wrote on WhatsApp (an inbound message now), so business
 * messages to them are inside the 24-hour window and go out as free text.
 */
async function clientWroteNow(conversationId, clientId, body = 'Hi, any news?') {
  const db = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(`INSERT INTO messages (conversation_id, client_id, body, direction, created_at) VALUES ($1, $2, $3, 'inbound', now())`,
      [conversationId, clientId, body]);
  } finally { await db.end(); }
}

async function clientByName(name) {
  const { items } = await call('GET', `/api/clients?search=${encodeURIComponent(name)}`);
  assert.ok(items[0], `client ${name} not found`);
  return items[0];
}

/** A job at "Awaiting deposit": quote priced + sent, accepted, order created. → { quotationId, orderId } */
async function jobAwaitingDeposit(clientName) {
  const client = await clientByName(clientName);
  const lineItems = [{ name: 'Golf shirt', quantity: 10, unitPrice: 150 }];
  const { quotation } = await call('POST', '/api/quotations', { clientId: client.id, lineItems });
  await call('POST', `/api/quotations/${quotation.id}/approve`, { lineItems });
  await call('PATCH', `/api/quotations/${quotation.id}/status`, { status: 'accepted' });
  const { order } = await call('POST', `/api/orders/convert-from-quotation/${quotation.id}`, {});
  return { quotationId: quotation.id, orderId: order.id, client };
}

async function loginAs(email, password) {
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200, `login ${email} failed`);
  return r.json();
}

const nextTitle = (page) => page.locator('#next-step-title');

/** Click "Start a quote"; if the client already has an open job, confirm starting another. */
async function startQuote(page, button) {
  await button.click()
  const confirm = page.locator('.ant-modal-confirm', { hasText: 'already has an open job' })
  const opened = await Promise.race([
    page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15000 }).then(() => 'job'),
    confirm.waitFor({ timeout: 15000 }).then(() => 'confirm'),
  ])
  if (opened === 'confirm') {
    await confirm.getByRole('button', { name: 'Start another quote' }).click()
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/)
  }
}
async function expectNext(page, text) {
  await page.locator('#next-step-title', { hasText: text }).waitFor({ timeout: 15000 });
}
async function runPrimary(page, label) {
  await page.locator('.braq-next-primary').getByRole('button', { name: label, exact: true }).click();
}

// ════════════════════════════════════════════════════════════════════════════
describe('environment', () => {
  test('seed-testing.js seeds the demo data without error', () => {
    assert.equal(seedError, null, `seed-testing.js failed:\n${seedError}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('auth', () => {
  e2e('login with wrong password shows a persistent "Invalid credentials" error', async (page) => {
    await page.goto(`${APP}/login`);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#password').fill('WrongPassword!1');
    let reloads = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads++; });
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForResponse((r) => r.url().endsWith('/api/staff/login'));
    await page.waitForTimeout(2500);
    // api/client.js interceptor does window.location.href='/login' on every 401 → full reload wipes the Alert.
    assert.ok(await page.getByText('Invalid credentials').isVisible(),
      `no "Invalid credentials" message after a 401 (main-frame navigations after submit: ${reloads})`);
    assert.equal(pathname(page), '/login');
  }, { login: false, allowApi: [/^401 POST \/api\/staff\/login$/] });

  e2e('login with a too-short password shows a readable error instead of crashing', async (page) => {
    await page.goto(`${APP}/login`);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#password').fill('abc');
    await page.getByRole('button', { name: /sign in/i }).click();
    const err = page.locator('.ant-alert-error, .ant-form-item-explain-error').first();
    await err.waitFor({ timeout: 8000 });
    assert.match(await err.innerText(), /\w/, 'error is empty');
    assert.ok(await page.getByText('Welcome back').isVisible(), 'login page no longer rendered');
  }, { login: false, allowApi: [/^400 POST \/api\/staff\/login$/] });

  e2e('login with correct credentials lands on the dashboard', async (page) => {
    await page.goto(`${APP}/login`);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(`${APP}/`);
    await page.locator('.braq-board').waitFor();
    await page.getByText(/Good (morning|afternoon|evening), Test/).waitFor();
    assert.ok(await page.evaluate(() => !!localStorage.getItem('braq_token')));
  }, { login: false });

  e2e('logout clears the session and returns to /login', async (page) => {
    await page.goto(`${APP}/`);
    await page.locator('.braq-board').waitFor();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: /Log out/ }).click();
    await page.waitForURL(`${APP}/login`);
    assert.equal(await page.evaluate(() => localStorage.getItem('braq_token')), null);
    await page.goto(`${APP}/jobs`);
    await page.waitForURL(`${APP}/login`);
  });

  e2e('protected routes redirect to /login when not logged in', async (page) => {
    for (const p of ['/', '/jobs', '/orders', '/clients', '/tickets/xyz', '/analytics']) {
      await page.goto(`${APP}${p}`);
      await page.waitForURL(`${APP}/login`);
      await page.getByText('Welcome back').waitFor();
    }
  }, { login: false });

  e2e('garbage token in localStorage → redirected to /login and session cleared', async (page) => {
    await loginViaStorage(page, { token: 'garbage.token.value', staff: session.staff });
    await page.goto(`${APP}/orders`);
    await page.waitForURL(`${APP}/login`, { timeout: 15000 });
    await page.getByText('Welcome back').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('braq_token')), null);
  }, { login: false, allowApi: [/^401 /] });

  e2e('expired token in localStorage → redirected to /login', async (page) => {
    const s = session.staff;
    const expired = jwt.sign({ id: s.id, email: s.email, role: s.role, name: s.name }, JWT_SECRET, { expiresIn: -60 });
    await loginViaStorage(page, { token: expired, staff: s });
    await page.goto(`${APP}/`);
    await page.waitForURL(`${APP}/login`, { timeout: 15000 });
    await page.getByText('Welcome back').waitFor();
  }, { login: false, allowApi: [/^401 /] });
});

// ════════════════════════════════════════════════════════════════════════════
describe('every routed page renders with data', () => {
  e2e('dashboard: stat board, work queue (one queue per job), production floor', async (page) => {
    await page.goto(`${APP}/`);
    await page.locator('.braq-board').waitFor();
    assert.equal(await page.locator('.braq-board-cell').count(), 6);
    const pricing = page.locator('.braq-board-cell', { hasText: 'Needs pricing' });
    // Numbers count up once when the data arrives.
    let n = 0;
    for (let i = 0; i < 40 && n < 2; i++) {
      n = Number((await pricing.locator('.braq-board-num').innerText()).match(/\d+/)?.[0] ?? 0);
      if (n < 2) await page.waitForTimeout(250);
    }
    assert.ok(n >= 2, `expected ≥2 jobs needing pricing from seed, board shows ${n}`);
    const queue = page.locator('section[aria-labelledby="queue-pricing"]');
    await queue.getByText('Needs pricing', { exact: true }).waitFor();
    assert.ok(await queue.locator('a.braq-queue-job-link').count() >= 2, 'needs-pricing queue is empty');
    // A queue row opens that exact job; a board cell opens the board pre-filtered.
    await queue.locator('a.braq-queue-job-link').first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expectNext(page, 'Price & send quote');
    await page.goBack();
    await page.locator('.braq-board-cell', { hasText: 'Needs pricing' }).click();
    await page.waitForURL(/\/jobs\?state=PRICING$/);
    await page.locator('.braq-chip.active', { hasText: 'Pricing' }).waitFor();
    await page.goto(`${APP}/`);
    const floor = page.locator('section[aria-labelledby="floor-title"]');
    await floor.locator('.braq-seam').first().waitFor();
  });

  e2e('jobs board: state chips with counts, search and URL-synced filters', async (page) => {
    await page.goto(`${APP}/jobs`);
    await page.locator('.braq-page-title', { hasText: 'Jobs' }).waitFor();
    await rows(page).first().waitFor();
    const all = Number(await page.locator('.braq-chip', { hasText: 'All' }).locator('.braq-chip-count').innerText());
    assert.ok(all >= 5, `All chip shows ${all}`);
    await page.locator('.braq-chip', { hasText: 'Pricing' }).click();
    await page.waitForURL(/state=PRICING/);
    await page.waitForTimeout(500);
    const states = await rows(page).locator('.braq-pill').allInnerTexts();
    assert.ok(states.includes('Pricing'), `rows after filtering: ${states.join(', ')}`);
    assert.ok(!states.includes('Awaiting deposit'));
    await page.getByLabel('Search jobs').fill('Bongani');
    await page.waitForURL(/q=Bongani/);
    await rows(page).filter({ hasNotText: 'Bongani' }).first().waitFor({ state: 'detached' }).catch(() => {});
    assert.ok(await rows(page).count() >= 1);
    for (const t of await rows(page).allInnerTexts()) assert.match(t, /Bongani/);
    // Open the job, then Back returns to the same filtered view.
    await rows(page).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
    await page.locator('.braq-back').click();
    await page.waitForURL(/\/jobs\?.*state=PRICING/);
    assert.equal(await page.getByLabel('Search jobs').inputValue(), 'Bongani');
  });

  e2e('/orders opens the Jobs board Orders view (seeded orders, incl. pre-quote ones) and opens a job', async (page) => {
    await page.goto(`${APP}/orders`);
    await page.waitForURL(/\/jobs\?view=orders$/);
    await page.locator('.braq-page-title', { hasText: 'Jobs' }).waitFor();
    await rows(page).first().waitFor();
    assert.ok(await rows(page).count() >= 4, 'seeded orders (incl. legacy ones, migration 0009) are jobs');
    await rows(page).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await page.locator('#next-step-title').waitFor();
    await page.getByText(/BRQ-O-/).first().waitFor();
    await page.getByRole('heading', { name: 'Payments' }).waitFor();
  });

  e2e('seeded orders show a valid stage (seed uses legacy stage names)', async (page) => {
    await page.goto(`${APP}/`);
    const floor = page.locator('section[aria-labelledby="floor-title"]');
    await floor.locator('.braq-seam').first().waitFor();
    const stages = await floor.locator('.braq-seam').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert.ok(stages.length >= 3, 'production floor shows no stage seams');
    const valid = /^Stage [1-4] of 4: (Awaiting deposit|In production|Ready|Completed)( \(on hold\))?$/;
    assert.deepEqual(stages.filter((s) => !valid.test(String(s).trim())), [], 'orders show raw/unknown stage values');
    await floor.locator('a.braq-queue-row').first().click();
    await page.locator('.braq-journey').waitFor();
    assert.equal(await page.getByRole('img', { name: /Step 0 of/ }).count(), 0, 'journey shows "Step 0"');
  });

  e2e('clients list shows each client\'s WhatsApp number', async (page) => {
    await page.goto(`${APP}/clients`);
    await page.locator('.braq-page-title', { hasText: 'Clients' }).waitFor();
    await rows(page).first().waitFor();
    assert.ok(await rows(page).count() >= 7);
    await page.getByText('Nomsa Khumalo').waitFor();
    assert.ok(await page.getByText('27821234567').count() > 0, 'WhatsApp number not shown in list');
  });

  e2e('client page: jobs with state, tickets, start a quote / open chat', async (page) => {
    await page.goto(`${APP}/clients`);
    await page.getByText('Bongani Mokoena').click();
    await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
    await page.locator('.braq-back', { hasText: 'Clients' }).waitFor();
    await page.getByRole('tab', { name: /Jobs \(\d+\)/ }).waitFor();
    await page.getByRole('tab', { name: /Tickets \(\d+\)/ }).waitFor();
    await page.getByRole('button', { name: 'Start a quote' }).waitFor();
    await page.getByRole('button', { name: /Open chat|Start a chat/ }).waitFor();
    await page.getByRole('heading', { name: 'Money' }).waitFor();
    const job = page.locator('.ant-tabs-tabpane-active .ant-table-row').first();
    await job.locator('.braq-pill').first().waitFor();
    await job.locator('a.braq-ref').click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  });

  e2e('client detail shows the WhatsApp number', async (page) => {
    await page.goto(`${APP}/clients`);
    await page.getByText('Nomsa Khumalo').click();
    await page.locator('.braq-back').waitFor();
    const wa = page.locator('xpath=//th[contains(@class,"ant-descriptions-item-label")][normalize-space()="WhatsApp"]/following-sibling::td[1]');
    assert.equal((await wa.first().innerText()).trim(), '27821234567');
  });

  e2e('editing a client with empty fields saves successfully', async (page) => {
    await page.goto(`${APP}/clients`);
    await page.getByText('Nomsa Khumalo').click();
    await page.locator('.braq-back').waitFor();
    await page.getByRole('button', { name: /Edit/ }).click();
    const modal = page.locator('.ant-modal', { hasText: 'Edit client' });
    await modal.waitFor();
    await modal.locator('#name').fill('Nomsa Khumalo-E2E');
    await modal.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Client updated').waitFor({ timeout: 8000 });
    await page.getByText('Nomsa Khumalo-E2E').first().waitFor();
  });

  e2e('products page lists catalogue by category', async (page) => {
    await page.goto(`${APP}/products`);
    await page.locator('.braq-page-title', { hasText: 'Products' }).waitFor();
    await page.getByRole('tab', { name: /School wear/ }).waitFor();
    await rows(page).first().waitFor();
    assert.ok(await rows(page).count() >= 1);
  });

  e2e('/quotations opens the Jobs board Quotes view → job page (quote being priced)', async (page) => {
    await page.goto(`${APP}/quotations?status=draft`);
    await page.waitForURL(/\/jobs\?view=quotes&state=PRICING$/);
    await page.locator('.braq-chip.active', { hasText: 'Pricing' }).waitFor();
    await rows(page).first().waitFor();
    await page.goto(`${APP}/quotations`);
    await page.waitForURL(/\/jobs\?view=quotes$/);
    await rows(page).first().waitFor();
    assert.ok(await rows(page).count() >= 3);
    for (const t of await rows(page).locator('.braq-pill').first().allInnerTexts()) assert.match(t, /Pricing|Quoted|Accepted|Expired|Declined/);
    await rows(page).filter({ hasText: 'Pricing' }).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expectNext(page, 'Price & send quote');
    await page.getByText(/BRQ-Q-/).first().waitFor();
    await page.getByRole('button', { name: /Add line item/ }).waitFor();
  });

  e2e('tickets list → detail with links to the client and chat', async (page) => {
    await page.goto(`${APP}/tickets`);
    await page.locator('.braq-page-title', { hasText: 'Support Tickets' }).waitFor();
    await rows(page).first().waitFor();
    assert.ok(await rows(page).count() >= 3);
    await rows(page).first().click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]{36}$/);
    await page.locator('.braq-page-title', { hasText: /^Ticket #[0-9A-F]{8} — / }).waitFor();
    await page.getByText('Update Status').waitFor();
    await page.locator('.ant-descriptions a[href^="/clients/"]').waitFor();
  });

  e2e('tickets: resolving asks for a note; clearing the assignee unassigns', async (page) => {
    const { items } = await call('GET', '/api/tickets?status=open');
    const ticket = items[0];
    assert.ok(ticket, 'no open seeded ticket');
    const staffList = (await call('GET', '/api/staff')).staff;
    await call('PATCH', `/api/tickets/${ticket.id}`, { assignedStaffId: staffList[0].id });
    await page.goto(`${APP}/tickets/${ticket.id}`);
    await page.locator('.braq-page-title', { hasText: 'Ticket #' }).waitFor();
    // Clear the assignee
    await page.locator('.ant-select:has(#ticket-assignee)').hover();
    await page.locator('.ant-select:has(#ticket-assignee) .ant-select-clear').click();
    await page.getByText('Ticket unassigned').waitFor();
    assert.equal((await call('GET', `/api/tickets/${ticket.id}`)).ticket.assigned_staff_id, null);
    // Resolve with a note
    await page.locator('.ant-select:has(#ticket-status) .ant-select-selector').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Resolved' }).click();
    const modal = page.locator('.ant-modal', { hasText: 'Resolve ticket' });
    await modal.waitFor();
    await modal.locator('#resolution-note').fill('Replacement shirts collected');
    await modal.getByRole('button', { name: /Resolve and notify/ }).click();
    await page.getByText('Replacement shirts collected').first().waitFor();
    const after = (await call('GET', `/api/tickets/${ticket.id}`)).ticket;
    assert.equal(after.status, 'resolved');
    assert.equal(after.resolution_note, 'Replacement shirts collected');
  });

  e2e('inbox list → conversation with the client panel', async (page) => {
    await page.goto(`${APP}/inbox`);
    await page.locator('.braq-page-title', { hasText: 'Inbox' }).waitFor();
    const items = page.locator('.braq-queue-row');
    await page.getByText('All open').click();
    await page.waitForURL(/view=all/);
    await items.first().waitFor();
    await page.waitForTimeout(800);
    assert.ok(await items.count() >= 2, `expected ≥2 open seeded conversations, got ${await items.count()}`);
    await items.first().click();
    await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: /Send|Take over/i }).first().waitFor();
    await page.getByText(/\d{11}/).first().waitFor(); // client WhatsApp number in the header
    const panel = page.locator('.braq-client-panel');
    await panel.getByText('Open jobs').waitFor();
    await panel.getByRole('button', { name: 'Start a quote' }).waitFor();
    await panel.getByRole('button', { name: 'Open ticket' }).waitFor();
  });

  e2e('inbox: "Mine" asks only for my conversations; search filters', async (page) => {
    await page.goto(`${APP}/inbox`);
    await page.locator('.braq-page-title', { hasText: 'Inbox' }).waitFor();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/conversations?') && r.url().includes('assignedToMe=true')),
      page.getByText('Mine', { exact: true }).click(),
    ]);
    assert.match(req.url(), /assignedToMe=true/);
    await page.getByText('All open').click();
    await page.locator('.braq-queue-row').first().waitFor();
    await page.getByLabel('Search conversations').fill('Bongani');
    await page.waitForURL(/q=Bongani/);
    await page.waitForTimeout(600);
    for (const t of await page.locator('.braq-queue-row').allInnerTexts()) assert.match(t, /Bongani/i);
  });

  e2e('broadcasts page renders history', async (page) => {
    await page.goto(`${APP}/broadcasts`);
    await page.getByText('WhatsApp Broadcasts').waitFor();
    await page.locator('.ant-table').first().waitFor();
  });

  e2e('staff page lists members', async (page) => {
    await page.goto(`${APP}/staff`);
    await page.locator('.braq-page-title', { hasText: 'Staff' }).waitFor();
    await page.getByText(ADMIN.email).waitFor();
    assert.ok(await rows(page).count() >= 2);
  });

  e2e('analytics page renders revenue dashboard', async (page) => {
    await page.goto(`${APP}/analytics`);
    await page.getByText('Revenue Dashboard').waitFor();
    await page.getByText('This Month').waitFor();
    await page.getByText('All-Time Revenue').waitFor();
  });

  e2e('purchase orders page is reachable at /purchase-orders and loads', async (page) => {
    await page.goto(`${APP}/purchase-orders`);
    await page.waitForTimeout(1500);
    assert.equal(pathname(page), '/purchase-orders', 'redirected away (no route)');
    await page.locator('.braq-page-title', { hasText: 'Purchase orders' }).waitFor({ timeout: 5000 });
    await page.locator('.braq-nav-group', { hasText: 'Admin' }).locator('.braq-nav-item', { hasText: 'Purchase orders' }).waitFor();
  });

  e2e('school catalog page is reachable at /school-catalog and loads', async (page) => {
    await page.goto(`${APP}/school-catalog`);
    await page.waitForTimeout(1500);
    assert.equal(pathname(page), '/school-catalog', 'redirected away (no route)');
    await page.getByText('School Catalog').first().waitFor({ timeout: 5000 });
  });

  e2e('Size run sheet download is authorised', async (page) => {
    const { items } = await call('GET', '/api/orders?limit=50');
    const withQuote = items.find((o) => o.quotation_id && !String(o.quotation_reference ?? '').startsWith('BRQ-Q-LEGACY-'));
    assert.ok(withQuote, 'no seeded order has a quotation');
    await page.goto(`${APP}/jobs/${withQuote.quotation_id}?tab=order`);
    const btn = page.getByRole('button', { name: /Size run sheet/i });
    await btn.waitFor();
    // No raw <a href="/api/..."> (that navigation carries no Bearer header → 401).
    assert.equal(await page.locator('a[href*="/api/"]').count(), 0, 'plain /api link rendered');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/size-run-sheet')),
      btn.click(),
    ]);
    assert.equal(res.status(), 200, `GET ${new URL(res.url()).pathname} → ${res.status()}`);
    assert.match(res.headers()['content-type'] ?? '', /pdf/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('job lifecycle via UI', () => {
  e2e('full journey: start a quote from a chat → price & send → … → collected, page stays on the job', async (page) => {
    const list = await call('GET', '/api/conversations?isOpen=all&limit=100');
    const conv = (list.items ?? list.conversations ?? []).find((c) => c.client_name === 'Pastor Trevor Matthews');
    assert.ok(conv, 'seeded conversation for Pastor Trevor Matthews not found');
    const phone = conv.client_wa_id;
    await clientWroteNow(conv.id, conv.client_id, 'Can you quote choir robes?');

    // 1. Start a quote from the chat's client panel → the new job opens.
    await page.goto(`${APP}/inbox/${conv.id}`);
    await startQuote(page, page.locator('.braq-client-panel').getByRole('button', { name: 'Start a quote' }));
    const jobUrl = page.url();
    const quotationId = pathname(page).split('/').pop();
    await expectNext(page, 'Price & send quote');
    await page.getByRole('img', { name: /^Job step 1 of 8: Pricing/ }).waitFor();

    // 2. Price it: one item, a size run, a unit price.
    await page.getByRole('button', { name: /Add line item/ }).click();
    await page.getByPlaceholder('Search the catalogue or type an item name').fill('Choir robe');
    await page.getByRole('button', { name: 'Adults' }).click();
    await page.getByLabel('Quantity for size M').fill('10');
    await page.getByLabel('Quantity for size L').fill('5');
    await page.getByLabel('Unit price').fill('350');
    await page.getByLabel('Unit price').blur();
    await page.locator('.braq-next-primary').getByText(/Total R/).waitFor();

    // 3. Price & send → waiting on the client.
    env.clearFakeCalls();
    await runPrimary(page, 'Price & send quote');
    await expectNext(page, 'Client accepted — create order');
    assert.equal(page.url(), jobUrl, 'left the job page after sending');
    await env.waitForJobs();
    assert.ok(env.fakeCalls('whatsapp').some((c) => c.body?.to === phone), 'the quote was not sent to the client on WhatsApp');

    // 4. The client said yes: accept + create the order in one step.
    await runPrimary(page, 'Client accepted — create order');
    await expectNext(page, 'Record deposit');

    // 5. Blocked step explained (not a toast): start production needs the deposit.
    const blocked = page.locator('.braq-blocked', { hasText: 'Start production' });
    await blocked.waitFor();
    assert.match(await blocked.innerText(), /deposit has not been recorded/i);

    // 6. Record the deposit (amount prefilled).
    assert.ok(Number(await page.locator('#act-record_deposit_amount').inputValue()) > 0, 'deposit amount not prefilled');
    await runPrimary(page, 'Record deposit');
    await expectNext(page, 'Start production');

    // 7. Send a proof → production waits for approval → mark approved.
    await page.locator('.braq-next-more').getByRole('button', { name: 'Send design proof' }).click();
    await page.locator('#act-send_proof_proofUrl').fill('https://example.com/proof.pdf');
    await page.locator('.braq-next-more-form').getByRole('button', { name: 'Send design proof' }).click();
    await expectNext(page, 'Approve design');
    await page.locator('.braq-blocked', { hasText: /awaiting client approval/i }).waitFor();
    await runPrimary(page, 'Approve design');
    await expectNext(page, 'Start production');

    // 8. Start production with a due date → mark ready.
    await page.locator('#act-start_production_estimatedCompletion').fill('2026-12-01');
    await runPrimary(page, 'Start production');
    await expectNext(page, 'Mark ready');
    await runPrimary(page, 'Mark ready');
    await expectNext(page, 'Mark collected');

    // 9. Mark collected with the balance taken at the counter (prefilled) → done.
    assert.ok(Number(await page.locator('#act-mark_collected_balanceAmount').inputValue()) > 0, 'balance not prefilled');
    await runPrimary(page, 'Mark collected');
    await expectNext(page, 'Job complete');
    await page.getByRole('img', { name: /^Job step 8 of 8: Collected/ }).waitFor();
    assert.equal(page.url(), jobUrl, 'the job page navigated away during the journey');

    const job = await call('GET', `/api/jobs/${quotationId}`);
    assert.equal(job.lifecycle.state, 'COMPLETED');
    assert.equal(job.order.payment_status, 'paid_in_full');
    // History shows the whole story.
    await page.getByRole('tab', { name: 'History' }).click();
    await page.locator('.braq-timeline').getByText('Proof approved').waitFor();
    await page.locator('.braq-timeline').getByText(/Moved to completed/).waitFor();
  }, { timeout: 240000 });

  e2e('New job (board): create the order from a client\'s accepted quote, then open its job', async (page) => {
    const client = await clientByName('Bongani');
    const lineItems = [{ name: 'Golf shirt', quantity: 10, unitPrice: 150 }];
    const { quotation } = await call('POST', '/api/quotations', { clientId: client.id, lineItems });
    await call('POST', `/api/quotations/${quotation.id}/approve`, { lineItems });
    await call('PATCH', `/api/quotations/${quotation.id}/status`, { status: 'accepted' });
    const ref = (await call('GET', `/api/quotations/${quotation.id}`)).quotation.reference;

    await page.goto(`${APP}/jobs`);
    await rows(page).first().waitFor();
    await page.getByRole('button', { name: /New job/ }).click();
    const modal = page.locator('.ant-modal', { hasText: 'New job' });
    await modal.waitFor();
    await pickOption(page, 'new-job_clientId', 'Bongani Mokoena');
    const row = modal.locator('.braq-new-job-row', { hasText: ref });
    await row.waitFor();
    await row.getByRole('button', { name: 'Create order' }).click();
    await page.waitForURL(new RegExp(`/jobs/${quotation.id}\\?tab=order$`));
    await expectNext(page, 'Record deposit');
    assert.ok(env.fakeCalls('whatsapp').some((c) => c.body?.to === '27834445566'), 'no deposit WhatsApp to the client');
  });

  e2e('manager override: start production before the deposit, with a reason', async (page) => {
    const email = `manager-${Date.now()}@test.local`;
    await call('POST', '/api/staff', { name: 'Mandla Manager', email, password: 'Manager123!', role: 'manager' });
    const manager = await loginAs(email, 'Manager123!');
    const { quotationId, orderId } = await jobAwaitingDeposit('Johan');
    await loginViaStorage(page, manager);
    await page.goto(`${APP}/jobs/${quotationId}`);
    await expectNext(page, 'Record deposit');
    const blocked = page.locator('.braq-blocked', { hasText: 'Start production' });
    await blocked.getByRole('button', { name: 'Skip the check (manager)…' }).click();
    const dialog = page.locator('.ant-modal', { hasText: 'Skip the check: start production' });
    await dialog.waitFor();
    await dialog.getByText(/deposit has not been recorded/i).waitFor();
    await dialog.locator('#override_reason').fill('abc');
    await dialog.getByRole('button', { name: /^Skip the check and/ }).click();
    await dialog.getByText('Write at least 5 characters').waitFor();
    await dialog.locator('#override_reason').fill('School account on 30-day terms');
    await dialog.getByRole('button', { name: /^Skip the check and/ }).click();
    await expectNext(page, 'Mark ready');
    const { order } = await call('GET', `/api/orders/${orderId}`);
    assert.equal(order.stage, 'in_production');
    await page.getByRole('tab', { name: 'History' }).click();
    await page.locator('.braq-timeline').getByText(/by override/).waitFor();
    await page.locator('.braq-timeline').getByText(/School account on 30-day terms/).waitFor();
  });

  e2e('consultant sees why a step is blocked but gets no override', async (page) => {
    const lerato = await loginAs('lerato@braquni.com', 'Braq@2025!');
    assert.equal(lerato.staff.role, 'consultant');
    const { quotationId } = await jobAwaitingDeposit('Zanele');
    await loginViaStorage(page, lerato);
    await page.goto(`${APP}/jobs/${quotationId}`);
    await expectNext(page, 'Record deposit');
    const blocked = page.locator('.braq-blocked', { hasText: 'Start production' });
    await blocked.getByText('An admin or manager can skip this check.').waitFor();
    assert.equal(await page.getByRole('button', { name: /Skip the check/ }).count(), 0, 'consultant was offered an override');
    // No locked "Record purchase order" for consultants, and no PO log in their sidebar.
    assert.equal(await page.getByText('Record purchase order').count(), 0);
    assert.equal(await page.locator('.braq-nav-item', { hasText: 'Purchase orders' }).count(), 0);
    // Role-aware navigation: no Staff / Analytics for consultants.
    assert.equal(await page.locator('.braq-nav-item', { hasText: 'Analytics' }).count(), 0);
    assert.equal(await page.locator('.braq-nav-item', { hasText: 'Staff' }).count(), 0);
    await page.goto(`${APP}/analytics`);
    await page.getByText('Analytics is for admins and managers').waitFor();
    await page.goto(`${APP}/staff`);
    await page.getByText("You don't have access to this page").waitFor();
  });

  e2e('old URLs redirect to the job page', async (page) => {
    const { quotationId, orderId } = await jobAwaitingDeposit('David');
    await page.goto(`${APP}/quotations/${quotationId}/build`);
    await page.waitForURL(new RegExp(`/jobs/${quotationId}\\?tab=quote$`));
    await page.locator('#next-step-title').waitFor();
    await page.goto(`${APP}/orders/${orderId}`);
    await page.waitForURL(new RegExp(`/jobs/${quotationId}\\?tab=order$`));
    await expectNext(page, 'Record deposit');
    // An order from before quotes and orders were linked still opens.
    const { items } = await call('GET', '/api/orders?limit=50');
    const legacy = items.find((o) => !o.quotation_id);
    if (legacy) {
      await page.goto(`${APP}/orders/${legacy.id}`);
      await page.getByText('created before quotes and orders were linked').waitFor();
      await page.locator('h1.braq-page-title', { hasText: legacy.reference }).waitFor();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('staff round 2', () => {
  e2e('sidebar: Jobs is the one place for quotes and orders; old lists redirect to board views', async (page) => {
    await page.goto(`${APP}/`);
    await page.locator('.braq-board').waitFor();
    const nav = page.locator('nav.braq-nav');
    await nav.getByRole('button', { name: 'Jobs' }).waitFor();
    assert.equal(await nav.locator('.braq-nav-item', { hasText: /^Quotations$/ }).count(), 0);
    assert.equal(await nav.locator('.braq-nav-item', { hasText: /^Orders$/ }).count(), 0);
    await page.goto(`${APP}/orders?stage=in_production`);
    await page.waitForURL(/\/jobs\?view=orders&state=IN_PRODUCTION$/);
    await page.locator('.braq-view-switch .ant-segmented-item-selected', { hasText: 'Orders' }).waitFor();
    assert.equal(await page.locator('.braq-chip', { hasText: 'Pricing' }).count(), 0, 'quote states are not chips in the Orders view');
    await page.locator('.braq-chip', { hasText: 'In production' }).waitFor();
    // Every chip is visible at 1440 (they wrap, nothing hidden behind a scroll).
    await page.locator('.braq-view-switch .ant-segmented-item', { hasText: 'All jobs' }).click();
    await page.waitForURL(/\/jobs$/);
    const hidden = await page.locator('.braq-chip-row .braq-chip').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().right > window.innerWidth).length);
    assert.equal(hidden, 0);
  });

  e2e('dashboard: "Client accepted — create order" is the top queue and creates the order in one click', async (page) => {
    const client = await clientByName('Johan');
    const lineItems = [{ name: 'Security shirt', quantity: 12, unitPrice: 210 }];
    const { quotation } = await call('POST', '/api/quotations', { clientId: client.id, lineItems });
    await call('POST', `/api/quotations/${quotation.id}/approve`, { lineItems });
    await call('PATCH', `/api/quotations/${quotation.id}/status`, { status: 'accepted' });   // the client said "accept" on WhatsApp
    await page.goto(`${APP}/?who=all`);
    const first = page.locator('.braq-queue-grid > section').first();
    await first.locator('h3', { hasText: 'Client accepted — create order' }).waitFor();
    const row = first.locator('.braq-queue-job', { hasText: quotation.reference });
    await row.waitFor();
    // Each job appears in one queue only.
    assert.equal(await page.locator('.braq-queue-job', { hasText: quotation.reference }).count(), 1);
    await row.getByRole('button', { name: /^Create order/ }).click();
    await page.getByText(/Create order — done/).waitFor();
    await row.waitFor({ state: 'detached' });
    const job = await call('GET', `/api/jobs/${quotation.id}`);
    assert.equal(job.lifecycle.state, 'AWAITING_DEPOSIT');
    assert.equal(job.order.assigned_staff_id, session.staff.id, 'owner = whoever created the order');
    // The deposit queue now has it; Mine / Everyone toggles the owner filter.
    await page.locator('section[aria-labelledby="queue-deposit"] .braq-queue-job', { hasText: job.order.reference }).waitFor();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/jobs?') && r.url().includes('owner=me')),
      page.locator('.braq-page-actions .ant-segmented-item', { hasText: 'Mine' }).click(),
    ]);
    assert.match(req.url(), /queue=accepted/);
  });

  e2e('quote autosave: edits are saved as you go and survive leaving the page', async (page) => {
    const client = await clientByName('Nomsa');
    const { quotation } = await call('POST', '/api/quotations', { clientId: client.id, notes: 'Wants hoodies' });
    await page.goto(`${APP}/jobs/${quotation.id}?tab=quote`);
    await expectNext(page, 'Price & send quote');
    await page.getByRole('button', { name: /Add line item/ }).click();
    await page.getByPlaceholder('Search the catalogue or type an item name').fill('Pullover Hoodie');
    await page.locator('.ant-select-item-option', { hasText: 'Pullover Hoodie (310g)' }).first().click();
    // The catalogue's sizes come with the product (catalogue spelling: 2XL).
    await page.getByLabel('Quantity for size 2XL').fill('3');
    await page.getByLabel('Quantity for size 2XL').blur();
    await page.locator('[data-save="saved"]').first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Duplicate item 1/ }).click();
    await page.locator('#quote-notes').fill('Wants hoodies — logo on the back');
    // Leave straight away through the sidebar: the save still waiting is sent on the way out.
    await page.locator('nav.braq-nav').getByRole('button', { name: 'Jobs' }).click();
    await rows(page).first().waitFor();
    await page.goto(`${APP}/jobs/${quotation.id}?tab=quote`);
    await page.getByLabel('Quantity for size 2XL').first().waitFor();
    assert.equal(await page.getByRole('heading', { name: /^Item \d/ }).count(), 2, 'both lines saved');
    assert.equal(await page.locator('#quote-notes').inputValue(), 'Wants hoodies — logo on the back');
    const q = (await call('GET', `/api/quotations/${quotation.id}`)).quotation;
    assert.equal(q.status, 'draft');
    assert.equal(q.line_items[0].sizes.find((s) => s.size === '2XL').qty, 3);
    // Preview the PDF before sending (a draft — only signed-in staff can fetch it).
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/quotations/${quotation.id}/pdf`)),
      page.getByRole('button', { name: 'Preview PDF' }).first().click(),
    ]);
    assert.equal(res.status(), 200);
  });

  e2e('mark collected with the balance taken at the counter', async (page) => {
    const { quotationId, orderId } = await jobAwaitingDeposit('David');
    const { order } = await call('GET', `/api/orders/${orderId}`);
    await call('POST', `/api/orders/${orderId}/payments`, { type: 'deposit', amount: Number(order.deposit_amount) });
    await call('POST', `/api/orders/${orderId}/advance`, {});
    await call('POST', `/api/orders/${orderId}/advance`, {});
    await page.goto(`${APP}/jobs/${quotationId}`);
    await expectNext(page, 'Mark collected');
    const balance = Number(await page.locator('#act-mark_collected_balanceAmount').inputValue());
    assert.ok(Math.abs(balance - Number(order.balance_amount)) < 0.01, `prefilled ${balance}`);
    await runPrimary(page, 'Mark collected');
    await expectNext(page, 'Job complete');
    const after = await call('GET', `/api/orders/${orderId}`);
    assert.deepEqual([after.order.stage, after.order.payment_status], ['completed', 'paid_in_full']);
  });

  e2e('account client: an admin marks the client; the job skips the deposit (Account badge)', async (page) => {
    const client = await clientByName('Zanele');
    await page.goto(`${APP}/clients/${client.id}`);
    const toggle = page.getByRole('switch', { name: /Account client/ });
    await toggle.waitFor();
    if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
    await page.getByText('Account client — no deposit needed before production').waitFor();
    await page.locator('.braq-detail-meta .braq-pill', { hasText: 'Account' }).waitFor();
    const lineItems = [{ name: 'Chef jacket', quantity: 6, unitPrice: 320 }];
    const { quotation } = await call('POST', '/api/quotations', { clientId: client.id, lineItems });
    await call('POST', `/api/quotations/${quotation.id}/approve`, { lineItems });
    await call('POST', `/api/orders/convert-from-quotation/${quotation.id}`, { accept: true });
    await page.goto(`${APP}/jobs/${quotation.id}`);
    await page.locator('.braq-detail-meta .braq-pill', { hasText: 'Account' }).waitFor();
    await expectNext(page, 'Start production');
    await runPrimary(page, 'Start production');
    await expectNext(page, 'Mark ready');
    await call('PATCH', `/api/clients/${client.id}/account-terms`, { accountTerms: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('responsive', () => {
  const overflow = (page) => page.evaluate(() => {
    const vw = window.innerWidth;
    const culprits = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right > vw + 1 && r.width > 0)
      .slice(0, 6)
      .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} right=${Math.round(r.right)}`);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, culprits };
  });

  e2e('dashboard at 375px has no horizontal overflow', async (page) => {
    await page.goto(`${APP}/`);
    await page.locator('.braq-board').waitFor();
    await page.waitForTimeout(600);
    const o = await overflow(page);
    const main = await page.locator('main').boundingBox();
    assert.ok(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}; overflowing: ${o.culprits.join(', ')}`);
    assert.ok(main.width >= 300, `content column is only ${Math.round(main.width)}px wide (fixed 236px sidebar)`);
  }, { viewport: { width: 375, height: 812 } });

  e2e('jobs board and a job page at 390px have no horizontal overflow', async (page) => {
    await page.goto(`${APP}/jobs`);
    await rows(page).first().waitFor();
    let o = await overflow(page);
    assert.ok(o.scrollWidth <= o.innerWidth, `/jobs: scrollWidth ${o.scrollWidth} > ${o.innerWidth}; ${o.culprits.join(', ')}`);
    await rows(page).first().click();
    await page.locator('#next-step-title').waitFor();
    await page.waitForTimeout(600);
    o = await overflow(page);
    assert.ok(o.scrollWidth <= o.innerWidth, `job page: scrollWidth ${o.scrollWidth} > ${o.innerWidth}; ${o.culprits.join(', ')}`);
  }, { viewport: { width: 390, height: 844 } });

  e2e('login page at 375px has no horizontal overflow', async (page) => {
    await page.goto(`${APP}/login`);
    await page.getByText('Welcome back').waitFor();
    await page.waitForTimeout(800);
    const o = await overflow(page);
    assert.ok(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}; overflowing: ${o.culprits.join(', ')}`);
  }, { login: false, viewport: { width: 375, height: 812 } });
});

// ════════════════════════════════════════════════════════════════════════════
describe('console hygiene', () => {
  test('no React/antd dev warnings were logged while browsing', () => {
    const list = [...devWarnings].map(([w, p]) => `${p}: ${w}`);
    assert.deepEqual(list, []);
  });
});
