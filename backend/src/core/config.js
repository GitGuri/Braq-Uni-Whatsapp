import dotenv from 'dotenv';
dotenv.config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback) {
  return process.env[key] || fallback;
}

const env = optional('NODE_ENV', 'development');

// Never run production with a guessable signing key
if (env === 'production' && !process.env.JWT_SECRET) {
  throw new Error('Missing required env var: JWT_SECRET (required in production)');
}

export const config = {
  env,
  port: parseInt(optional('PORT', '3000'), 10),
  apiBaseUrl: optional('API_BASE_URL', 'http://localhost:3000'),

  db: {
    url:      optional('DATABASE_URL', ''),
    // Direct (non-pooler) connection for the worker's LISTEN/NOTIFY and the
    // migration runner's session advisory lock. Falls back to url when unset.
    directUrl: optional('DATABASE_DIRECT_URL', ''),
    // fallback individual params (used only if DATABASE_URL is not set)
    host:     optional('DB_HOST', 'localhost'),
    port:     parseInt(optional('DB_PORT', '5432'), 10),
    name:     optional('DB_NAME', 'postgres'),
    user:     optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', ''),
    // TLS (core/db.js): verify | no-verify | disable. Default: verify in production, no-verify elsewhere.
    sslMode:  optional('DB_SSL_MODE', ''),
    // CA certificate for 'verify': a path to a PEM file, or the PEM itself.
    sslCa:    optional('DB_SSL_CA', ''),
    connectTimeoutMs:   Math.max(1000, parseInt(optional('DB_CONNECT_TIMEOUT_MS', '15000'), 10) || 15000),
    // Per-statement cap for the API / worker pool (migrations use their own client).
    statementTimeoutMs: Math.max(1000, parseInt(optional('DB_STATEMENT_TIMEOUT_MS', '120000'), 10) || 120000),
  },

  meta: {
    appId:           optional('META_APP_ID', ''),
    appSecret:       optional('META_APP_SECRET', ''),
    phoneNumberId:   optional('META_PHONE_NUMBER_ID', ''),
    token:           optional('META_WHATSAPP_TOKEN', ''),
    webhookVerify:   optional('META_WEBHOOK_VERIFY_TOKEN', 'braquni_verify'),
    apiVersion:      optional('META_API_VERSION', 'v20.0'),
  },

  jwt: {
    secret:    optional('JWT_SECRET', 'dev_secret_change_in_production'),
    expiresIn: optional('JWT_EXPIRES_IN', '8h'),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
  },

  resend: {
    apiKey:        optional('RESEND_API_KEY', ''),
    fromEmail:     optional('FROM_EMAIL', 'notifications@braquni.com'),
    // Set this to your own email to receive all notifications before braquni.com is verified on Resend
    overrideEmail: optional('NOTIFICATION_OVERRIDE_EMAIL', ''),
  },

  dashboardBaseUrl: optional('DASHBOARD_BASE_URL', 'http://localhost:5173'),

  // Comma-separated allowed dashboard origins in production (defaults to DASHBOARD_BASE_URL)
  corsOrigins: optional('CORS_ORIGINS', optional('DASHBOARD_BASE_URL', 'http://localhost:5173'))
    .split(',').map((o) => o.trim()).filter(Boolean),

  // Express 'trust proxy' setting, e.g. 1 when behind a single reverse proxy
  trustProxy: process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : false,

  log: {
    level: optional('LOG_LEVEL', 'info'),
  },

  worker: {
    // Run the job worker inside the API process (default). Set to 'false' when
    // running `npm run worker` as a separate process.
    inProcess:   optional('WORKER_IN_PROCESS', 'true') !== 'false',
    pollMs:      Math.max(10, parseInt(optional('WORKER_POLL_MS', '1000'), 10) || 1000),
    concurrency: Math.max(1, parseInt(optional('WORKER_CONCURRENCY', '4'), 10) || 4),
    // Retry n waits min(2^n × base, 1h) + jitter
    backoffBaseMs: Math.max(1, parseInt(optional('JOB_BACKOFF_BASE_MS', '5000'), 10) || 5000),
    // On SIGTERM, how long running jobs may take to finish (a bot turn can wait
    // on up to three 20 s AI calls). Keep below the platform's kill grace period.
    drainMs: Math.max(1000, parseInt(optional('WORKER_DRAIN_MS', '25000'), 10) || 25000),
  },

  broadcast: {
    ratePerSec: Math.max(1, Number(optional('BROADCAST_RATE_PER_SEC', '20')) || 20),
  },
};

