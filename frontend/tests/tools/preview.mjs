/**
 * Long-running design preview: throwaway backend (demo data, fakes) + Vite dev server.
 * Writes { app, token, staff } to the path in PREVIEW_INFO (or ./preview.json) and runs until killed.
 * Never touches backend/.env or Supabase.
 *
 *   node tests/tools/preview.mjs
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startTestEnv, ADMIN } from '../../../backend/tests/helpers/env.js';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INFO = process.env.PREVIEW_INFO || path.join(FRONT, 'tests', 'tools', 'preview.json');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const env = await startTestEnv({ seedTestingData: true });
const port = Number(process.env.PREVIEW_PORT) || await freePort();
const vite = await createServer({
  configFile: path.join(FRONT, 'vite.config.js'),
  root: FRONT,
  logLevel: 'warn',
  clearScreen: false,
  cacheDir: path.join(os.tmpdir(), 'braq-preview-vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: env.baseUrl, changeOrigin: true } } },
});
await vite.listen();

const r = await fetch(`${env.baseUrl}/api/staff/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
});
const session = await r.json();
const info = { app: `http://127.0.0.1:${port}`, api: env.baseUrl, token: session.token, staff: session.staff, login: ADMIN };
fs.writeFileSync(INFO, JSON.stringify(info, null, 2));
console.log(`PREVIEW READY ${info.app}  (login ${ADMIN.email} / ${ADMIN.password})`);

const shutdown = async () => { await vite.close().catch(() => {}); await env.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
