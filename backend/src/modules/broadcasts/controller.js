// HTTP layer for broadcasts — validation + mapping to modules/broadcasts/service.js.
import * as broadcasts from './service.js';
import { logger } from '../../core/logger.js';
import { uploadAttachment } from '../../middleware/upload.js';
import { z } from 'zod';
import { sendError, validationBody } from '../../core/errors.js';

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
  try {
    res.json({ broadcasts: await broadcasts.listBroadcasts() });
  } catch (err) {
    sendError(res, err, 'Failed to load broadcasts');
  }
}

// Sends are queued: 202 { broadcastId, recipients, status, total, sent, failed }
// (the worker fans out one WhatsApp send per recipient).

// The audience must be named explicitly: an unknown value is a 400, never "everyone".
const optText = (max) => z.string().max(max).optional().nullable();
export const CustomBroadcastSchema = z.object({
  audience:      z.enum(broadcasts.AUDIENCES, { errorMap: () => ({ message: `audience must be one of ${broadcasts.AUDIENCES.join(', ')}` }) }),
  message:       optText(4096),
  imageUrl:      z.string().url().max(2000).optional().nullable().or(z.literal('')),
  mediaId:       optText(200),
  mediaType:     z.enum(['image', 'pdf']).optional().nullable(),
  mediaFilename: optText(255),
}).refine((b) => [b.message, b.imageUrl, b.mediaId].some((v) => typeof v === 'string' && v.trim()), {
  message: 'message or attachment is required',
});

// ── POST /broadcasts/custom — send a custom message to a target audience ──────
export async function custom(req, res) {
  const parsed = CustomBroadcastSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    res.status(202).json(await broadcasts.sendCustom(req.staff.id, parsed.data));
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
