import { query, withTransaction } from '../../core/db.js';
import { HttpError, pageParams } from '../../core/errors.js';

// Columns the dashboard can update directly
export const DASHBOARD_FIELD_MAP = {
  name: 'name', email: 'email', clientType: 'client_type',
  organisation: 'organisation', contactPerson: 'contact_person',
  physicalAddress: 'physical_address', vatNumber: 'vat_number',
  preferredStoreLocation: 'preferred_store_location', schoolName: 'school_name',
  deliveryPreference: 'delivery_preference',
};

// Columns the bot can write directly using snake_case keys
const BOT_ALLOWED_COLUMNS = new Set([
  'name', 'school_name', 'organisation', 'physical_address',
  'preferred_store_location', 'profile_complete', 'client_type',
]);

// Must run on the same transaction client as the INSERT so a lost race rolls
// the counter back instead of burning a customer number.
async function nextCustomerNumber(tx) {
  const { rows } = await tx.query(
    `INSERT INTO sequence_counters (key, date_key, value)
     VALUES ('customer', 'global', 1)
     ON CONFLICT (key, date_key) DO UPDATE SET value = sequence_counters.value + 1
     RETURNING value`
  );
  return `C-${String(rows[0].value).padStart(4, '0')}`;
}

class ClientAlreadyExists extends Error {}

// ── Find or create a client by WhatsApp number (bot entry point) ─────────────
// Safe under concurrency: two simultaneous first messages from a new number
// both resolve to the same row (the loser's INSERT hits ON CONFLICT, its
// transaction — including the customer-number bump — rolls back, and it
// re-reads the winner's row).
export async function getOrCreateClientByWhatsapp(phoneNumber) {
  const { rows: existing } = await query(
    'SELECT * FROM clients WHERE whatsapp_number = $1',
    [phoneNumber]
  );
  if (existing.length) return existing[0];

  let created = null;
  try {
    created = await withTransaction(async (tx) => {
      const customerNumber = await nextCustomerNumber(tx);
      const { rows } = await tx.query(
        `INSERT INTO clients (whatsapp_number, client_type, customer_number)
         VALUES ($1, 'retail', $2)
         ON CONFLICT (whatsapp_number) DO NOTHING
         RETURNING *`,
        [phoneNumber, customerNumber]
      );
      if (!rows.length) throw new ClientAlreadyExists();
      return rows[0];
    });
  } catch (err) {
    if (!(err instanceof ClientAlreadyExists)) throw err;
  }
  if (created) return created;

  const { rows } = await query(
    'SELECT * FROM clients WHERE whatsapp_number = $1',
    [phoneNumber]
  );
  return rows[0];
}

