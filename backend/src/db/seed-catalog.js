import { pool, query } from '../core/db.js';
import { logger } from '../core/logger.js';

// category must be a product_category enum value (see migrate.js / products.controller.js):
// school_wear | knitwear | medical_wear | outdoor_wear | corporate_wear | safety_wear
// There is no separate hospitality/security/branding category — those items sit
// under the closest garment category and are described accordingly.
const PLACEHOLDER_PRODUCTS = [
  { category: 'school_wear',    name: 'School Shirt — Short Sleeve',  sizes: ['6','8','10','12','14','16'] },
  { category: 'school_wear',    name: 'School Trousers',               sizes: ['6','8','10','12','14','16'] },
  { category: 'school_wear',    name: 'School Skirt',                  sizes: ['6','8','10','12','14','16'] },
  { category: 'corporate_wear', name: 'Corporate Shirt',               sizes: ['S','M','L','XL','XXL'] },
  { category: 'corporate_wear', name: 'Corporate Trousers',            sizes: ['S','M','L','XL','XXL'] },
  { category: 'corporate_wear', name: 'Chef Jacket',                   sizes: ['S','M','L','XL'],       description: 'Hospitality uniform' },
  { category: 'safety_wear',    name: 'Security Uniform Shirt',        sizes: ['S','M','L','XL','XXL'], description: 'Security uniform' },
  { category: 'corporate_wear', name: 'Embroidery (per item)',         sizes: [],                       description: 'Branding service — add as a line item alongside the garment' },
];

async function seedCatalog() {
  for (const p of PLACEHOLDER_PRODUCTS) {
    const existing = await query(
      'SELECT id FROM products WHERE category = $1 AND name = $2',
      [p.category, p.name]
    );
    if (existing.rows.length) {
      logger.info('Catalog item already exists, skipping', { name: p.name });
      continue;
    }
    await query(
      `INSERT INTO products (category, name, sizes, price, description)
       VALUES ($1, $2, $3, 0, $4)`,
      [p.category, p.name, JSON.stringify(p.sizes), p.description || null]
    );
    logger.info('Catalog item seeded (placeholder price — update via PATCH /api/products)', { name: p.name });
  }
  logger.warn('Placeholder catalog seeded with price = 0 for every item. Update real prices via PATCH /api/products/:id before going live.');
}

seedCatalog()
  .catch((err) => {
    logger.error('Catalog seed failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
