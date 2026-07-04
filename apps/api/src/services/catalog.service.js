import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// ── List products with optional filters ───────────────────────────────────────
export async function listProducts({ category, clientType } = {}) {
  let where = ['is_active = true'];
  const params = [];

  if (category)   { params.push(category);   where.push(`category = $${params.length}`); }
  if (clientType) { params.push(clientType); where.push(`(client_type = $${params.length} OR client_type IS NULL)`); }

  const { rows } = await query(
    `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY category, name`,
    params
  );
  return rows;
}

export async function getProductById(id) {
  const { rows } = await query('SELECT * FROM products WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Product not found');
  return rows[0];
}

export async function createProduct({ category, name, sizes, price, currency, clientType }) {
  const { rows } = await query(
    `INSERT INTO products (category, name, sizes, price, currency, client_type)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [category, name, JSON.stringify(sizes || []), price, currency || 'ZAR', clientType || null]
  );
  return rows[0];
}

const FIELD_MAP = {
  category: 'category', name: 'name', price: 'price',
  currency: 'currency', clientType: 'client_type', isActive: 'is_active',
};

export async function updateProduct(id, data) {
  const fields = [];
  const params = [];

  for (const [key, col] of Object.entries(FIELD_MAP)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      fields.push(`${col} = $${params.length}`);
    }
  }
  if (data.sizes !== undefined) {
    params.push(JSON.stringify(data.sizes));
    fields.push(`sizes = $${params.length}`);
  }
  if (!fields.length) throw new HttpError(400, 'No fields to update');

  params.push(id);
  const { rows } = await query(
    `UPDATE products SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Product not found');
  return rows[0];
}
