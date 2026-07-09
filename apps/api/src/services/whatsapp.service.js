import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const BASE_URL = `https://graph.facebook.com/${config.meta.apiVersion}/${config.meta.phoneNumberId}`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${config.meta.token}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

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
    const detail = err.response?.data?.error || err.message;
    logger.error('Failed to send WhatsApp message', { to, error: detail });
    throw new Error(`WhatsApp send failed: ${JSON.stringify(detail)}`);
  }
}

// ── Mark a message as read ────────────────────────────────────────────────────
export async function markAsRead(messageId) {
  try {
    await client.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (err) {
    logger.warn('Failed to mark message as read', { messageId });
  }
}

// ── Send a reaction ──────────────────────────────────────────────────────────
export async function sendReaction(to, messageId, emoji) {
  try {
    await client.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    });
  } catch (err) {
    logger.warn('Failed to send reaction', { messageId });
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
    const detail = err.response?.data?.error || err.message;
    logger.error('Failed to send image', { to, error: detail });
    throw new Error(`WhatsApp image send failed: ${JSON.stringify(detail)}`);
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
    const detail = err.response?.data?.error || err.message;
    logger.error('Failed to send document', { to, error: detail });
    throw new Error(`WhatsApp document send failed: ${JSON.stringify(detail)}`);
  }
}
