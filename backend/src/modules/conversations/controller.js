// HTTP layer for the inbox — validation + mapping to modules/conversations/service.js.
import * as conversations from './service.js';
import { sendError, isUuid } from '../../core/errors.js';
import { paged } from '../../core/http.js';
import { logger } from '../../core/logger.js';

// ── GET /conversations ────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    if (req.query.clientId && !isUuid(req.query.clientId)) return res.status(400).json({ error: 'clientId must be a client UUID' });
    // { items, total, page, limit } + legacy `conversations`
    paged(res, 'conversations', await conversations.listConversations(req.query, req.staff.id));
  } catch (err) {
    sendError(res, err, 'Failed to list conversations');
  }
}

// ── GET /conversations/unread-count ──────────────────────────────────────────
export async function unreadCount(req, res) {
  try {
    res.json(await conversations.unreadCounts());
  } catch (err) {
    sendError(res, err, 'Failed to fetch unread count');
  }
}

// ── GET /conversations/:id ────────────────────────────────────────────────────
export async function getById(req, res) {
  try {
    res.json(await conversations.getConversation(req.params.id));
  } catch (err) {
    sendError(res, err, 'Failed to fetch conversation');
  }
}

// ── POST /conversations/:id/reply ─────────────────────────────────────────────
export async function reply(req, res) {
  const { body } = req.body ?? {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  // WhatsApp's text limit: refuse instead of letting Meta reject it later (SEC-9).
  if (body.length > 4096) return res.status(400).json({ error: 'Message is too long (WhatsApp allows 4096 characters)' });

  try {
    const { messageId, jobId } = await conversations.reply(req.params.id, req.staff.id, body);
    logger.info('Staff reply queued', { conversationId: req.params.id, by: req.staff.email });
    // Queued through the outbox: already in the conversation (status 'queued');
    // the WhatsApp message id is filled in once the worker has sent it.
    res.json({ sent: true, queued: true, messageId, jobId, metaMessageId: null });
  } catch (err) {
    sendError(res, err, 'Failed to send reply');
  }
}

// ── PATCH /conversations/:id/takeover ─────────────────────────────────────────
export async function takeover(req, res) {
  try {
    res.json({ conversation: await conversations.takeover(req.params.id, req.staff) });
  } catch (err) {
    sendError(res, err, 'Failed to take over conversation');
  }
}

// ── PATCH /conversations/:id/handback ────────────────────────────────────────
export async function handback(req, res) {
  try {
    res.json({ conversation: await conversations.handback(req.params.id, req.staff) });
  } catch (err) {
    sendError(res, err, 'Failed to hand back conversation');
  }
}

// ── POST /conversations/:id/claim ────────────────────────────────────────────
export async function claim(req, res) {
  try {
    res.json({ conversation: await conversations.claim(req.params.id, req.staff.id) });
  } catch (err) {
    sendError(res, err, 'Failed to claim conversation');
  }
}

// ── PATCH /conversations/:id/close ───────────────────────────────────────────
export async function close(req, res) {
  try {
    res.json({ conversation: await conversations.close(req.params.id) });
  } catch (err) {
    sendError(res, err, 'Failed to close conversation');
  }
}

// ── PATCH /conversations/:id/assign ──────────────────────────────────────────
export async function assign(req, res) {
  const { staffId } = req.body ?? {};
  if (!staffId) return res.status(400).json({ error: 'staffId required' });
  if (!isUuid(staffId)) return res.status(400).json({ error: 'staffId must be a staff UUID' });

  try {
    res.json({ conversation: await conversations.assign(req.params.id, staffId, req.staff) });
  } catch (err) {
    sendError(res, err, 'Failed to assign conversation');
  }
}

// ── PATCH /conversations/:id/read ────────────────────────────────────────────
export async function markRead(req, res) {
  try {
    await conversations.markRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Failed to mark messages as read');
  }
}
