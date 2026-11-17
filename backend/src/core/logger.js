import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import winston from 'winston';
import { config } from './config.js';

const { combine, timestamp, colorize, printf, json } = winston.format;

// ── Request context (request id / job id) ────────────────────────────────────
const context = new AsyncLocalStorage();

/** Run fn with { requestId, ... } attached to every log line it produces. */
export function runWithContext(ctx, fn) {
  return context.run({ ...(context.getStore() || {}), ...ctx }, fn);
}
export const currentContext = () => context.getStore() || {};

const REQUEST_ID_RE = /^[\w.:-]{1,100}$/;

/** Express middleware: honour an incoming X-Request-Id (if sane) or mint one; echo it back. */
export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  context.run({ requestId }, next);
}

// ── PII redaction ────────────────────────────────────────────────────────────
// Logs must not carry client phone numbers, emails, tokens or message bodies.
const JWT_RE   = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// WhatsApp numbers are stored as bare digits (e.g. 27821234567); only whole
// digit runs are masked so ids such as UUIDs are left intact.
const PHONE_RE = /(?<![\w-])\+?\d{9,15}(?![\w-])/g;
// Meta keys whose values are free text written by/for a client — never logged.
const BODY_KEYS = new Set(['body', 'text', 'caption', 'messageBody', 'description', 'password', 'password_hash', 'token', 'authorization']);

function maskPhone(m) {
  const digits = m.replace(/\D/g, '');
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 5)}${digits.slice(-3)}`;
}

export function redactString(s) {
  return s
    .replace(JWT_RE, '[jwt]')
    .replace(EMAIL_RE, (m) => `${m[0]}***@${m.split('@')[1]}`)
    .replace(PHONE_RE, maskPhone);
}

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || depth > 5) return value;
  if (value instanceof Error) return { message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (BODY_KEYS.has(k) && v != null && v !== '') out[k] = '[redacted]';
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

// winston keeps meta on the info object itself; redact everything except the
// internal symbol keys and the level/timestamp, then attach the request id.
const LEAVE = new Set(['level', 'timestamp']);
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (LEAVE.has(key)) continue;
    if (key === 'message') info.message = typeof info.message === 'string' ? redactString(info.message) : info.message;
    else if (BODY_KEYS.has(key) && info[key] != null && info[key] !== '') info[key] = '[redacted]';
    else info[key] = redact(info[key]);
  }
  const ctx = context.getStore();
  if (ctx?.requestId && info.requestId === undefined) info.requestId = ctx.requestId;
  if (ctx?.jobId && info.jobId === undefined) info.jobId = ctx.jobId;
  return info;
});

const devFormat = combine(
  redactFormat(),
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, ...meta }) => {
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${extras}`;
  })
);

const prodFormat = combine(redactFormat(), timestamp(), json());

export const logger = winston.createLogger({
  level: config.log.level,
  format: config.env === 'production' ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});
