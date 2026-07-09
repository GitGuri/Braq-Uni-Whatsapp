import { query } from '../db/pool.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

function handleError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallback, { error: err.message });
  return res.status(500).json({ error: fallback });
}

// ── GET /conversations ────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const { state, isOpen = 'true', assignedToMe, limit = 30, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const params = [];

    if (isOpen !== 'all') {
      params.push(isOpen !== 'false');
      conditions.push(`c.is_open = $${params.length}`);
    }

    if (state) {
      params.push(state);
      conditions.push(`c.state = $${params.length}`);
    }

    if (assignedToMe === 'true') {
      params.push(req.staff.id);
      conditions.push(`c.assigned_staff_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(parseInt(limit), offset);

    const { rows: conversations } = await query(
      `SELECT
         c.id, c.state, c.is_open, c.last_message_at, c.created_at,
         c.assigned_staff_id,
         cl.id              AS client_id,
         cl.name            AS client_name,
         cl.whatsapp_number AS client_wa_id,
         cl.client_type,
         s.name             AS assigned_staff_name,
         (SELECT body FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1)  AS last_message_body,
         (SELECT direction FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1)  AS last_message_direction,
         (SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id
            AND m.direction = 'inbound'
            AND m.is_read_by_staff = false)     AS unread_count
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN staff s ON s.id = c.assigned_staff_id
       ${where}
       ORDER BY c.last_message_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ conversations });
  } catch (err) {
    handleError(res, err, 'Failed to list conversations');
  }
}

// ── GET /conversations/unread-count ──────────────────────────────────────────
export async function unreadCount(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(DISTINCT c.id) FILTER (WHERE c.state = 'awaiting_consultant') AS waiting,
         COUNT(m.id) FILTER (WHERE m.is_read_by_staff = false AND m.direction = 'inbound') AS unread_messages
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.is_open = true`
    );
    res.json({ waiting: parseInt(rows[0].waiting), unreadMessages: parseInt(rows[0].unread_messages) });
  } catch (err) {
    handleError(res, err, 'Failed to fetch unread count');
  }
}

// ── GET /conversations/:id ────────────────────────────────────────────────────
export async function getById(req, res) {
  try {
    const { rows: convRows } = await query(
      `SELECT
         c.*,
         cl.name AS client_name, cl.whatsapp_number AS client_wa_id,
         cl.client_type, cl.organisation, cl.email,
         s.name AS assigned_staff_name
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN staff s ON s.id = c.assigned_staff_id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (!convRows.length) throw new HttpError(404, 'Conversation not found');

    const { rows: messages } = await query(
      `SELECT id, direction, body, is_read_by_staff,
              created_at AS sent_at, meta_message_id
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ conversation: convRows[0], messages });
  } catch (err) {
    handleError(res, err, 'Failed to fetch conversation');
  }
}

// ── POST /conversations/:id/reply ─────────────────────────────────────────────
export async function reply(req, res) {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Message body is required' });

  try {
    const { rows } = await query(
      `SELECT c.id, cl.whatsapp_number
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');

    const { whatsapp_number } = rows[0];

    const metaMessageId = await sendTextMessage(whatsapp_number, body.trim());

    await query(
      `INSERT INTO messages (conversation_id, client_id, meta_message_id, direction, body, is_read_by_staff)
       SELECT c.id, c.client_id, $2, 'outbound', $3, true
       FROM conversations c WHERE c.id = $1`,
      [req.params.id, metaMessageId, body.trim()]
    );

    await query(
      `UPDATE conversations
       SET state = CASE WHEN state = 'awaiting_consultant' THEN 'consultant_active' ELSE state END,
           assigned_staff_id = COALESCE(assigned_staff_id, $2),
           last_message_at = NOW()
       WHERE id = $1`,
      [req.params.id, req.staff.id]
    );

    logger.info('Staff reply sent', { conversationId: req.params.id, by: req.staff.email });
    res.json({ sent: true, metaMessageId });
  } catch (err) {
    handleError(res, err, 'Failed to send reply');
  }
}

// ── PATCH /conversations/:id/takeover ─────────────────────────────────────────
export async function takeover(req, res) {
  try {
    const { rows } = await query(
      `UPDATE conversations
       SET state = 'consultant_active', assigned_staff_id = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.staff.id]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');
    res.json({ conversation: rows[0] });
  } catch (err) {
    handleError(res, err, 'Failed to take over conversation');
  }
}

// ── PATCH /conversations/:id/handback ────────────────────────────────────────
export async function handback(req, res) {
  try {
    const { rows } = await query(
      `UPDATE conversations
       SET state = 'main_menu', assigned_staff_id = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');

    const { rows: clientRows } = await query(
      `SELECT cl.whatsapp_number FROM clients cl
       JOIN conversations c ON c.client_id = cl.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (clientRows.length) {
      await sendTextMessage(
        clientRows[0].whatsapp_number,
        `Hi! Our team has finished assisting you. You can continue using our bot anytime — just type *menu* to see your options. 😊`
      );
    }

    res.json({ conversation: rows[0] });
  } catch (err) {
    handleError(res, err, 'Failed to hand back conversation');
  }
}

// ── POST /conversations/:id/claim ────────────────────────────────────────────
export async function claim(req, res) {
  try {
    const { rows } = await query(
      `UPDATE conversations
       SET assigned_staff_id = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND assigned_staff_id IS NULL
       RETURNING *`,
      [req.staff.id, req.params.id]
    );

    if (rows.length) return res.json({ conversation: rows[0] });

    const { rows: current } = await query(
      `SELECT cv.id, s.name AS claimer_name
       FROM conversations cv
       LEFT JOIN staff s ON s.id = cv.assigned_staff_id
       WHERE cv.id = $1`,
      [req.params.id]
    );
    if (!current.length) return res.status(404).json({ error: 'Conversation not found' });

    return res.status(409).json({
      error: `Already claimed by ${current[0].claimer_name ?? 'another consultant'}`,
    });
  } catch (err) {
    handleError(res, err, 'Failed to claim conversation');
  }
}

// ── PATCH /conversations/:id/close ───────────────────────────────────────────
export async function close(req, res) {
  try {
    const { rows } = await query(
      `UPDATE conversations SET is_open = false, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');
    res.json({ conversation: rows[0] });
  } catch (err) {
    handleError(res, err, 'Failed to close conversation');
  }
}

// ── PATCH /conversations/:id/assign ──────────────────────────────────────────
export async function assign(req, res) {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });

  try {
    const { rows } = await query(
      `UPDATE conversations SET assigned_staff_id = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, staffId]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');
    res.json({ conversation: rows[0] });
  } catch (err) {
    handleError(res, err, 'Failed to assign conversation');
  }
}

// ── PATCH /conversations/:id/read ────────────────────────────────────────────
export async function markRead(req, res) {
  try {
    await query(
      `UPDATE messages SET is_read_by_staff = true
       WHERE conversation_id = $1 AND direction = 'inbound' AND is_read_by_staff = false`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 'Failed to mark messages as read');
  }
}
