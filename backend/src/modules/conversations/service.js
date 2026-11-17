// Inbox conversations: listing, reading, staff replies, takeover / hand-back,
// claiming, assignment, closing and read receipts. All SQL for the inbox lives
// here; the controller only maps HTTP to these functions. Messages to the client
// go through the outbox (queueRecordedText): recorded in the conversation at
// once and retried until WhatsApp accepts them.
import { query, withTransaction } from '../../core/db.js';
import { HttpError, pageParams } from '../../core/errors.js';
import { queueRecordedText, TEMPLATE_FALLBACKS } from '../notifications/whatsapp.js';
import { latestJobSql } from '../jobs/service.js';
import { TEMPLATES } from '../bot/templates.js';

/** Admins and managers may take over a chat another consultant owns. */
const MAY_REASSIGN = new Set(['admin', 'manager']);

/** Escape LIKE wildcards so user input is matched literally. */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const HANDBACK_MESSAGE =
  'Hi! Our team has finished assisting you. You can continue using our bot anytime — just type *menu* to see your options. 😊';

/**
 * @param {{ state?: string, isOpen?: string, assignedToMe?: string, search?: string,
 *           clientId?: string, page?: string, limit?: string }} filters
 *   search: client name / organisation / WhatsApp number (digits match any format)
 * @param {string} staffId the caller (for assignedToMe)
 * @returns {{ items, total, page, limit }}
 */
export async function listConversations({ state, isOpen = 'true', assignedToMe, search, clientId, ...paging } = {}, staffId) {
  const { page, limit, offset } = pageParams(paging, { defaultLimit: 30 });
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
    params.push(staffId);
    conditions.push(`c.assigned_staff_id = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    conditions.push(`c.client_id = $${params.length}`);
  }
  const term = typeof search === 'string' ? search.trim() : '';
  if (term) {
    params.push(`%${escapeLike(term)}%`);
    const like = `$${params.length}`;
    const ors = [`cl.name ILIKE ${like}`, `cl.organisation ILIKE ${like}`, `cl.whatsapp_number ILIKE ${like}`];
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      ors.push(`regexp_replace(cl.whatsapp_number, '[^0-9]', '', 'g') LIKE $${params.length}`);
    }
    conditions.push(`(${ors.join(' OR ')})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM conversations c JOIN clients cl ON cl.id = c.client_id ${where}`, params);
  params.push(limit, offset);

  const { rows } = await query(
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
       (SELECT status FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC LIMIT 1)  AS last_message_status,
       -- who wrote the last message: a staff member (id + name), or NULL = the client / the bot
       (SELECT json_build_object('id', m.sent_by_staff_id, 'name', ms.name) FROM messages m
        LEFT JOIN staff ms ON ms.id = m.sent_by_staff_id
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC LIMIT 1)  AS last_message_sender,
       ${latestJobSql('cl.id')}              AS latest_job,
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
  return { items: rows, total: countRows[0].n, page, limit };
}

export async function unreadCounts() {
  const { rows } = await query(
    `SELECT
       COUNT(DISTINCT c.id) FILTER (WHERE c.state = 'awaiting_consultant') AS waiting,
       COUNT(m.id) FILTER (WHERE m.is_read_by_staff = false AND m.direction = 'inbound') AS unread_messages
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.is_open = true`
  );
  return { waiting: parseInt(rows[0].waiting, 10), unreadMessages: parseInt(rows[0].unread_messages, 10) };
}

/** Conversation + client/staff names + all messages (oldest first). 404 when missing. */
export async function getConversation(id) {
  const { rows } = await query(
    `SELECT
       c.*,
       cl.name AS client_name, cl.whatsapp_number AS client_wa_id,
       cl.client_type, cl.organisation, cl.email,
       s.name AS assigned_staff_name
     FROM conversations c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN staff s ON s.id = c.assigned_staff_id
     WHERE c.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Conversation not found');

  const { rows: messages } = await query(
    `SELECT m.id, m.direction, m.body, m.is_read_by_staff,
            m.created_at AS sent_at, m.meta_message_id, m.status,
            m.sent_by_staff_id, ms.name AS sent_by_name
     FROM messages m
     LEFT JOIN staff ms ON ms.id = m.sent_by_staff_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC`,
    [id]
  );
  return { conversation: rows[0], messages };
}

/**
 * Queue a staff reply (outbox: recorded in the conversation now, sent and
 * retried by the worker) and move a waiting conversation to consultant_active
 * (assigning the replier if nobody owns it) — one transaction.
 * @returns {Promise<{ messageId: string, jobId: number }>}
 */
export async function reply(id, staffId, body) {
  const text = body.trim();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT c.id, c.client_id, cl.whatsapp_number, cl.name AS client_name,
              (SELECT name FROM staff WHERE id = $2) AS staff_name
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [id, staffId]
    );
    if (!rows.length) throw new HttpError(404, 'Conversation not found');
    if (!rows[0].whatsapp_number) throw new HttpError(409, 'Client has no WhatsApp number', { code: 'NO_WHATSAPP' });

    const { jobId, messageId } = await queueRecordedText(tx, {
      to: rows[0].whatsapp_number, body: text, clientId: rows[0].client_id, conversationId: id,
      // Outside the 24-hour window the consultant-reply template carries the message.
      templateFallback: TEMPLATE_FALLBACKS.consultantReply({ client: { name: rows[0].client_name }, staffName: rows[0].staff_name, text }),
    });
    // Written by this staff member (the inbox shows "You:" / their name, not "Bot:").
    if (messageId) await tx.query('UPDATE messages SET sent_by_staff_id = $1 WHERE id = $2', [staffId, messageId]);

    await tx.query(
      `UPDATE conversations
       SET state = CASE WHEN state = 'awaiting_consultant' THEN 'consultant_active' ELSE state END,
           assigned_staff_id = COALESCE(assigned_staff_id, $2),
           last_message_at = NOW()
       WHERE id = $1`,
      [id, staffId]
    );
    return { messageId, jobId };
  });
}

