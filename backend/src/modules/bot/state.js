/**
 * Conversation state for the bot: finding / opening the client's conversation,
 * duplicate detection, settings, and the navigation tables (parent states for
 * "back", data-collection states where keywords are off). State changes
 * themselves are recorded on the turn (reply.js) and applied at commit.
 */
import { query } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { HUMAN_STATES } from '../lifecycle/machines.js';

/** A consultant owns the chat: the bot stays silent (lifecycle/machines.js). */
export const CONSULTANT_STATES = new Set(HUMAN_STATES);

// Parent state for "back" navigation
export const PARENT_STATE = {
  main_menu:                  'main_menu',
  retail_menu:                'main_menu',
  retail_pricing:             'retail_menu',
  retail_size_ask:            'retail_menu',
  retail_layby:               'retail_menu',
  retail_hours:               'retail_menu',
  retail_collection_ask:      'retail_menu',
  retail_school_select:       'retail_menu',
  corporate_menu:             'main_menu',
  corporate_repeat_order_ask: 'corporate_menu',
  corporate_manufacturing_ask:'corporate_menu',
  corporate_delivery_ask:     'corporate_menu',
  corporate_account_query:    'corporate_menu',
  quotation_ask_description:  'main_menu',
  order_ask_method:           'main_menu',
  order_ask_reference:        'order_ask_method',
  order_gathering:            'order_ask_method',
  order_confirm_quote:        'main_menu',
  order_confirm_direct:       'main_menu',
  order_tracking_ask:         'main_menu',
  ticket_ask_category:        'main_menu',
  ticket_ask_description:     'ticket_ask_category',
};

export const PARENT_TEMPLATE = {
  main_menu:          (T) => T.MAIN_MENU,
  retail_menu:        (T) => T.RETAIL_MENU,
  corporate_menu:     (T) => T.CORPORATE_MENU,
  ticket_ask_category:(T) => T.TICKET_ASK_CATEGORY,
};

// States where free text is data, not navigation intent — keywords disabled
export const DATA_COLLECTION_STATES = new Set([
  'quotation_ask_description',
  'quotation_gathering',
  'order_gathering',
  'proof_review',
  'proof_revision_describe',
  'ticket_ask_description',
  'corporate_account_query',
  'registration_name',
  'registration_org_or_school',
  'registration_address',
  'retail_size_ask',
]);

export async function getSetting(key) {
  const { rows } = await query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function findOpenConversation(clientId) {
  const { rows } = await query(
    `SELECT * FROM conversations WHERE client_id = $1 AND is_open = true ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

/** The client's open conversation, opened (in main_menu) when there is none. */
export async function getOrCreateConversation(clientId) {
  const existing = await findOpenConversation(clientId);
  if (existing) return { conversation: existing, isNew: false };

  // Two simultaneous messages must not open two conversations: the partial unique
  // index uniq_open_conversation_per_client makes the loser a no-op.
  let created;
  try {
    ({ rows: created } = await query(
      `INSERT INTO conversations (client_id, state) VALUES ($1, 'main_menu')
       ON CONFLICT (client_id) WHERE is_open = true DO NOTHING
       RETURNING *`,
      [clientId]
    ));
  } catch (err) {
    // 42P10: older database without the partial unique index — plain insert
    if (err.code !== '42P10') throw err;
    logger.warn('uniq_open_conversation_per_client index missing — run migrations', { clientId });
    ({ rows: created } = await query(
      `INSERT INTO conversations (client_id, state) VALUES ($1, 'main_menu') RETURNING *`,
      [clientId]
    ));
  }
  if (created?.length) return { conversation: created[0], isNew: true };

  // Lost the race — another message just opened it
  const winner = await findOpenConversation(clientId);
  if (winner) return { conversation: winner, isNew: false };
  throw new Error('Could not open a conversation');
}

// Cheap pre-check so Meta retries are skipped before any side effects (new conversation, greetings)
export async function isDuplicateMessage(metaMessageId) {
  if (!metaMessageId) return false;
  const { rows } = await query(`SELECT 1 FROM messages WHERE meta_message_id = $1`, [metaMessageId]);
  return rows.length > 0;
}

/** Body of the most recent outbound message on the conversation (queued ones included). */
export async function lastOutboundBody(conversationId) {
  const { rows } = await query(
    `SELECT body FROM messages
     WHERE conversation_id = $1 AND direction = 'outbound'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  return rows[0]?.body ?? null;
}

// Trim free text to a DB column's length (counting characters, not UTF-16 units)
export function clip(text, max) {
  const chars = Array.from(String(text ?? '').trim());
  return chars.length > max ? chars.slice(0, max).join('').trim() : chars.join('');
}