// ── Production start-up check ─────────────────────────────────────────────────
// The API and the worker refuse to start in production with a missing, default
// or placeholder secret: an unset META_APP_SECRET would turn off webhook
// signature checks (forged client messages), a guessable JWT_SECRET lets anyone
// mint admin tokens. Scripts (migrate, seed) only need the database and do not
// run this check.

export const MIN_JWT_SECRET_LENGTH = 32;
const DEV_JWT_SECRET = 'dev_secret_change_in_production';
const DEFAULT_VERIFY_TOKEN = 'braquni_verify';
/** .env.example placeholders: "your_…", "re_your_…", "…your-project-ref…". */
const isPlaceholder = (v) => /(^|_)your[_-]|your-project-ref/i.test(String(v));

/**
 * Every problem with the production configuration (empty array → fine). Pure.
 * @param {Record<string, string|undefined>} env  process.env
 * @returns {string[]}
 */
export function productionConfigProblems(env) {
  const problems = [];
  const val = (k) => (env[k] ?? '').trim();
  const need = (k, why) => {
    if (!val(k)) problems.push(`${k} is required in production (${why})`);
    else if (isPlaceholder(val(k))) problems.push(`${k} still holds the .env.example placeholder`);
  };

  need('DATABASE_URL', 'the database');
  need('META_APP_SECRET', 'verifies the X-Hub-Signature-256 of every webhook — without it anyone can forge client messages');
  need('META_WHATSAPP_TOKEN', 'sends WhatsApp messages');
  need('META_PHONE_NUMBER_ID', 'sends WhatsApp messages');
  need('META_WEBHOOK_VERIFY_TOKEN', 'Meta webhook verification handshake');
  need('GEMINI_API_KEY', 'AI intent routing and quotation parsing');
  need('RESEND_API_KEY', 'staff email notifications and reminders');
  need('DASHBOARD_BASE_URL', 'links in staff emails and the CORS allow-list');

  const jwt = val('JWT_SECRET');
  if (!jwt) problems.push('JWT_SECRET is required in production (signs staff sessions)');
  else if (jwt === DEV_JWT_SECRET || isPlaceholder(jwt)) problems.push('JWT_SECRET is a published default/placeholder — generate a random secret');
  else if (jwt.length < MIN_JWT_SECRET_LENGTH) problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);

  if (val('META_WEBHOOK_VERIFY_TOKEN') === DEFAULT_VERIFY_TOKEN) {
    problems.push('META_WEBHOOK_VERIFY_TOKEN is the built-in default — choose a random value');
  }
  const sslMode = val('DB_SSL_MODE');
  if (sslMode && sslMode !== 'verify') {
    problems.push(`DB_SSL_MODE=${sslMode} turns off database certificate verification — use verify with DB_SSL_CA in production`);
  }
  if (val('WHATSAPP_WINDOW_CHECK') === 'off') {
    problems.push('WHATSAPP_WINDOW_CHECK=off is for tests only — it breaks the WhatsApp 24-hour rule');
  }
  return problems;
}

/** Throw (listing every problem) when running in production with an unsafe configuration. */
export function assertProductionConfig(env = process.env, mode = config.env) {
  if (mode !== 'production') return;
  const problems = productionConfigProblems(env);
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
