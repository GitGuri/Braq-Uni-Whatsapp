/**
 * One bot turn = one inbound message. The state handlers never write the
 * conversation or send anything directly: they record what should happen —
 * replies, state changes, staff notifications — on the turn, and commit()
 * applies all of it in ONE transaction:
 *
 *   inbound message stored → state/context updates (in order) → replies queued
 *   through the outbox (whatsapp.send, recorded in messages at once) → staff
 *   emails queued (email.send) → inbound_events.processed_at set.
 *
 * So a turn either happens completely or not at all, and every reply is
 * retried by the queue until WhatsApp accepts it. AI calls and domain writes
 * (quotations, orders, tickets…) happen while the handlers run, before commit —
 * never inside the transaction.
 *
 * A duplicate delivery (the message is already stored) rolls the whole turn back.
 */
import { withTransaction, query } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { queueRecordedText, queueWhatsAppText } from '../notifications/whatsapp.js';
import { TEMPLATES } from './templates.js';

class DuplicateInbound extends Error {}

const markProcessed = (db, eventId) =>
  db.query('UPDATE inbound_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL', [eventId]);

export function createTurn({ phoneNumber, metaMessageId = null, eventId = null }) {
  const turn = {
    phone: phoneNumber,
    metaMessageId,
    eventId,
    convo: null,
    client: null,
    /** Text stored as the inbound message (set once the conversation is known). */
    inboundBody: null,
    /** Extra columns of the stored inbound message: { ticketId?, mediaId? }. */
    inboundExtra: {},
    skipped: false,
    ops: [],

    /** The conversation this turn belongs to and the inbound text to store on it. */
    bind(convo, client, inboundBody) {
      turn.convo = convo;
      turn.client = client;
      turn.inboundBody = inboundBody;
    },

    /** Nothing to do (duplicate delivery): commit only marks the event processed. */
    skip() {
      turn.skipped = true;
    },

    /** Queue a reply: templateFn(params) → text. */
    reply(templateFn, params = {}) {
      turn.ops.push({ kind: 'reply', body: templateFn(params) });
    },

    /** Move the conversation to `state`, merging `context` into its context. */
    setState(state, context = {}) {
      turn.ops.push({ kind: 'state', state, context });
    },

    /** Run fn(tx) inside the commit transaction, in order with the other ops. */
    onCommit(fn) {
      turn.ops.push({ kind: 'tx', fn });
    },

    /** Queue a staff notification: fn(tx, ...args) from modules/notifications. */
    notify(fn, ...args) {
      turn.ops.push({ kind: 'tx', fn: (tx) => fn(tx, ...args) });
    },

    async queueReply(tx, body) {
      if (turn.convo) {
        return queueRecordedText(tx, { to: turn.phone, body, clientId: turn.client.id, conversationId: turn.convo.id });
      }
      return queueWhatsAppText(tx, { to: turn.phone, body });
    },

    /** Store the inbound message; false when it was already stored (duplicate). */
    async storeInbound(tx) {
      if (!turn.convo || turn.inboundBody == null) return true;
      const { rows } = await tx.query(
        `INSERT INTO messages (conversation_id, client_id, meta_message_id, direction, body, is_read_by_staff, created_at, ticket_id, media_id)
         VALUES ($1, $2, $3, 'inbound', $4, false, clock_timestamp(), $5, $6)
         ON CONFLICT (meta_message_id) DO NOTHING
         RETURNING id`,
        [turn.convo.id, turn.client.id, turn.metaMessageId, turn.inboundBody,
          turn.inboundExtra.ticketId ?? null, turn.inboundExtra.mediaId ?? null]
      );
      return rows.length > 0;
    },

    /** Apply everything the turn recorded, atomically. Returns false for a duplicate. */
    async commit() {
      if (turn.skipped) {
        if (turn.eventId) await markProcessed({ query }, turn.eventId);
        return false;
      }
      try {
        await withTransaction(async (tx) => {
          if (!(await turn.storeInbound(tx))) throw new DuplicateInbound();
          if (turn.convo && turn.inboundBody != null) {
            await tx.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [turn.convo.id]);
          }
          for (const op of turn.ops) {
            if (op.kind === 'state') {
              await tx.query(
                `UPDATE conversations
                 SET state = $1, context = context || $2::jsonb, last_message_at = NOW()
                 WHERE id = $3`,
                [op.state, JSON.stringify(op.context), turn.convo.id]
              );
            } else if (op.kind === 'reply') {
              await turn.queueReply(tx, op.body);
            } else {
              await op.fn(tx);
            }
          }
          if (turn.eventId) await markProcessed(tx, turn.eventId);
        });
      } catch (err) {
        if (!(err instanceof DuplicateInbound)) throw err;
        logger.debug('Duplicate inbound message skipped', { metaMessageId: turn.metaMessageId });
        if (turn.eventId) await markProcessed({ query }, turn.eventId);
        return false;
      }
      return true;
    },

    /**
     * The turn failed: never leave the customer without a reply. Stores the
     * inbound message and queues a short apology (nothing else of the turn is
     * applied). Throws when even that cannot be written (e.g. the database is
     * down) so the inbound job is retried.
     */
    async fail(err) {
      logger.error('Bot failed to handle inbound message', { error: err.message, phoneNumber: turn.phone });
      await withTransaction(async (tx) => {
        if (!(await turn.storeInbound(tx))) {
          // Handled by a concurrent delivery of the same message — no apology.
          if (turn.eventId) await markProcessed(tx, turn.eventId);
          return;
        }
        await turn.queueReply(tx, TEMPLATES.GENERIC_ERROR());
        if (turn.eventId) await markProcessed(tx, turn.eventId);
      });
    },
  };
  return turn;
}

/**
 * Handler context: what every state handler receives. `state` follows the
 * turn's own state changes (setState), so a later step sees where the
 * conversation now is; `convo.context` stays the context the turn started with.
 */
export function handlerContext(turn, { body, intent, state }) {
  const c = {
    turn,
    body,
    intent,
    state,
    convo: turn.convo,
    client: turn.client,
    phone: turn.phone,
    R: (templateFn, params) => turn.reply(templateFn, params),
    /** Reply with a ready-made text. */
    say: (text) => turn.reply(() => text),
    setState: (s, ctx) => { c.state = s; turn.setState(s, ctx); },
    notify: (fn, ...args) => turn.notify(fn, ...args),
  };
  return c;
}