// ── Update profile fields — accepts snake_case keys (from bot) ────────────────
// Whichever keys are passed, they must be in BOT_ALLOWED_COLUMNS.
export async function updateClientProfile(clientId, fields) {
  const setFields = [];
  const params = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!BOT_ALLOWED_COLUMNS.has(key)) continue;
    params.push(value);
    setFields.push(`${key} = $${params.length}`);
  }
  if (!setFields.length) throw new HttpError(400, 'No valid profile fields to update');

  params.push(clientId);
  const { rows } = await query(
    `UPDATE clients SET ${setFields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');
  return rows[0];
}

/** Keep OFFSET a safe integer for absurd page numbers (they just return no rows). */
function safePage({ page, limit }) {
  const p = Math.min(page, Math.floor(Number.MAX_SAFE_INTEGER / limit));
  return { page: p, limit, offset: (p - 1) * limit };
}

/** Escape LIKE wildcards so user input is matched literally. */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ── List clients with search and pagination ──────────────────────────────────
// clientType is expected to be pre-validated by the controller.
// Returns { items, total, page, limit }.
export async function listClients({ search, clientType, ...rest } = {}) {
  const { page, limit, offset } = safePage(pageParams(rest, { defaultLimit: 30, maxLimit: 200 }));
  const where = ['1=1'];
  const params = [];

  if (typeof search === 'string' && search.trim()) {
    params.push(`%${escapeLike(search.trim())}%`);
    where.push(
      `(c.name ILIKE $${params.length} OR c.whatsapp_number ILIKE $${params.length} OR c.organisation ILIKE $${params.length})`
    );
  }
  if (clientType) { params.push(clientType); where.push(`c.client_type = $${params.length}`); }

  const filterParams = [...params];
  params.push(limit); params.push(offset);

  const { rows } = await query(
    `SELECT c.*,
            COUNT(DISTINCT o.id) AS total_orders,
            COUNT(DISTINCT q.id) AS total_quotations
     FROM clients c
     LEFT JOIN orders     o ON o.client_id = c.id
     LEFT JOIN quotations q ON q.client_id = c.id
     WHERE ${where.join(' AND ')}
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM clients c WHERE ${where.join(' AND ')}`,
    filterParams
  );

  return { items: rows, total: Number(countRows[0]?.total ?? 0), page, limit };
}

// ── Get a single client with quotation + order history ────────────────────────
/**
 * → { client, orders, quotations, summary }
 *   client carries account_terms (+ account_terms_set_by_name / _set_at);
 *   summary = money across the client's orders (cancelled ones excluded):
 *   { orders, total, paid, outstanding } — amounts as numbers (rand).
 */
export async function getClientById(id) {
  const { rows } = await query(
    `SELECT c.*, s.name AS account_terms_set_by_name
     FROM clients c LEFT JOIN staff s ON s.id = c.account_terms_set_by
     WHERE c.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');

  const { rows: orders } = await query(
    'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC',
    [id]
  );
  const { rows: quotations } = await query(
    'SELECT * FROM quotations WHERE client_id = $1 ORDER BY created_at DESC',
    [id]
  );

  const { rows: [money] } = await query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(t.total), 0)                           AS total,
            COALESCE(SUM(t.paid), 0)                            AS paid,
            COALESCE(SUM(GREATEST(t.total - t.paid, 0)), 0)     AS outstanding
     FROM (
       SELECT COALESCE(o.total_amount, q.total, COALESCE(o.deposit_amount, 0) + COALESCE(o.balance_amount, 0), 0) AS total,
              (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id) AS paid
       FROM orders o LEFT JOIN quotations q ON q.id = o.quotation_id
       WHERE o.client_id = $1 AND o.cancelled_at IS NULL AND o.stage <> 'cancelled'
     ) t`,
    [id]
  );
  const summary = {
    orders: money.orders, total: Number(money.total), paid: Number(money.paid), outstanding: Number(money.outstanding),
  };

  return { client: rows[0], orders, quotations, summary };
}

// ── Account terms (no deposit before production) ────────────────────────────
/** Admin / manager marks a client as trading on account terms (or not); who and when are kept. */
export async function setAccountTerms(id, accountTerms, actor) {
  const { rows } = await query(
    `UPDATE clients
     SET account_terms = $2, account_terms_set_by = $3, account_terms_set_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, accountTerms, actor?.id ?? null]
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');
  return { ...rows[0], account_terms_set_by_name: actor?.name ?? null };
}

// ── The client's chat: open it, or start one ─────────────────────────────────
/**
 * The client's open conversation, or a new one (held by the bot until a
 * consultant takes it over). → { conversation, created }
 */
export async function openConversationForClient(clientId) {
  const { rows: clients } = await query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!clients.length) throw new HttpError(404, 'Client not found');
  const findOpen = () => query(
    'SELECT * FROM conversations WHERE client_id = $1 AND is_open = true ORDER BY created_at DESC LIMIT 1', [clientId]);
  const { rows: open } = await findOpen();
  if (open.length) return { conversation: open[0], created: false };
  try {
    const { rows } = await query(
      `INSERT INTO conversations (client_id, state, last_message_at) VALUES ($1, 'main_menu', NOW()) RETURNING *`, [clientId]);
    return { conversation: rows[0], created: true };
  } catch (err) {
    if (err.code !== '23505') throw err;   // another request opened one at the same moment
    const { rows } = await findOpen();
    return { conversation: rows[0], created: false };
  }
}

// ── Update a client from the dashboard (camelCase keys) ───────────────────────
export async function updateClient(id, data) {
  const fields = [];
  const params = [];

  for (const [key, col] of Object.entries(DASHBOARD_FIELD_MAP)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      fields.push(`${col} = $${params.length}`);
    }
  }
  if (!fields.length) throw new HttpError(400, 'No fields to update');

  params.push(id);
  const { rows } = await query(
    `UPDATE clients SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');
  return rows[0];
}
