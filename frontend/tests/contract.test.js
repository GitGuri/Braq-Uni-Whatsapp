/**
 * White-box API contract check: frontend (frontend/src) vs backend (backend/src).
 *
 *  1. Every HTTP call the dashboard makes maps to a router that is actually
 *     mounted in backend/src/app.js, with the same method.
 *  2. Request field names the pages send match what backend validators read.
 *  3. Response fields the pages render exist in what services return.
 *  4. Every page component is reachable through App.jsx.
 *
 * Pure static analysis: reads source files only, no network, no DB.
 * Tests prefixed "BUG:" assert the correct behaviour and currently fail.
 *
 * Run: cd frontend && node --test tests/contract.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here  = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(here, '..');
const ROOT  = path.resolve(FRONT, '..');
const BACK  = path.join(ROOT, 'backend');
const FSRC  = path.join(FRONT, 'src');
const BSRC  = path.join(BACK, 'src');

const read = (p) => fs.readFileSync(p, 'utf8');
const rel  = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const loc = (file, src, idx) => `${rel(file)}:${lineOf(src, idx)}`;

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** Slice of `src` from the opening brace after `startRe` up to its matching close brace. */
function balanced(src, startIdx, open = '{', close = '}') {
  const i = src.indexOf(open, startIdx);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(i + 1, j);
  }
  return null;
}

/** Top-level keys of an object-literal body (depth-aware). */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (depth === 0 && (ch === ',' || i === body.length - 1)) {
      token += ch === ',' ? '' : ch;
      const m = token.match(/^\s*(?:\.\.\.\s*\w+|(\w+)\s*(?::|,|$))/s);
      if (m?.[1]) keys.push(m[1]);
      token = '';
    } else token += ch;
  }
  return keys;
}

/** Keys + raw definitions of `const NAME = z.object({...})` in a backend file. */
function zodSchema(file, name) {
  const src = read(file);
  const idx = src.indexOf(`const ${name}`);
  assert.ok(idx >= 0, `${name} not found in ${rel(file)}`);
  // Drop `// …` line comments (they precede keys and would hide them from the key regex).
  const body = balanced(src, src.indexOf('z.object(', idx)).replace(/^\s*\/\/.*$/gm, '');
  const defs = {};
  let depth = 0, token = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (depth === 0 && ch === ',') {
      const m = token.match(/^\s*(\w+)\s*:\s*([\s\S]*)$/);
      if (m) defs[m[1]] = m[2].trim();
      token = '';
    } else token += ch;
  }
  const m = token.match(/^\s*(\w+)\s*:\s*([\s\S]*)$/);
  if (m) defs[m[1]] = m[2].trim();
  return { keys: Object.keys(defs), defs, line: `${rel(file)}:${lineOf(src, idx)}` };
}

/** `name="x"` Form.Item names inside a slice of a page file. */
function formNames(file, from = null, to = null) {
  const src = read(file);
  const a = from ? src.indexOf(from) : 0;
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `markers ${from} / ${to} not found in ${rel(file)}`);
  const slice = src.slice(a, b);
  return [...slice.matchAll(/<Form\.Item[^>]*?\bname="(\w+)"/g)].map((m) => ({ name: m[1], at: loc(file, src, a + m.index) }));
}

/** Backend code that queries the DB / answers requests: domain modules (+ any legacy services/controllers dirs still present). */
function backendSources() {
  return ['modules', 'services', 'controllers']
    .map((d) => path.join(BSRC, d))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => walk(d, ['.js']));
}

// ── Backend route table ────────────────────────────────────────────────────────
// Route files: backend/src/modules/<domain>/routes.js (one file may export
// several routers, e.g. catalog) plus any legacy backend/src/routes/*.js that
// still define routes (the remaining ones are re-export shims and define none).
function routeFiles() {
  const files = [];
  const modules = path.join(BSRC, 'modules');
  for (const d of fs.readdirSync(modules)) {
    const f = path.join(modules, d, 'routes.js');
    if (fs.existsSync(f)) files.push(f);
  }
  const legacy = path.join(BSRC, 'routes');
  if (fs.existsSync(legacy)) files.push(...walk(legacy, ['.js']));
  return files;
}

function backendRoutes() {
  // Routers are mounted by createApp() in backend/src/app.js
  const indexFile = path.join(BSRC, 'app.js');
  const index = read(indexFile);
  const importOf = {};
  for (const m of index.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/([\w./]+)'/g)) importOf[m[1]] = m[2];
  const mounts = [...index.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)]
    .map((m) => ({ prefix: m[1], router: m[2], at: loc(indexFile, index, m.index) }));

  const routes = [];
  const routers = [];
  for (const file of routeFiles()) {
    const src = read(file);
    for (const [, exp] of src.matchAll(/export const (\w+)\s*=/g)) {
      routers.push({ name: exp, file: rel(file) });
      const authUse = src.search(new RegExp(`${exp}\\.use\\(\\s*requireAuth`));
      for (const m of src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'([^']+)'([^\n]*)/g)) {
        if (m[1] !== exp) continue;
        const requiresAuth = m[4].includes('requireAuth') || (authUse >= 0 && authUse < m.index);
        routes.push({ router: exp, method: m[2].toUpperCase(), path: m[3], requiresAuth, at: loc(file, src, m.index) });
      }
    }
  }
  const mounted = [];
  for (const r of routes) {
    for (const mt of mounts.filter((x) => x.router === r.router)) {
      mounted.push({ ...r, full: (mt.prefix + (r.path === '/' ? '' : r.path)).replace(/\/+$/, '') || '/' });
    }
  }
  return { routes, routers, mounts, mounted, importOf };
}

