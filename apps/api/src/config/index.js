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

export const config = {
  env:  optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  apiBaseUrl: optional('API_BASE_URL', 'http://localhost:3000'),

  db: {
    url:      optional('DATABASE_URL', ''),
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

  log: {
    level: optional('LOG_LEVEL', 'info'),
  },
};
