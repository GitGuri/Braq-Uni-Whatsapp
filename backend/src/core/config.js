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
    ssl:      optional('DB_SSL', 'false') === 'true',
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
  },

  broadcast: {
    ratePerSec: Math.max(1, Number(optional('BROADCAST_RATE_PER_SEC', '20')) || 20),
  },
};