// ── Frontend calls ─────────────────────────────────────────────────────────────
function frontendCalls() {
  const calls = [];
  const norm = (p) => p.replace(/\$\{[^}]+\}/g, ':param').replace(/\?.*$/, '').replace(/\/+$/, '');
  for (const file of walk(FSRC, ['.js', '.jsx'])) {
    const src = read(file);
    for (const m of src.matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*(['`])((?:(?!\2).)*)\2/g)) {
      calls.push({ method: m[1].toUpperCase(), path: norm('/api' + m[3]), kind: 'axios', at: loc(file, src, m.index) });
    }
    // Raw URLs used as <a href> / window.open — the browser sends these without the Bearer header.
    for (const m of src.matchAll(/(['`])(\/api\/(?:(?!\1).)*)\1/g)) {
      calls.push({ method: 'GET', path: norm(m[2]), kind: 'link', at: loc(file, src, m.index) });
    }
  }
  return calls;
}

function matchRoute(call, mounted) {
  const cs = call.path.split('/');
  return mounted.find((r) => {
    if (r.method !== call.method) return false;
    const rs = r.full.split('/');
    if (rs.length !== cs.length) return false;
    return rs.every((seg, i) => seg === cs[i] || seg.startsWith(':'));
  });
}

// ── DB columns + service result fields ────────────────────────────────────────
function tableColumns() {
  const cols = {};
  const add = (t, c) => (cols[t] ??= new Set()).add(c);
  // The schema is defined by the versioned migrations (backend/src/db/migrations).
  const dir = path.join(BSRC, 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort().map((f) => path.join(dir, f));
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g)) {
      const body = balanced(src, m.index + m[0].length - 1, '(', ')');
      for (const line of body.split('\n')) {
        const c = line.match(/^\s*(\w+)\s+[A-Za-z]/)?.[1];
        if (c && !['PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN'].includes(c)) add(m[1], c);
      }
    }
    for (const m of src.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g)) add(m[1], m[2]);
  }
  return cols;
}
const COLS = tableColumns();

/** Fields a backend function's SQL can return (over-approximation). */
function resultFields(file, fnName) {
  const src = read(file);
  const start = src.search(new RegExp(`export (?:async )?function ${fnName}\\b`));
  assert.ok(start >= 0, `${fnName} not found in ${rel(file)}`);
  const next = src.indexOf('\nexport ', start + 10);
  const body = src.slice(start, next < 0 ? src.length : next);
  const fields = new Set();
  const alias = {};
  for (const m of body.matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)/gi)) alias[m[2]] = m[1];
  for (const m of body.matchAll(/\bAS\s+(\w+)/gi)) fields.add(m[1]);
  for (const m of body.matchAll(/\b(\w+)\.\*/g)) for (const c of COLS[alias[m[1]] ?? m[1]] ?? []) fields.add(c);
  for (const m of body.matchAll(/SELECT\s+\*\s+FROM\s+(\w+)/gi)) for (const c of COLS[m[1]] ?? []) fields.add(c);
  for (const m of body.matchAll(/RETURNING\s+\*/gi)) void m;
  for (const m of body.matchAll(/\b[a-z]{1,10}\.([a-z_]+)\b/g)) fields.add(m[1]);
  for (const m of body.matchAll(/SELECT\s+([\w\s,]+?)\s+FROM/gi)) for (const c of m[1].split(',')) fields.add(c.trim());
  return fields;
}

/** Fields a page reads off response rows via `<var>.<field>` and dataIndex. */
function pageFields(file, vars, { dataIndex = true, from = null, to = null } = {}) {
  const src = read(file);
  const a = from ? src.indexOf(from) : 0;
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `markers ${from} / ${to} not found in ${rel(file)}`);
  const slice = src.slice(a, b);
  const out = new Map();
  for (const v of vars) {
    // (a name inside a string literal — e.g. the permission 'client.terms' — is not a field read)
    for (const m of slice.matchAll(new RegExp(`(?<![\\w.'"])${v}\\??\\.([a-z_][a-z0-9_]*)\\b(?!\\s*\\()`, 'g'))) {
      if (!out.has(m[1])) out.set(m[1], loc(file, src, a + m.index));
    }
  }
  if (dataIndex) {
    for (const m of slice.matchAll(/dataIndex:\s*'(\w+)'/g)) if (!out.has(m[1])) out.set(m[1], loc(file, src, a + m.index));
  }
  return out;
}

function assertFieldsExist(pageFieldsMap, available, ignore = []) {
  const missing = [...pageFieldsMap].filter(([f]) => !available.has(f) && !ignore.includes(f));
  assert.deepEqual(missing.map(([f, at]) => `${f} (${at})`), [], `page reads fields the API never returns`);
}

const P = (...p) => path.join(FSRC, 'pages', ...p);
// Legacy file names → their home in backend/src/modules (the old paths are re-export shims).
const MODULE_FILES = {
  'orders.service.js': 'orders/service.js', 'clients.service.js': 'clients/service.js',
  'quotations.service.js': 'quotations/service.js', 'tickets.service.js': 'tickets/service.js',
  'staff.service.js': 'staff/service.js', 'bot.templates.js': 'bot/templates.js',
  'conversations.service.js': 'conversations/service.js',
  'orders.controller.js': 'orders/controller.js', 'clients.controller.js': 'clients/controller.js',
  'tickets.controller.js': 'tickets/controller.js', 'quotations.controller.js': 'quotations/controller.js',
  'staff.controller.js': 'staff/controller.js', 'products.controller.js': 'catalog/products.controller.js',
  'purchaseOrders.controller.js': 'purchaseOrders/controller.js', 'conversations.controller.js': 'conversations/controller.js',
};
const moduleFile = (f) => path.join(BSRC, 'modules', MODULE_FILES[f] ?? assert.fail(`no module mapping for ${f}`));
const S = moduleFile;
const C = moduleFile;

// ════════════════════════════════════════════════════════════════════════════
// 1. Routes
// ════════════════════════════════════════════════════════════════════════════
const BR = backendRoutes();
const CALLS = frontendCalls();

describe('API routes: every frontend call reaches a mounted backend route', () => {
  test('sanity: parsed a non-trivial number of calls and routes', () => {
    assert.ok(CALLS.length >= 40, `only ${CALLS.length} frontend calls parsed`);
    assert.ok(BR.routes.length >= 50, `only ${BR.routes.length} backend routes parsed`);
    assert.ok(BR.mounts.length >= 10, `only ${BR.mounts.length} mounts parsed`);
  });

  for (const call of CALLS.filter((c) => c.kind === 'axios')) {
    const hit = matchRoute(call, BR.mounted);
    const unmounted = !hit && BR.routes.find((r) => r.method === call.method &&
      call.path.replace(/^\/api\/[\w-]+/, '').replace(/^$/, '/').split('/').length === (r.path === '/' ? 1 : r.path.split('/').length));
    test(`${hit ? '' : 'BUG: '}${call.method} ${call.path}  (${call.at})`, () => {
      assert.ok(hit, `No mounted backend route serves ${call.method} ${call.path} called at ${call.at}` +
        (unmounted ? ' — a matching router file exists but is not mounted in backend/src/app.js' : ''));
    });
  }

  test('every router in backend/src/routes is mounted in backend/src/app.js', () => {
    const mountedNames = new Set(BR.mounts.map((m) => m.router));
    const unmounted = BR.routers.filter((r) => !mountedNames.has(r.name)).map((r) => `${r.name} (${r.file})`);
    assert.deepEqual(unmounted, [], 'routers defined but never app.use()d — their endpoints 404');
  });

  test('plain links (<a href>/window.open, no Bearer header) only target public routes', () => {
    const bad = [];
    for (const call of CALLS.filter((c) => c.kind === 'link')) {
      const hit = matchRoute(call, BR.mounted);
      if (!hit) bad.push(`${call.path} (${call.at}) → no route`);
      else if (hit.requiresAuth) bad.push(`${call.path} (${call.at}) → ${hit.at} is behind requireAuth (Bearer header only) → 401 in the browser`);
    }
    assert.deepEqual(bad, []);
  });
});

