import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

const FIELD_MAP = {
  name: 'name', email: 'email', clientType: 'client_type',
  organisation: 'organisation', contactPerson: 'contact_person', notes: 'notes',
  physicalAddress: 'physical_address', vatNumber: 'vat_number',
  preferredStoreLocation: 'preferred_store_location', schoolName: 'school_name',
};

// Required fields for a "complete" profile, per client type.
const REQUIRED_FIELDS = {
  retail:  ['name', 'preferredStoreLocation'],
  school:  ['name', 'schoolName'],
  default: ['organisation', 'physicalAddress'],
};

async function generateCustomerNumber() {
  const { rows } = await query(`SELECT nextval('clients_customer_seq') AS n`);
  return `BRQ-CUST-${String(rows[0].n).padStart(4, '0')}`;
}

// ── Find an existing client by WhatsApp number, or create one ────────────────
export async function getOrCreateClientByWhatsapp(phoneNumber) {
  const existing = await query('SELECT * FROM clients WHERE whatsapp_number = $1', [phoneNumber]);
  if (existing.rows.length > 0) return existing.rows[0];

  const customerNumber = await generateCustomerNumber();
  const created = await query(
    `INSERT INTO clients (whatsapp_number, client_type, customer_number)
     VALUES ($1, 'retail', $2) RETURNING *`,
    [phoneNumber, customerNumber]
  );
  return created.rows[0];
}

// ── Profile completeness check, used by the bot's registration gate ──────────
export function isProfileComplete(client) {
  const required = REQUIRED_FIELDS[client.client_type] || REQUIRED_FIELDS.default;
  const colMap = {
    name: 'name', preferredStoreLocation: 'preferred_store_location', schoolName: 'school_name',
    organisation: 'organisation', contactPerson: 'contact_person', physicalAddress: 'physical_address',
  };
  return required.every((f) => !!client[colMap[f]]);
}

// ── Update structured CRM fields, flips profile_complete when satisfied ──────
export async function updateClientProfile(clientId, fields) {
  const profileFieldMap = {
    name: 'name', physicalAddress: 'physical_address', vatNumber: 'vat_number',
    preferredStoreLocation: 'preferred_store_location', schoolName: 'school_name',
    organisation: 'organisation', contactPerson: 'contact_person',
  };

  const setFields = [];
  const params = [];
  for (const [key, col] of Object.entries(profileFieldMap)) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setFields.push(`${col} = $${params.length}`);
    }
  }
  if (!setFields.length) throw new HttpError(400, 'No profile fields to update');

  params.push(clientId);
  const { rows } = await query(
    `UPDATE clients SET ${setFields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');

  let client = rows[0];
  if (!client.profile_complete && isProfileComplete(client)) {
    const updated = await query(
      `UPDATE clients SET profile_complete = true WHERE id = $1 RETURNING *`,
      [clientId]
    );
    client = updated.rows[0];
  }
  return client;
}

// ── List clients with search and pagination ──────────────────────────────────
export async function listClients({ search, clientType, page = 1, limit = 30 }) {
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = ['1=1'];

  if (search) {
    params.push(`%${search}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.whatsapp_number ILIKE $${params.length} OR c.organisation ILIKE $${params.length})`);
  }
  if (clientType) { params.push(clientType); where.push(`c.client_type = $${params.length}`); }

  params.push(parseInt(limit)); params.push(offset);

  const { rows } = await query(
    `SELECT c.*, COUNT(o.id) AS total_orders
     FROM clients c
     LEFT JOIN orders o ON o.client_id = c.id
     WHERE ${where.join(' AND ')}
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// ── Get a single client with their order history ─────────────────────────────
export async function getClientById(id) {
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Client not found');

  const orders = await query(
    'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC',
    [id]
  );
  return { client: rows[0], orders: orders.rows };
}

// ── Update a client's details ─────────────────────────────────────────────────
export async function updateClient(id, data) {
  const fields = [];
  const params = [];

  for (const [key, col] of Object.entries(FIELD_MAP)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      fields.push(`${col} = $${params.length}`);
    }
  }
  if (!fields.length) throw new HttpError(400, 'No fields to update');

  params.push(id);
  const { rows } = await query(
    `UPDATE clients SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Client not found');
  return rows[0];
}