/** "👋 Thabo from Braq Uni is now helping you" to the client (queued + recorded). */
async function queueConsultantAssigned(tx, conversation, actor) {
  const { rows } = await tx.query(
    `SELECT cl.whatsapp_number, s.name AS staff_name
     FROM clients cl LEFT JOIN staff s ON s.id = $2
     WHERE cl.id = $1`,
    [conversation.client_id, actor.id]
  );
  if (!rows[0]?.whatsapp_number) return;
  const consultantName = String(rows[0].staff_name || actor.name || '').trim().split(/\s+/)[0] || null;
  await queueRecordedText(tx, {
    to: rows[0].whatsapp_number,
    body: TEMPLATES.CONSULTANT_ASSIGNED({ consultantName }),
    clientId: conversation.client_id,
    conversationId: conversation.id,
  });
}

/**
 * A consultant takes the chat over from the bot. Never silently steals another
 * consultant's chat: 409 naming the owner unless the chat is unassigned, already
 * the caller's, or the caller is an admin / manager.
 * @param {string} id
 * @param {{ id: string, role?: string }} staff the caller
 */
export async function takeover(id, staff) {
  const actor = typeof staff === 'string' ? { id: staff } : staff;
  const mayReassign = MAY_REASSIGN.has(actor?.role);
  const taken = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `WITH prev AS (SELECT id, state, assigned_staff_id FROM conversations WHERE id = $1 FOR UPDATE)
       UPDATE conversations cv
       SET state = 'consultant_active', assigned_staff_id = $2, updated_at = NOW()
       FROM prev
       WHERE cv.id = prev.id AND (prev.assigned_staff_id IS NULL OR prev.assigned_staff_id = $2 OR $3::boolean)
       RETURNING cv.*, prev.state AS prev_state, prev.assigned_staff_id AS prev_staff_id`,
      [id, actor.id, mayReassign]
    );
    if (!rows.length) return null;
    const { prev_state: prevState, prev_staff_id: prevStaffId, ...conversation } = rows[0];
    // Tell the client who is helping them — once per takeover, not on a repeat click.
    if (prevState !== 'consultant_active' || prevStaffId !== actor.id) {
      await queueConsultantAssigned(tx, conversation, actor);
    }
    return conversation;
  });
  if (taken) return taken;

  const { rows: current } = await query(
    `SELECT cv.id, s.name AS owner_name
     FROM conversations cv LEFT JOIN staff s ON s.id = cv.assigned_staff_id
     WHERE cv.id = $1`,
    [id]
  );
  if (!current.length) throw new HttpError(404, 'Conversation not found');
  throw new HttpError(409, `Already handled by ${current[0].owner_name ?? 'another consultant'}`, { code: 'CONVERSATION_CLAIMED' });
}

/**
 * 409 naming the owner when `id` exists but belongs to someone else (the caller may
 * not reassign it); 404 when it does not exist.
 */