describe('Schema: tables behind the UI features exist', () => {
  test('every table the backend services/controllers query is created by a migration script', () => {
    const missing = [];
    for (const f of backendSources()) {
      const src = read(f);
      for (const sql of src.matchAll(/`[^`]*`/g)) { // SQL lives in template literals
        // CTE names (WITH s AS (…), t AS (…)) are not tables.
        const ctes = new Set([...sql[0].matchAll(/(?:\bWITH|,)\s+([a-z_]+)\s+AS\s*\(/gi)].map((c) => c[1]));
        for (const m of sql[0].matchAll(/\b(?:FROM|JOIN|INSERT INTO|UPDATE)\s+([a-z_]+)\b/g)) {
          if (!COLS[m[1]] && !ctes.has(m[1]) && !missing.some((x) => x.startsWith(m[1] + ' '))) missing.push(`${m[1]} (${loc(f, src, sql.index + m.index)})`);
        }
      }
    }
    assert.deepEqual(missing, [], 'tables never created by migrate.js / ensureSchema.js / add*.js → those features 500 on a fresh DB');
  });
});

describe('App.jsx routing', () => {
  test('every page component under src/pages is reachable from a <Route> in App.jsx', () => {
    // A page file is reachable when App.jsx imports it, or a reachable page imports it
    // (the job page is split into panels: QuotePanel, OrderPanel …).
    const app = read(path.join(FSRC, 'App.jsx'));
    const pages = walk(path.join(FSRC, 'pages'), ['.jsx']).filter((f) => !/Modal\.jsx$/.test(f));
    const reachable = new Set(pages.filter((f) => app.includes(`'./${path.relative(FSRC, f).replace(/\\/g, '/')}'`)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reachable]) {
        for (const m of read(from).matchAll(/from '(\.{1,2}\/[^']+\.jsx)'/g)) {
          const to = path.resolve(path.dirname(from), m[1]);
          if (pages.includes(to) && !reachable.has(to)) { reachable.add(to); grew = true; }
        }
      }
    }
    const unrouted = pages.filter((f) => !reachable.has(f)).map(rel);
    assert.deepEqual(unrouted, [], 'page components with no route (unreachable; "*" redirects to /)');
  });

  test('App.jsx routes are all listed in the sidebar NAV or reachable from another page', () => {
    const app = read(path.join(FSRC, 'App.jsx'));
    const layout = read(path.join(FSRC, 'layouts', 'DashboardLayout.jsx'));
    // Old list URLs that only redirect (to a Jobs board view) need no sidebar item.
    const top = [...app.matchAll(/path="(\/[a-z-]*)" element={<(\w+)/g)]
      .filter((m) => m[1] !== '/login' && !/Redirect$/.test(m[2])).map((m) => m[1]);
    const missing = top.filter((p) => !layout.includes(`key: '${p}'`));
    assert.deepEqual(missing, []);
  });

  test('old quote / order URLs redirect to the job page', () => {
    const app = read(path.join(FSRC, 'App.jsx'));
    assert.match(app, /path="\/quotations\/:id\/build" element={<QuotationRedirect \/>}/);
    assert.match(app, /Navigate to={`\/jobs\/\$\{id\}/);
    assert.match(app, /path="\/orders\/:id" element={<OrderRedirect \/>}/);
    const redirect = read(P('Jobs', 'OrderRedirect.jsx'));
    assert.match(redirect, /jobForOrder\(id\)/);
    assert.match(redirect, /navigate\(`\/jobs\/\$\{data\.quotationId\}/);
    assert.ok(BR.mounted.some((r) => r.method === 'GET' && r.full === '/api/jobs/by-order/:orderId'), 'GET /api/jobs/by-order/:orderId is not mounted');
  });

  test('Quotations and Orders are Jobs board views: /quotations and /orders redirect to /jobs?view=…', () => {
    const app = read(path.join(FSRC, 'App.jsx'));
    assert.match(app, /path="\/quotations" element={<BoardViewRedirect view="quotes" \/>}/);
    assert.match(app, /path="\/orders" element={<BoardViewRedirect view="orders" \/>}/);
    const layout = read(path.join(FSRC, 'layouts', 'DashboardLayout.jsx'));
    assert.ok(!layout.includes("key: '/quotations'") && !layout.includes("key: '/orders'"), 'Quotations / Orders still in the sidebar');
    const board = read(P('Jobs', 'JobsBoard.jsx'));
    assert.match(board, /quotes: \{/);
    assert.match(board, /orders: \{/);
  });

  test('the Jobs board is the main "Sales & production" entry in the sidebar', () => {
    const layout = read(path.join(FSRC, 'layouts', 'DashboardLayout.jsx'));
    const group = layout.slice(layout.indexOf("label: 'Sales & production'"));
    assert.match(group.slice(0, 200), /key: '\/jobs'/, 'Jobs is not the first item of Sales & production');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Request field names
// ════════════════════════════════════════════════════════════════════════════
const subset = (sent, schema, where) => {
  const extra = sent.filter((s) => !schema.keys.includes(s.name ?? s)).map((s) => s.name ? `${s.name} (${s.at})` : s);
  assert.deepEqual(extra, [], `fields not accepted by ${schema.line} (zod strips unknown keys → silently ignored) [${where}]`);
};

const JOB_ACTIONS = path.join(FSRC, 'pages', 'Jobs', 'useJobActions.js');
/** Keys of the object literal passed as the `argIndex`-th argument of every `fn(` call in a file. */
function callPayloadKeys(file, fn, argIndex = 1) {
  const src = read(file);
  const out = [];
  for (const m of src.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
    const args = balanced(src, m.index + fn.length, '(', ')');
    if (args == null) continue;
    // split top-level args
    const parts = []; let depth = 0, cur = '';
    for (const ch of args) {
      if ('{[('.includes(ch)) depth++;
      else if ('}])'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    let arg = (parts[argIndex] ?? '').trim();
    arg = arg.replace(/^clean\(/, '').replace(/\)$/, '').trim();
    if (!arg.startsWith('{')) continue;
    out.push(...topLevelKeys(arg.slice(1, -1)).map((k) => ({ name: k, at: loc(file, src, m.index) })));
  }
  return out;
}

describe('Request fields: pages vs backend validators', () => {
  test('jobs: New job (board) creates an order from an accepted quote → ConvertSchema', () => {
    subset(callPayloadKeys(path.join(FSRC, 'components', 'NewJobModal.jsx'), 'convertFromQuotation'), zodSchema(C('orders.controller.js'), 'ConvertSchema'), 'NewJobModal');
  });

  test('jobs: advance (start production / mark ready / collected + override) → AdvanceStageSchema', () => {
    const sent = callPayloadKeys(JOB_ACTIONS, 'advanceStage');
    assert.ok(sent.some((k) => k.name === 'override'), 'the job page never sends override: { reason }');
    subset(sent, zodSchema(C('orders.controller.js'), 'AdvanceStageSchema'), 'useJobActions advance');
  });

  test('jobs: every advance says which stage it means to reach (expect ∈ ORDER_STAGES) — DAT-1', () => {
    const sent = callPayloadKeys(JOB_ACTIONS, 'advanceStage');
    assert.ok(sent.some((k) => k.name === 'expect'), 'the job page never sends expect on POST /orders/:id/advance');
    const schema = zodSchema(C('orders.controller.js'), 'AdvanceStageSchema');
    assert.ok(schema.keys.includes('expect'), `${schema.line} has no expect`);
    const stages = [...read(path.join(BSRC, 'modules', 'lifecycle', 'machines.js')).match(/ORDER_STAGES = \[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const src = read(JOB_ACTIONS);
    const map = Object.fromEntries([...balanced(src, src.indexOf('ADVANCE_EXPECT = {')).matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(map, { start_production: 'in_production', mark_ready: 'ready', mark_collected: 'completed' });
    assert.deepEqual(Object.values(map).filter((s) => !stages.includes(s)), [], 'expect values the backend does not know');
    // The dashboard's one-click row steps send it too.
    const dash = read(P('Dashboard.jsx'));
    assert.match(dash, /ADVANCE_EXPECT\[job\.primary_action\.key\]/);
    assert.match(dash, /runActionEndpoint\(job\.primary_action\.endpoint, expect \? \{ expect \} : \{\}\)/);
  });

  test('jobs: manager override is only offered for advance steps (the only endpoint that takes override) — FE-2', () => {
    const card = read(path.join(FSRC, 'components', 'NextStepCard.jsx'));
    const list = [...card.match(/OVERRIDABLE_ACTIONS = \[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(list, ['mark_collected', 'mark_ready', 'start_production']);
    assert.match(card, /const mayOverride = advance && err\.overridable/);
    // …and only advanceStage() carries override in the job actions.
    for (const fn of ['recordPayment', 'updateProofStatus', 'sendProof', 'convertFromQuotation']) {
      assert.ok(!callPayloadKeys(JOB_ACTIONS, fn).some((k) => k.name === 'override'), `${fn} sends override`);
    }
  });

  test('jobs: every payment submission carries an idempotency key (same key on retry, new key per submission) — FIN-1', () => {
    const schema = zodSchema(C('orders.controller.js'), 'RecordPaymentSchema');
    assert.ok(schema.keys.includes('idempotencyKey'), `${schema.line} has no idempotencyKey`);
    assert.ok(callPayloadKeys(JOB_ACTIONS, 'recordPayment').some((k) => k.name === 'idempotencyKey'), 'recordPayment is sent without idempotencyKey');
    const src = read(JOB_ACTIONS);
    // Kept per order + action while a submission failed, dropped after success / a mismatch.
    assert.match(src, /payKeys\.current\[slot\] \?\?= newIdempotencyKey\(\)/);
    assert.match(src, /if \(slot\) delete payKeys\.current\[slot\]/);
    assert.match(src, /IDEMPOTENCY_MISMATCH/);
    assert.match(src, /result\?\.replayed/, 'a replayed (already recorded) payment is not reported as such');
    // "Record other payment": a fresh key each time the dialog opens, reused on retry.
    const panel = read(P('Jobs', 'OrderPanel.jsx'));
    assert.match(panel, /const openPayment = \(\) => \{[^}]*setPayKey\(newIdempotencyKey\(\)\)/);
    assert.match(panel, /run\(payAction, values, \{ idempotencyKey: payKey \}\)/);
    // The key matches the server's rule (8–100 of [A-Za-z0-9_-]) with or without crypto.randomUUID.
    const helper = read(path.join(FSRC, 'lib', 'idempotency.js'));
    assert.match(helper, /randomUUID/);
    assert.match(helper, /getRandomValues/);
  });

  test('jobs: record deposit / balance → RecordPaymentSchema (job actions + OrderPanel payment form)', () => {
    const schema = zodSchema(C('orders.controller.js'), 'RecordPaymentSchema');
    subset(callPayloadKeys(JOB_ACTIONS, 'recordPayment'), schema, 'useJobActions payment');
    // OrderPanel "Record other payment" runs the same job action (record_payment) with these inputs.
    const panel = read(P('Jobs', 'OrderPanel.jsx'));
    const inputs = balanced(panel, panel.indexOf('function paymentAction'));
    const names = [...inputs.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 2, 'OrderPanel payment inputs not found');
    subset(names, schema, 'OrderPanel payment form');
  });

  test('jobs: hold payload → HoldSchema', () => {
    const schema = zodSchema(C('orders.controller.js'), 'HoldSchema');
    subset(callPayloadKeys(JOB_ACTIONS, 'setHold'), schema, 'release hold');
    const src = read(P('Jobs', 'OrderPanel.jsx'));
    const body = balanced(src, src.indexOf('hold.mutateAsync('));
    subset(topLevelKeys(body).filter((k) => k), schema, 'OrderPanel hold');
  });

  test('jobs: proof send / approve / changes → ProofSchema, ProofStatusSchema', () => {
    subset(callPayloadKeys(JOB_ACTIONS, 'sendProof'), zodSchema(C('orders.controller.js'), 'ProofSchema'), 'send proof');
    subset(callPayloadKeys(JOB_ACTIONS, 'updateProofStatus'), zodSchema(C('orders.controller.js'), 'ProofStatusSchema'), 'proof status');
  });

  test('jobs: create order from the job → ConvertSchema; PO from the job → CreatePurchaseOrderSchema', () => {
    subset(callPayloadKeys(JOB_ACTIONS, 'convertFromQuotation'), zodSchema(C('orders.controller.js'), 'ConvertSchema'), 'create order');
    subset(callPayloadKeys(JOB_ACTIONS, 'createPurchaseOrder', 0), zodSchema(C('purchaseOrders.controller.js'), 'CreatePurchaseOrderSchema'), 'record PO');
  });

  test('jobs: open / resolve ticket → CreateTicketSchema, UpdateTicketSchema', () => {
    subset(callPayloadKeys(JOB_ACTIONS, 'createTicket', 0), zodSchema(C('tickets.controller.js'), 'CreateTicketSchema'), 'open ticket');
    subset(callPayloadKeys(JOB_ACTIONS, 'updateTicket'), zodSchema(C('tickets.controller.js'), 'UpdateTicketSchema'), 'resolve ticket');
  });

  test('jobs: every next action the backend can offer is handled by the job page', () => {
    const be = read(path.join(BSRC, 'modules', 'lifecycle', 'nextActions.js'));
    const keys = Object.keys(Object.fromEntries([...balanced(be, be.indexOf('ACTION_LABELS = {')).matchAll(/(\w+):\s*'/g)].map((m) => [m[1], 1])));
    assert.ok(keys.length >= 15, `only ${keys.length} action keys parsed`);
    const fe = read(JOB_ACTIONS);
    const handled = new Set([...fe.matchAll(/case '(\w+)':/g)].map((m) => m[1]));
    assert.deepEqual(keys.filter((k) => !handled.has(k)), [], 'nextActions keys with no API call in useJobActions.performAction');
  });

  test('jobs: every action input the backend asks for is read by the job page', () => {
    const be = read(path.join(BSRC, 'modules', 'lifecycle', 'nextActions.js'));
    const names = [...new Set([...be.matchAll(/name: '(\w+)'/g)].map((m) => m[1]))].filter((n) => n !== 'lineItems' && n !== 'type');
    const fe = read(JOB_ACTIONS);
    assert.deepEqual(names.filter((n) => !new RegExp(`\\bv\\.${n}\\b`).test(fe)), [], 'inputs collected by NextStepCard but never sent');
  });

  test('quotations: start a quote → CreateQuotationSchema; status changes ⊆ StatusSchema', () => {
    const schema = zodSchema(C('quotations.controller.js'), 'CreateQuotationSchema');
    subset(callPayloadKeys(path.join(FSRC, 'components', 'ClientPanel.jsx'), 'createQuotation', 0), schema, 'ClientPanel start quote');
    const allowed = [...zodSchema(C('quotations.controller.js'), 'StatusSchema').defs.status.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const sent = [...read(JOB_ACTIONS).matchAll(/updateQuotationStatus\(q\.id, '(\w+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(sent.sort(), ['accepted', 'draft', 'rejected']);
    assert.deepEqual(sent.filter((s) => !allowed.includes(s)), []);
  });

  test('clients: ClientDetail edit form → UpdateClientSchema (camelCase keys)', () => {
    subset(formNames(P('Clients', 'ClientDetail.jsx')), zodSchema(C('clients.controller.js'), 'UpdateClientSchema'), 'ClientDetail edit');
  });

  test('clients: ClientDetail edit pre-fills DB values (possibly NULL) → schema must accept null', () => {
    // form.setFieldsValue({ organisation: client.organisation, ... }) then mutate(form.getFieldsValue())
    // sends `null` for every empty column; z.string().optional() rejects null → 400.
    const schema = zodSchema(C('clients.controller.js'), 'UpdateClientSchema');
    const sent = formNames(P('Clients', 'ClientDetail.jsx')).map((f) => f.name).filter((n) => schema.keys.includes(n));
    // A field tolerates null if its definition (or the local helper it calls, e.g. optText(200))
    // is .nullable()/.nullish(), or a z.preprocess that maps null away.
    const src = read(C('clients.controller.js'));
    const tolerant = (def) => {
      if (/\.nullable\(\)|\.nullish\(\)|v === null/.test(def)) return true;
      const helper = def.match(/^(\w+)\(/)?.[1];
      if (!helper || helper === 'z') return false;
      const at = src.indexOf(`const ${helper} =`);
      return at >= 0 && /\.nullable\(\)|\.nullish\(\)/.test(src.slice(at, src.indexOf(';', at)));
    };
    const notNullable = sent.filter((n) => !tolerant(schema.defs[n]));
    assert.deepEqual(notNullable, [], `${schema.line}: these fields reject null but the edit form sends null for empty columns`);
  });

  test('tickets: TicketDetail update payloads → UpdateTicketSchema (incl. clearing the assignee)', () => {
    const src = read(P('Tickets', 'TicketDetail.jsx'));
    const keys = [...src.matchAll(/(?:update|updateMutation\.mutateAsync)\(\{\s*(\w+):/g)].map((m) => m[1]);
    assert.ok(keys.length >= 3, `parsed ${keys}`);
    subset([...new Set([...keys, 'resolutionNote'])], zodSchema(C('tickets.controller.js'), 'UpdateTicketSchema'), 'TicketDetail');
    assert.match(src, /assignedStaffId: v \?\? null/, 'clearing the assignee must send null');
    assert.match(zodSchema(C('tickets.controller.js'), 'UpdateTicketSchema').defs.assignedStaffId, /\.nullable\(\)/);
  });

  test('tickets: TicketDetail status options ⊆ UpdateTicketSchema.status enum', () => {
    const schema = zodSchema(C('tickets.controller.js'), 'UpdateTicketSchema');
    const allowed = [...schema.defs.status.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const opts = [...read(P('Tickets', 'TicketDetail.jsx')).matchAll(/value:\s*'(\w+)',\s*label/g)].map((m) => m[1]);
    assert.ok(opts.length === 4);
    assert.deepEqual(opts.filter((o) => !allowed.includes(o)), []);
  });

  test('quotations: QuotePanel line items carry every required LineItemSchema field', () => {
    const schema = zodSchema(C('quotations.controller.js'), 'LineItemSchema');
    const required = schema.keys.filter((k) => !/\.optional\(\)|\.default\(|\.nullish\(\)/.test(schema.defs[k]));
    const src = read(P('Jobs', 'QuotePanel.jsx'));
    const fnKeys = (name) => {
      const i = src.indexOf(`function ${name}(`);
      return topLevelKeys(balanced(src, src.indexOf('return {', i)));
    };
    const produced = new Set([...fnKeys('normalizeItem'), ...fnKeys('deriveItem')]);
    assert.deepEqual(required.filter((k) => !produced.has(k)), []);
  });

  test('quotations: approve sends { lineItems } (ApproveSchema)', () => {
    const api = read(path.join(FSRC, 'api', 'quotations.js'));
    assert.match(api, /approve`, \{ lineItems \}/);
    assert.deepEqual(zodSchema(C('quotations.controller.js'), 'ApproveSchema').keys, ['lineItems']);
  });

  test('staff: StaffList create form → CreateStaffSchema; roles ⊆ enum', () => {
    const schema = zodSchema(C('staff.controller.js'), 'CreateStaffSchema');
    subset(formNames(P('Staff', 'StaffList.jsx')), schema, 'StaffList');
    const roles = [...read(P('Staff', 'StaffList.jsx')).match(/ROLES = \[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const allowed = [...schema.defs.role.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(roles.filter((r) => !allowed.includes(r)), []);
  });

  test('staff: StaffList password rule (min 8) matches CreateStaffSchema', () => {
    assert.match(read(P('Staff', 'StaffList.jsx')), /min: 8/);
    assert.match(zodSchema(C('staff.controller.js'), 'CreateStaffSchema').defs.password, /min\(8\)/);
  });

  test('staff: remove access / restore access → DELETE (deactivates) and PATCH { isActive } ⊆ UpdateStaffSchema — AUTH-2', () => {
    const schema = zodSchema(C('staff.controller.js'), 'UpdateStaffSchema');
    const page = read(P('Staff', 'StaffList.jsx'));
    subset(callPayloadKeys(P('Staff', 'StaffList.jsx'), 'updateStaff'), schema, 'StaffList restore access');
    assert.match(page, /updateStaff\(id, \{ isActive: true \}\)/);
    assert.ok(BR.mounted.some((r) => r.method === 'PATCH' && r.full === '/api/staff/:id'), 'PATCH /api/staff/:id is not mounted');
    // Wording: access is removed, not the account; own row and inactive rows offer no remove button.
    assert.match(page, /They can no longer sign in\. Their name stays on past work\./);
    assert.match(page, /r\.id === me\?\.id\) return null/);
    assert.match(page, /r\.is_active === false/);
    assert.match(read(S('staff.service.js')), /SELECT id, name, email, role, is_active, created_at FROM staff/);
  });

  test('broadcasts: custom always sends an audience; delay sends no reason (the server ignores it) — FE-5', () => {
    const page = read(P('Broadcasts.jsx'));
    assert.match(page, /name="audience"[^>]*rules=\{\[\{ required: true/);
    assert.match(page, /onFinish=\{\(\) => delayMut\.mutate\(\{\}\)\}/);
    assert.doesNotMatch(page, /name="reason"/);
    const opts = [...page.match(/AUDIENCE_OPTIONS = \[([\s\S]*?)\]/)[1].matchAll(/value: '(\w+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(opts, ['active_orders', 'all_clients', 'corporate', 'retail']);
  });

  test('quotations: the quote builder lists active products only (?activeOnly=true) — FE-15', () => {
    const src = read(P('Jobs', 'QuotePanel.jsx'));
    assert.match(src, /listProducts\(\{ activeOnly: true \}\)/);
    assert.match(read(C('products.controller.js')), /activeOnly/);
  });

  test('login: Login form password rule matches LoginSchema (min 6) so a 400 can never reach the UI', () => {
    const be = zodSchema(C('staff.controller.js'), 'LoginSchema').defs.password;
    const min = Number(be.match(/min\((\d+)\)/)?.[1] ?? 0);
    const fe = read(P('Login.jsx'));
    const pwItem = fe.slice(fe.indexOf('name="password"'), fe.indexOf('</Form.Item>', fe.indexOf('name="password"')));
    assert.ok(new RegExp(`min:\\s*${min}`).test(pwItem), `backend requires password.min(${min}); Login.jsx only checks "required" → short passwords get a 400 whose error is an object`);
  });

  test('products: ProductsList form → CreateProductSchema', () => {
    subset(formNames(P('Products', 'ProductsList.jsx')), zodSchema(C('products.controller.js'), 'CreateProductSchema'), 'ProductModal');
  });

  test('products: edit modal maps snake_case row → camelCase form fields (schoolName, isActive)', () => {
    const src = read(P('Products', 'ProductsList.jsx'));
    const setBlock = balanced(src, src.indexOf('form.setFieldsValue('));
    const names = formNames(P('Products', 'ProductsList.jsx')).map((f) => f.name);
    const camel = names.filter((n) => /[A-Z]/.test(n));
    const unmapped = camel.filter((n) => !new RegExp(`\\b${n}\\s*:`).test(setBlock));
    assert.deepEqual(unmapped, [], `setFieldsValue({...initial}) spreads snake_case columns (school_name, is_active) — these camelCase fields are never pre-filled, so editing re-activates inactive products / blanks schoolName`);
  });

  test('400 validation responses carry a string `error` (UI renders err.response.data.error as text)', () => {
    // Controllers reply `{ error: parsed.error.flatten() }` (an object). Pages do
    // message.error(err.response?.data?.error ?? '...') / <Alert message={error}>,
    // which throws "Objects are not valid as a React child".
    const offenders = [];
    for (const f of backendSources()) {
      const src = read(f);
      for (const m of src.matchAll(/json\(\{\s*error:\s*parsed\.error\.flatten\(\)/g)) offenders.push(loc(f, src, m.index));
    }
    const renders = [];
    for (const f of walk(FSRC, ['.jsx', '.js'])) {
      const src = read(f);
      // Raw renders, or via the errorMessage() / actionError() helpers (which stringify object-valued errors defensively).
      for (const m of src.matchAll(/response\?\.data\?\.error \?\?|\berrorMessage\(err|\bactionError\(err/g)) renders.push(loc(f, src, m.index));
    }
    assert.ok(renders.length > 0);
    assert.deepEqual(offenders, [], `object-valued error responses consumed by ${renders.length} UI call sites, e.g. ${renders.slice(0, 3).join(', ')}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Response fields
// ════════════════════════════════════════════════════════════════════════════
const JOBS_SVC = path.join(BSRC, 'modules', 'jobs', 'service.js');
/** Keys of listJobs() rows ({ items: rows.map((r) => ({ … })) }). */
function jobListFields() {
  const src = read(JOBS_SVC);
  const i = src.indexOf('const items = rows.map((r) =>');
  assert.ok(i >= 0, 'listJobs items mapping not found');
  return new Set(topLevelKeys(balanced(src, src.indexOf('return {', i))));
}

describe('Response fields: what pages render vs what services return', () => {
  test('response envelopes: list APIs unwrap { items } (legacy key fallback) that the controllers send', () => {
    // Frontend: api/<x>.js → paged(r.data, '<legacyKey>') (reads items, falls back to the legacy key).
    // Backend: core/http.js paged(res, '<legacyKey>', …) sends { items, total, page, limit, <legacyKey> }.
    const pairs = [
      ['orders.js', 'orders', [C('orders.controller.js')]],
      ['clients.js', 'clients', [C('clients.controller.js')]],
      ['quotations.js', 'quotations', [C('quotations.controller.js')]],
      ['tickets.js', 'tickets', [C('tickets.controller.js')]],
      ['purchaseOrders.js', 'purchaseOrders', [C('purchaseOrders.controller.js')]],
    ];
    const bad = [];
    for (const [fe, key, be] of pairs) {
      if (!read(path.join(FSRC, 'api', fe)).includes(`paged(r.data, '${key}')`)) bad.push(`api/${fe} does not unwrap via paged(r.data, '${key}')`);
      if (!be.some((f) => read(f).includes(`paged(res, '${key}'`))) bad.push(`${be.map(rel).join(' | ')} does not send paged(res, '${key}', …)`);
    }
    // Conversations may still send { conversations } (legacy) — the adapter reads either.
    if (!read(path.join(FSRC, 'api', 'conversations.js')).includes("paged(r.data, 'conversations')")) bad.push('api/conversations.js does not unwrap via paged()');
    const adapt = read(path.join(FSRC, 'api', 'adapt.js'));
    assert.match(adapt, /Array\.isArray\(data\?\.items\)/);
    assert.match(adapt, /data\?\.\[legacyKey\]/);
    // Pages read rows from .items (the adapter's shape), never the legacy keys.
    for (const [page, needle] of [
      [P('Clients', 'ClientsList.jsx'), 'data?.items'], [P('Tickets', 'TicketsList.jsx'), 'data?.items'],
      [P('PurchaseOrders', 'PurchaseOrdersList.jsx'), 'data?.items'], [P('Inbox', 'InboxList.jsx'), 'data?.items'],
      [P('Jobs', 'JobsBoard.jsx'), 'data?.items'], [P('Dashboard.jsx'), 'jobsData?.items'],
    ]) if (!read(page).includes(needle)) bad.push(`${rel(page)} does not read ${needle}`);
    const objects = [
      [P('Tickets', 'TicketDetail.jsx'), '{ ticket } = data', C('tickets.controller.js'), 'res.json({ ticket })'],
      [P('Staff', 'StaffList.jsx'), 'data?.staff', C('staff.controller.js'), 'res.json({ staff })'],
      [P('Products', 'ProductsList.jsx'), 'data?.products', C('products.controller.js'), 'res.json({ products })'],
      [P('Clients', 'ClientDetail.jsx'), '{ client, summary } = data', S('clients.service.js'), 'return { client: rows[0], orders, quotations, summary }'],
      [P('Dashboard.jsx'), 'kpiData?.attention', S('orders.service.js'), 'return { kpis, attention }'],
      [path.join(FSRC, 'api', 'jobs.js'), 'd.lifecycle', JOBS_SVC, 'return { quotation, order, payments, sizes, purchaseOrders, tickets, conversation, client: clientRows[0] || null, history, lifecycle }'],
      [path.join(FSRC, 'api', 'jobs.js'), "paged(r.data, 'jobs')", JOBS_SVC, 'return { items, total, page, limit, counts, queueCounts, flagCounts }'],
      [path.join(FSRC, 'api', 'jobs.js'), 'r.data?.quotationId', JOBS_SVC, 'return { orderId: rows[0].id, quotationId: rows[0].quotation_id }'],
    ];
    for (const [pf, ps, bf, bs] of objects) {
      if (!read(pf).includes(ps) || !read(bf).includes(bs)) bad.push(`${rel(pf)} '${ps}' vs ${rel(bf)} '${bs}'`);
    }
    assert.deepEqual(bad, []);
  });

  test('meta: GET /api/meta serves everything useMeta() falls back on', () => {
    const fe = read(path.join(FSRC, 'lib', 'useMeta.js'));
    const fb = topLevelKeys(balanced(fe, fe.indexOf('FALLBACK_META = Object.freeze(') + 'FALLBACK_META = Object.freeze('.length));
    const be = read(path.join(BSRC, 'modules', 'meta', 'routes.js'));
    const served = new Set([...topLevelKeys(balanced(be, be.indexOf('return {', be.indexOf('export function metaPayload')))), 'role', 'permissions']);
    assert.deepEqual(fb.filter((k) => !served.has(k)), [], 'useMeta fallback keys GET /api/meta never sends');
  });

  test('meta: frontend permission fallback mirrors backend core/rbac.js', () => {
    const fe = read(path.join(FSRC, 'lib', 'useCan.js'));
    const be = read(path.join(BSRC, 'core', 'rbac.js'));
    const map = (src, start) => Object.fromEntries([...balanced(src, src.indexOf(start)).matchAll(/'([\w.]+)':\s*\[([^\]]*)\]/g)]
      .map((m) => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort()]));
    assert.deepEqual(map(fe, 'ROLE_FALLBACK = {'), map(be, 'PERMISSIONS = Object.freeze({'));
    // Every permission the UI checks exists.
    const used = new Set();
    for (const f of walk(FSRC, ['.js', '.jsx'])) for (const m of read(f).matchAll(/\bcan\('([\w.]+)'\)|useCan\(\)\('([\w.]+)'\)|perm: '([\w.]+)'/g)) used.add(m[1] ?? m[2] ?? m[3]);
    assert.deepEqual([...used].filter((p) => !map(be, 'PERMISSIONS = Object.freeze({')[p]), []);
  });

  test('jobs: board / dashboard / client panel render only fields listJobs returns', () => {
    const fields = jobListFields();
    assertFieldsExist(pageFields(P('Jobs', 'JobsBoard.jsx'), ['r', 'row']), fields);
    assertFieldsExist(pageFields(P('Dashboard.jsx'), ['job', 'j'], { dataIndex: false }), fields);
    assertFieldsExist(pageFields(path.join(FSRC, 'components', 'ClientPanel.jsx'), ['j', 'o'], { dataIndex: false }), fields);
    assertFieldsExist(pageFields(P('Clients', 'ClientDetail.jsx'), ['r'], { from: 'jobColumns', to: 'ticketColumns', dataIndex: false }), fields);
  });

  test('jobs: the job page reads only keys GET /api/jobs/:id returns', () => {
    const src = read(path.join(FSRC, 'api', 'jobs.js'));
    const keys = topLevelKeys(balanced(src, src.indexOf('return {', src.indexOf('export const getJob'))));
    const be = read(JOBS_SVC).match(/return \{ (quotation, order, payments[^}]+) \};/)[1].split(',').map((s) => s.trim().split(':')[0]);
    assert.deepEqual(keys.filter((k) => !be.includes(k)), []);
    const used = new Set();
    for (const f of walk(P('Jobs'), ['.jsx', '.js'])) for (const m of read(f).matchAll(/\bjob\??\.(\w+)/g)) used.add(m[1]);
    assert.deepEqual([...used].filter((k) => !keys.includes(k)), [], 'job.<key> the page reads that getJob() never returns');
  });

  test('jobs: quote / order panels render only fields the job endpoint returns', () => {
    const q = resultFields(S('quotations.service.js'), 'getQuotationById');
    assertFieldsExist(pageFields(P('Jobs', 'JobPage.jsx'), ['q'], { dataIndex: false }), q);
    assertFieldsExist(pageFields(P('Jobs', 'QuotePanel.jsx'), ['quotation'], { dataIndex: false }), q);
    const order = new Set([...COLS.orders, 'staff_name']);
    assertFieldsExist(pageFields(P('Jobs', 'OrderPanel.jsx'), ['order'], { dataIndex: false }), order);
    assertFieldsExist(pageFields(P('Jobs', 'OrderPanel.jsx'), ['p'], { from: 'payments.map', to: '</Section>', dataIndex: false }), COLS.payments);
    assertFieldsExist(pageFields(P('Jobs', 'OrderPanel.jsx'), [], { from: 'Size roster', to: 'Materials' }), COLS.order_size_entries);
    assertFieldsExist(pageFields(P('Jobs', 'TicketsPanel.jsx'), ['t'], { dataIndex: false }), new Set([...COLS.tickets, 'assigned_name']));
  });

  test('clients: ClientsList renders only fields listClients returns', () => {
    assertFieldsExist(pageFields(P('Clients', 'ClientsList.jsx'), ['r']), resultFields(S('clients.service.js'), 'listClients'));
  });

  test('clients: ClientDetail renders only client fields getClientById returns', () => {
    assertFieldsExist(pageFields(P('Clients', 'ClientDetail.jsx'), ['client'], { dataIndex: false }), resultFields(S('clients.service.js'), 'getClientById'));
  });

  test('clients: ClientDetail ticket tab renders fields listTickets returns', () => {
    assertFieldsExist(pageFields(P('Clients', 'ClientDetail.jsx'), ['t'], { from: 'ticketColumns', to: 'tabItems' }), resultFields(S('tickets.service.js'), 'listTickets'));
  });

  test('dashboard: production floor renders only fields listOrders returns', () => {
    assertFieldsExist(pageFields(P('Dashboard.jsx'), ['o'], { from: 'Production floor', dataIndex: false }), resultFields(S('orders.service.js'), 'listOrders'));
  });

  test('orders: shared stage list (lib/stages.js) matches backend STAGE_ORDER', () => {
    const src = read(path.join(FRONT, 'src', 'lib', 'stages.js'));
    const fe = [...src.slice(src.indexOf('export const STAGES'), src.indexOf(']', src.indexOf('export const STAGES'))).matchAll(/key: '(\w+)'/g)].map((m) => `'${m[1]}'`).join(', ');
    const be = read(path.join(BSRC, 'modules', 'lifecycle', 'machines.js')).match(/ORDER_STAGES = \[([^\]]+)\]/)[1];
    const list = (s) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(list(fe), list(be));
  });

  test('tickets: TicketsList renders only fields listTickets returns', () => {
    assertFieldsExist(pageFields(P('Tickets', 'TicketsList.jsx'), ['row']), resultFields(S('tickets.service.js'), 'listTickets'));
  });

  test('tickets: TicketDetail renders only fields getTicketById returns', () => {
    assertFieldsExist(pageFields(P('Tickets', 'TicketDetail.jsx'), ['ticket'], { dataIndex: false }), resultFields(S('tickets.service.js'), 'getTicketById'));
  });

  test('staff: StaffList renders only fields listAll returns', () => {
    assertFieldsExist(pageFields(P('Staff', 'StaffList.jsx'), [], {}), resultFields(S('staff.service.js'), 'listAll'));
  });

  test('dashboard: KPI + tickets-waiting fields exist in getDashboardKpis', () => {
    const svc = resultFields(S('orders.service.js'), 'getDashboardKpis');
    assertFieldsExist(pageFields(P('Dashboard.jsx'), ['kpis', 'item'], { dataIndex: false }), svc);
  });

  test('inbox: InboxList / ConversationChat render fields the conversations service returns', () => {
    // The inbox SQL lives in modules/conversations/service.js.
    const list = resultFields(S('conversations.service.js'), 'listConversations');
    assertFieldsExist(pageFields(P('Inbox', 'InboxList.jsx'), ['conv', 'c']), list);
    const one = new Set([...resultFields(S('conversations.service.js'), 'getConversation'), ...COLS.conversations]);
    assertFieldsExist(pageFields(P('Inbox', 'ConversationChat.jsx'), ['conv', 'msg'], { dataIndex: false }), one);
  });

  test('inbox: bot / human states come from /api/meta (no hard-coded bot state list)', () => {
    const chat = read(P('Inbox', 'ConversationChat.jsx'));
    assert.doesNotMatch(chat, /BOT_STATES|STATE_LABELS/);
    assert.match(chat, /meta\.humanStates/);
    assert.match(read(P('Inbox', 'InboxList.jsx')), /assignedToMe: 'true'/, '"Mine" must filter to the signed-in staff member');
    assert.match(read(path.join(BSRC, 'modules', 'conversations', 'service.js')), /assignedToMe === 'true'/);
  });

  test('jobs board (incl. its Orders view) pages server-side (page + limit)', () => {
    const page = read(P('Jobs', 'JobsBoard.jsx'));
    const params = balanced(page, page.indexOf('const params = {'));
    assert.ok(/\blimit\b/.test(params) && /\bpage\b/.test(params), `JobsBoard sends ${params}`);
    assert.match(page, /listJobs\(params\)/);
  });

  test('clients: list pagination — listClients returns a total so the table can page past page 1', () => {
    const ctrl = read(C('clients.controller.js'));
    const fn = ctrl.slice(ctrl.indexOf('export async function list'), ctrl.indexOf('export async function getById'));
    const page = read(P('Clients', 'ClientsList.jsx'));
    const serverPaged = /pagination=\{\{\s*current: page/.test(page);
    const pageReadsTotal = /pagedTotal\(data,/.test(page) && read(path.join(FSRC, 'utils', 'pagination.js')).includes('data?.total');
    const apiTotal = /paged\(res, 'clients'/.test(fn) || /res\.json\(\{[^}]*\btotal\b/.test(fn);
    assert.ok(!serverPaged || (apiTotal && pageReadsTotal),
      'ClientsList pages server-side but the API or page provides no total → clients beyond the first page are unreachable');
  });

  test('money is formatted by lib/format.js only (one "R 12 345.67" formatter)', () => {
    const offenders = [];
    for (const f of walk(FSRC, ['.jsx', '.js'])) {
      if (f.endsWith(path.join('lib', 'format.js'))) continue;
      const src = read(f);
      for (const m of src.matchAll(/toFixed\(2\)/g)) offenders.push(loc(f, src, m.index));
    }
    assert.deepEqual(offenders, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Error wording (pure helper — imported, no network)
// ════════════════════════════════════════════════════════════════════════════
describe('Error wording: transport failures and 503 — FE-7', async () => {
  const { errorMessage, NO_RESPONSE_MUTATION, NO_RESPONSE_READ, SERVICE_UNAVAILABLE } = await import('../src/utils/errorMessage.js');
  const axiosErr = (extra) => Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, ...extra });

  test('a mutation with no response says it may have gone through (never the raw axios text)', () => {
    const msg = errorMessage(axiosErr({ code: 'ECONNABORTED', config: { method: 'post' }, request: {} }));
    assert.equal(msg, NO_RESPONSE_MUTATION);
    assert.doesNotMatch(msg, /30000ms/);
    assert.equal(errorMessage(axiosErr({ code: 'ERR_NETWORK', config: { method: 'patch' }, request: {} })), NO_RESPONSE_MUTATION);
  });

  test('a read with no response asks to check the connection', () => {
    assert.equal(errorMessage(axiosErr({ code: 'ECONNABORTED', config: { method: 'get' }, request: {} })), NO_RESPONSE_READ);
  });

  test('503 → "Service temporarily unavailable"; other server errors keep the server message', () => {
    assert.equal(errorMessage(axiosErr({ config: { method: 'get' }, response: { status: 503, data: { error: 'db down' } } })), SERVICE_UNAVAILABLE);
    assert.equal(errorMessage(axiosErr({ config: { method: 'post' }, response: { status: 409, data: { error: 'Already done' } } })), 'Already done');
    assert.equal(errorMessage(new Error('plain')), 'plain');
  });

  test('the axios interceptor signs out on 401 only (a 503 keeps the session)', () => {
    const client = read(path.join(FSRC, 'api', 'client.js'));
    assert.match(client, /err\.response\?\.status === 401 && !isLoginRequest/);
    assert.doesNotMatch(client, /status (?:>=|===) 5\d\d[^\n]*removeItem/);
  });
});
