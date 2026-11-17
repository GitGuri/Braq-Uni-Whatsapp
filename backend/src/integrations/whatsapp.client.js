// WhatsApp Cloud API client (Meta Graph). Thin HTTP wrapper — callers that need
// durability enqueue a 'whatsapp.send' job instead of calling this directly.
import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const BASE_URL = `https://graph.facebook.com/${config.meta.apiVersion}/${config.meta.phoneNumberId}`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${config.meta.token}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

/**
 * Wrap a Graph API failure: the message keeps the JSON error detail, and the
 * Meta error code is attached (err.metaCode) so callers can react to specific
 * errors — e.g. 131047, "more than 24 hours since the customer last replied".
 */
function sendError(prefix, err) {
  const detail = err.response?.data?.error || err.message;
  const e = new Error(`${prefix}: ${JSON.stringify(detail)}`);
  e.metaCode = typeof detail === 'object' && detail ? (detail.code ?? null) : null;
  e.httpStatus = err.response?.status ?? null;
  return e;
}

/** Meta error codes meaning "outside the 24-hour customer service window — use a template". */
export const REENGAGEMENT_CODES = new Set([131047]);
export const isReengagementError = (err) => REENGAGEMENT_CODES.has(Number(err?.metaCode));

// ── Send a plain text message ─────────────────────────────────────────────────
export async function sendTextMessage(to, body) {
  try {
    const res = await client.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    });
    logger.info('WhatsApp message sent', { to, messageId: res.data?.messages?.[0]?.id });
    return res.data?.messages?.[0]?.id || null;
  } catch (err) {
    logger.error('Failed to send WhatsApp message', { to, error: err.response?.data?.error || err.message });
    throw sendError('WhatsApp send failed', err);
  }
}

// ── Upload a buffer to Meta's media store, returns a reusable media_id ───────
export async function uploadMedia(buffer, filename, mimeType = 'application/pdf') {
  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', blob, filename);

  const res = await axios.post(
    `https://graph.facebook.com/${config.meta.apiVersion}/${config.meta.phoneNumberId}/media`,
    form,
    {
      headers: { Authorization: `Bearer ${config.meta.token}` },
      timeout: 30000,
    }
  );
  const mediaId = res.data?.id;
  logger.info('Media uploaded to WhatsApp', { mediaId, filename });
  return mediaId;
}

// ── Send an image — pass either url (public link) or mediaId (pre-uploaded) ──
export async function sendImage(to, { url, mediaId, caption }) {
  try {
    const imageField = mediaId
      ? { id: mediaId, ...(caption ? { caption } : {}) }
      : { link: url,   ...(caption ? { caption } : {}) };

    const res = await client.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: imageField,
    });
    logger.info('WhatsApp image sent', { to, messageId: res.data?.messages?.[0]?.id });
    return res.data?.messages?.[0]?.id || null;
  } catch (err) {
    logger.error('Failed to send image', { to, error: err.response?.data?.error || err.message });
    throw sendError('WhatsApp image send failed', err);
  }
}

// ── Send a document — pass either url (link) or mediaId (pre-uploaded) ───────
export async function sendDocument(to, { url, mediaId, filename, caption }) {
  try {
    const documentField = mediaId
      ? { id: mediaId, filename, caption }
      : { link: url, filename, caption };

    const res = await client.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: documentField,
    });
    logger.info('WhatsApp document sent', { to, messageId: res.data?.messages?.[0]?.id });
    return res.data?.messages?.[0]?.id || null;
  } catch (err) {
    logger.error('Failed to send document', { to, error: err.response?.data?.error || err.message });
    throw sendError('WhatsApp document send failed', err);
  }
}

// ── Message templates (business-initiated messages outside the 24-hour window) ─
/**
 * Logical template names → approved Meta templates, from the WHATSAPP_TEMPLATES
 * env var (JSON). Each value is a Meta template name, or { name, language }:
 *
 *   WHATSAPP_TEMPLATES={"order_stage":"braq_order_stage","quote_ready":{"name":"braq_quote_ready","language":"en"}}
 *
 * Read on every call so a deploy only needs the env var (no code change).
 * The templates to register are listed in README "WhatsApp message templates".
 */
export function templateConfig(logicalName, env = process.env.WHATSAPP_TEMPLATES) {
  if (!logicalName || !env) return null;
  let map;
  try { map = JSON.parse(env); } catch {
    logger.warn('WHATSAPP_TEMPLATES is not valid JSON — templates disabled');
    return null;
  }
  const entry = map && typeof map === 'object' ? map[logicalName] : null;
  if (!entry) return null;
  if (typeof entry === 'string') return { name: entry, language: 'en' };
  if (typeof entry === 'object' && typeof entry.name === 'string' && entry.name) {
    return { name: entry.name, language: typeof entry.language === 'string' && entry.language ? entry.language : 'en' };
  }
  return null;
}

/**
 * Whether the 24-hour customer-service window is enforced for business-initiated
 * messages (default: yes). WHATSAPP_WINDOW_CHECK=off turns it off — the test
 * harness does, so suites that don't exercise the window can message clients
 * who never wrote in.
 */
export const windowCheckEnabled = () => String(process.env.WHATSAPP_WINDOW_CHECK ?? '').toLowerCase() !== 'off';

/** Template parameters may not contain newlines, tabs or 4+ spaces (Meta rule) and are capped. */
export const templateParam = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 900) || '-';

/**
 * Send an approved template.
 * @param {string} to
 * @param {{ name: string, language?: string, params?: string[],
 *           document?: { mediaId?: string, url?: string, filename?: string } }} template
 */
export async function sendTemplate(to, { name, language = 'en', params = [], document = null }) {
  const components = [];
  if (document && (document.mediaId || document.url)) {
    components.push({
      type: 'header',
      parameters: [{
        type: 'document',
        document: document.mediaId
          ? { id: document.mediaId, ...(document.filename ? { filename: document.filename } : {}) }
          : { link: document.url, ...(document.filename ? { filename: document.filename } : {}) },
      }],
    });
  }
  if (params.length) {
    components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateParam(p) })) });
  }
  try {
    const res = await client.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    });
    logger.info('WhatsApp template sent', { to, template: name, messageId: res.data?.messages?.[0]?.id });
    return res.data?.messages?.[0]?.id || null;
  } catch (err) {
    logger.error('Failed to send template', { to, template: name, error: err.response?.data?.error || err.message });
    throw sendError('WhatsApp template send failed', err);
  }
}
