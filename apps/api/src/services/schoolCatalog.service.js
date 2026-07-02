import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// ── List all distinct school names (active entries only) ──────────────────────
export async function listDistinctSchools() {
  const { rows } = await query(
    `SELECT DISTINCT school_name FROM school_catalog
     WHERE is_active = true ORDER BY school_name`
  );
  return rows.map(r => r.school_name);
}

// ── List all uniform entries for a given school ───────────────────────────────
export async function listUniformsForSchool(schoolName) {
  const { rows } = await query(
    `SELECT * FROM school_catalog
     WHERE school_name = $1 AND is_active = true
     ORDER BY sort_order, uniform_type`,
    [schoolName]
  );
  return rows;
}

// ── List all entries (for dashboard management) ───────────────────────────────
export async function listAll({ school } = {}) {
  const params = [];
  const where = school ? [`school_name = $${params.push(school)}`] : [];
  const { rows } = await query(
    `SELECT * FROM school_catalog
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY school_name, sort_order, uniform_type`,
    params
  );
  return rows;
}

// ── Create a school uniform entry ─────────────────────────────────────────────
export async function create({ schoolName, uniformType, description, sizes, price, currency, sortOrder }) {
  const { rows } = await query(
    `INSERT INTO school_catalog (school_name, uniform_type, description, sizes, price, currency, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [schoolName, uniformType, description || null, JSON.stringify(sizes || []), price, currency || 'ZAR', sortOrder || 0]
  );
  return rows[0];
}

// ── Update a school uniform entry ─────────────────────────────────────────────
export async function update(id, data) {
  const FIELD_MAP = {
    schoolName:  'school_name',
    uniformType: 'uniform_type',
    description: 'description',
    price:       'price',
    currency:    'currency',
    isActive:    'is_active',
    sortOrder:   'sort_order',
  };

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
    `UPDATE school_catalog SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'School catalog entry not found');
  return rows[0];
}

// ── Delete a school uniform entry ─────────────────────────────────────────────
export async function remove(id) {
  const { rows } = await query(
    `DELETE FROM school_catalog WHERE id = $1 RETURNING id`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'School catalog entry not found');
}
