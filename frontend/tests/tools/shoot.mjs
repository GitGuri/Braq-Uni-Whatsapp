/**
 * Screenshot pages of a running preview (see preview.mjs).
 *
 *   node tests/tools/shoot.mjs <outDir> [route ...]      e.g.  /  /orders  /login
 *   SHOOT_WIDTHS=1440,390  SHOOT_FULL=1  SHOOT_THEME=dark
 *
 * Use ":first-order", ":first-client", ":first-ticket", ":first-convo", ":first-quote"
 * to open the first row of the matching list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const info = JSON.parse(fs.readFileSync(process.env.PREVIEW_INFO || path.join(FRONT, 'tests', 'tools', 'preview.json'), 'utf8'));
const [outDir, ...args] = process.argv.slice(2);
const routes = args.length ? args : ['/login', '/', '/inbox', '/orders', ':first-order', '/quotations', '/clients', '/analytics'];
const widths = (process.env.SHOOT_WIDTHS || '1440').split(',').map(Number);
const full = process.env.SHOOT_FULL === '1';
const theme = process.env.SHOOT_THEME === 'dark' ? 'dark' : 'light';
fs.mkdirSync(outDir, { recursive: true });

const firstOf = { ':first-order': ['/api/orders', 'orders', '/orders/'], ':first-client': ['/api/clients', 'clients', '/clients/'],
  ':first-ticket': ['/api/tickets', 'tickets', '/tickets/'], ':first-convo': ['/api/conversations', 'conversations', '/inbox/'],
  ':first-quote': ['/api/quotations', 'quotations', '/quotations/'] };

async function resolveRoute(route) {
  if (!firstOf[route]) return route;
  const [api, key, prefix] = firstOf[route];
  const r = await fetch(`${info.api}${api}`, { headers: { authorization: `Bearer ${info.token}` } });
  const body = await r.json();
  const list = Array.isArray(body) ? body : body[key] || body.data || [];
  if (!list[0]) return null;
  return route === ':first-quote' ? `${prefix}${list[0].id}/build` : `${prefix}${list[0].id}`;
}

let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }

for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: process.env.SHOOT_REDUCED ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(`${info.app}/login`);
  await page.evaluate(({ t, s, theme }) => { localStorage.setItem('braq_token', t); localStorage.setItem('braq_staff', JSON.stringify(s)); localStorage.setItem('braq_theme', theme); }, { t: info.token, s: info.staff, theme });
  for (const raw of routes) {
    const route = await resolveRoute(raw);
    if (!route) { console.log(`skip ${raw} (no data)`); continue; }
    if (raw === '/login') await page.evaluate((th) => { localStorage.clear(); localStorage.setItem('braq_theme', th) }, theme);
    await page.goto(`${info.app}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(Number(process.env.SHOOT_WAIT) || 1200);
    const name = `${theme === 'dark' ? 'dark-' : ''}${(raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'dashboard')}-${w}.png`;
    await page.screenshot({ path: path.join(outDir, name), fullPage: full });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`${name}${overflow > 0 ? `  OVERFLOW +${overflow}px` : ''}`);
    if (raw === '/login') await page.evaluate(({ t, s, theme }) => { localStorage.setItem('braq_token', t); localStorage.setItem('braq_staff', JSON.stringify(s)); localStorage.setItem('braq_theme', theme); }, { t: info.token, s: info.staff, theme });
  }
  if (errors.length) console.log('PAGE ERRORS:', [...new Set(errors)].join('\n  '));
  await ctx.close();
}
await browser.close();