async function refuseNotYours(id) {
  const { rows } = await query(
    `SELECT cv.id, s.name AS owner_name FROM conversations cv LEFT JOIN staff s ON s.id = cv.assigned_staff_id WHERE cv.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Conversation not found');
  throw new HttpError(409, `Already handled by ${rows[0].owner_name ?? 'another consultant'}`, { code: 'CONVERSATION_CLAIMED' });
}

/** The ownership rule shared by take-over, hand-back and assign (AUTH-1), as SQL on prev.assigned_staff_id. */
const MAY_ACT_SQL = (staffParam, mayReassignParam) =>
  `(prev.assigned_staff_id IS NULL OR prev.assigned_staff_id = ${staffParam} OR ${mayReassignParam}::boolean)`;

/**
 * Return the conversation to the bot and tell the client (queued + recorded).
 * Only the chat's owner (or anyone when unassigned, or an admin / manager) may hand
 * it back — never another consultant's chat (AUTH-1).
 */
export async function handback(id, staff = null) {
  const actor = typeof staff === 'string' ? { id: staff } : staff;
  const mayReassign = !actor || MAY_REASSIGN.has(actor.role);
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `WITH prev AS (SELECT id, assigned_staff_id FROM conversations WHERE id = $1 FOR UPDATE)
       UPDATE conversations cv
       SET state = 'main_menu', assigned_staff_id = NULL, updated_at = NOW()
       FROM prev
       WHERE cv.id = prev.id AND ${MAY_ACT_SQL('$2::uuid', '$3')}
       RETURNING cv.*`,
      [id, actor?.id ?? null, mayReassign]
    );
    if (!rows.length) await refuseNotYours(id);

    const { rows: clientRows } = await tx.query('SELECT whatsapp_number FROM clients WHERE id = $1', [rows[0].client_id]);
    if (clientRows[0]?.whatsapp_number) {
      await queueRecordedText(tx, {
        to: clientRows[0].whatsapp_number, body: HANDBACK_MESSAGE, clientId: rows[0].client_id, conversationId: id,
      });
    }
    return rows[0];
  });
}

/** First claimer wins; 409 naming the current owner otherwise. */
export async function claim(id, staffId) {
  const { rows } = await query(
    `UPDATE conversations
     SET assigned_staff_id = $1, claimed_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND assigned_staff_id IS NULL
     RETURNING *`,
    [staffId, id]
  );
  if (rows.length) return rows[0];

  const { rows: current } = await query(
    `SELECT cv.id, s.name AS claimer_name
     FROM conversations cv
     LEFT JOIN staff s ON s.id = cv.assigned_staff_id
     WHERE cv.id = $1`,
    [id]
  );
  if (!current.length) throw new HttpError(404, 'Conversation not found');
  throw new HttpError(409, `Already claimed by ${current[0].claimer_name ?? 'another consultant'}`);
}

export async function close(id) {
  const { rows } = await query(
    `UPDATE conversations SET is_open = false, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Conversation not found');
  return rows[0];
}

/**
 * Assign the chat to `staffId`. Allowed when the chat is unassigned, is the caller's
 * own (handing it to a colleague), or the caller is an admin / manager (AUTH-1).
 */
export async function assign(id, staffId, caller = null) {
  const { rows: staff } = await query('SELECT id FROM staff WHERE id = $1 AND is_active = true', [staffId]);
  if (!staff.length) throw new HttpError(400, 'staffId does not match an active staff member');
  const actor = typeof caller === 'string' ? { id: caller } : caller;
  const mayReassign = !actor || MAY_REASSIGN.has(actor.role);

  const { rows } = await query(
    `WITH prev AS (SELECT id, assigned_staff_id FROM conversations WHERE id = $1 FOR UPDATE)
     UPDATE conversations cv SET assigned_staff_id = $2, updated_at = NOW()
     FROM prev
     WHERE cv.id = prev.id AND ${MAY_ACT_SQL('$3::uuid', '$4')}
     RETURNING cv.*`,
    [id, staffId, actor?.id ?? null, mayReassign]
  );
  if (!rows.length) await refuseNotYours(id);
  return rows[0];
}

export async function markRead(id) {
  const { rows } = await query('SELECT id FROM conversations WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Conversation not found');
  await query(
    `UPDATE messages SET is_read_by_staff = true
     WHERE conversation_id = $1 AND direction = 'inbound' AND is_read_by_staff = false`,
    [id]
  );
}
