import { query, withTransaction } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// Columns the dashboard can update directly
const DASHBOARD_FIELD_MAP = {
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

async function nextCustomerNumber() {
  const { rows } = await query(
    `UPDATE sequence_counters SET value = value + 1
     WHERE key = 'customer' AND date_key = 'global'
     RETURNING value`
  );
  return `C-${String(rows[0].value).padStart(4, '0')}`;
}

// ── Find or create a client by WhatsApp number (bot entry point) ─────────────
export async function getOrCreateClientByWhatsapp(phoneNumber) {
  const { rows: existing } = await query(
    'SELECT * FROM clients WHERE whatsapp_number = $1',
    [phoneNumber]
  );
  if (existing.length) return existing[0];

  const customerNumber = await nextCustomerNumber();
  const { rows } = await query(
    `INSERT INTO clients (whatsapp_number, client_type, customer_number)
     VALUES ($1, 'retail', $2) RETURNING *`,
    [phoneNumber, customerNumber]
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

// ── List clients with search and pagination ──────────────────────────────────
export async function listClients({ search, clientType, page = 1, limit = 30 } = {}) {
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const where = ['1=1'];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(c.name ILIKE $${params.length} OR c.whatsapp_number ILIKE $${params.length} OR c.organisation ILIKE $${params.length})`
    );
  }
  if (clientType) { params.push(clientType); where.push(`c.client_type = $${params.length}`); }

  params.push(parseInt(limit)); params.push(offset);

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
  return rows;
}

// ── Get a single client with quotation + order history ────────────────────────
export async function getClientById(id) {
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Client not found');

  const { rows: orders } = await query(
    'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC',
    [id]
  );
  const { rows: quotations } = await query(
    'SELECT * FROM quotations WHERE client_id = $1 ORDER BY created_at DESC',
    [id]
  );

  return { client: rows[0], orders, quotations };
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
