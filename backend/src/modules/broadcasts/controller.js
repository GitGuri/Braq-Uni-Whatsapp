// HTTP layer for broadcasts — validation + mapping to modules/broadcasts/service.js.
import * as broadcasts from './service.js';
import { logger } from '../../core/logger.js';
import { uploadAttachment } from '../../middleware/upload.js';
import { sendError } from '../../core/errors.js';

// ── POST /broadcasts/upload-attachment — upload image or PDF to WhatsApp ──────
export function uploadBroadcastAttachment(req, res) {
  uploadAttachment(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    try {
      res.json(await broadcasts.uploadAttachment(req.file));
    } catch (uploadErr) {
      logger.error('Attachment upload to WhatsApp failed', { error: uploadErr.message });
      res.status(500).json({ error: 'Failed to upload file to WhatsApp. Check API credentials.' });
    }
  });
}

// ── GET /broadcasts — list recent broadcasts ──────────────────────────────────
export async function list(req, res) {
  res.json({ broadcasts: await broadcasts.listBroadcasts() });
}

// Sends are queued: 202 { broadcastId, recipients, status, total, sent, failed }
// (the worker fans out one WhatsApp send per recipient).

// ── POST /broadcasts/custom — send a custom message to a target audience ──────
export async function custom(req, res) {
  const { message, imageUrl, mediaId } = req.body ?? {};
  if (!message?.trim() && !imageUrl?.trim() && !mediaId?.trim()) {
    return res.status(400).json({ error: 'message or attachment is required' });
  }
  try {
    res.status(202).json(await broadcasts.sendCustom(req.staff.id, req.body));
  } catch (err) {
    sendError(res, err, 'Broadcast failed');
  }
}

// ── POST /broadcasts/delay — send supplier delay to all active corporate clients
export async function delay(req, res) {
  try {
    res.status(202).json(await broadcasts.sendSupplierDelay(req.staff.id));
  } catch (err) {
    sendError(res, err, 'Broadcast failed');
  }
}

// ── POST /broadcasts/busy — high volume notice to all clients with open orders
export async function busy(req, res) {
  try {
    res.status(202).json(await broadcasts.sendBusyNotice(req.staff.id));
  } catch (err) {
    sendError(res, err, 'Broadcast failed');
  }
}
