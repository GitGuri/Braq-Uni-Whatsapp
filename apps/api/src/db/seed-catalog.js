import { pool, query } from './pool.js';
import { logger } from '../utils/logger.js';

const PLACEHOLDER_PRODUCTS = [
  { category: 'school',   name: 'School Shirt — Short Sleeve',  sizes: ['6','8','10','12','14','16'], price: 0, clientType: 'school' },
  { category: 'school',   name: 'School Trousers',               sizes: ['6','8','10','12','14','16'], price: 0, clientType: 'school' },
  { category: 'school',   name: 'School Skirt',                  sizes: ['6','8','10','12','14','16'], price: 0, clientType: 'school' },
  { category: 'corporate', name: 'Corporate Shirt',               sizes: ['S','M','L','XL','XXL'],       price: 0, clientType: 'corporate' },
  { category: 'corporate', name: 'Corporate Trousers',            sizes: ['S','M','L','XL','XXL'],       price: 0, clientType: 'corporate' },
  { category: 'hospitality', name: 'Chef Jacket',                 sizes: ['S','M','L','XL'],              price: 0, clientType: 'hospitality' },
  { category: 'security', name: 'Security Uniform Shirt',         sizes: ['S','M','L','XL','XXL'],        price: 0, clientType: 'security' },
  { category: 'branding', name: 'Embroidery (per item)',          sizes: [],                              price: 0 },
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
      `INSERT INTO products (category, name, sizes, price, client_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.category, p.name, JSON.stringify(p.sizes), p.price, p.clientType || null]
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
