import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

const VALID_COLUMNS = new Set(['name', 'category', 'school_name', 'price', 'currency', 'description', 'is_active']);

// ── List products with optional filters ───────────────────────────────────────
export async function listProducts({ category, activeOnly, schoolName } = {}) {
  const where = [];
  const params = [];

  if (activeOnly) where.push('is_active = true');
  if (category)   { params.push(category);   where.push(`category = $${params.length}`); }
  if (schoolName) { params.push(schoolName); where.push(`school_name = $${params.length}`); }

  const { rows } = await query(
    `SELECT * FROM products
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY category, name`,
    params
  );
  return rows;
}

export async function getProductById(id) {
  const { rows } = await query('SELECT * FROM products WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Product not found');
  return rows[0];
}

export async function createProduct({ category, name, schoolName, sizes, price, currency, description, isActive }) {
  const { rows } = await query(
    `INSERT INTO products (category, name, school_name, sizes, price, currency, description, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      category, name, schoolName || null,
      JSON.stringify(sizes || []), price, currency || 'ZAR',
      description || null, isActive !== false,
    ]
  );
  return rows[0];
}

export async function updateProduct(id, data) {
  const fields = [];
  const params = [];

  const fieldMap = {
    name: 'name', category: 'category', schoolName: 'school_name',
    price: 'price', currency: 'currency', description: 'description', isActive: 'is_active',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
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
    `UPDATE products SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Product not found');
  return rows[0];
}

// ── School-specific helpers (used by bot) ─────────────────────────────────────

export async function listSchoolNames() {
  const { rows } = await query(
    `SELECT DISTINCT school_name FROM products
     WHERE category = 'school_wear' AND school_name IS NOT NULL AND is_active = true
     ORDER BY school_name`
  );
  return rows.map((r) => r.school_name);
}

export async function listProductsBySchool(schoolName) {
  const { rows } = await query(
    `SELECT * FROM products
     WHERE category = 'school_wear' AND school_name = $1 AND is_active = true
     ORDER BY name`,
    [schoolName]
  );
  return rows;
}
