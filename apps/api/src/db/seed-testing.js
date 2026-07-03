import { pool, query } from './pool.js';
import { logger } from '../utils/logger.js';

// ── Helper: insert product if it doesn't already exist ────────────────────────
async function insertProduct({ category, name, sizes, price, clientType = null }) {
  const { rows } = await query(
    'SELECT id FROM products WHERE category = $1 AND name = $2',
    [category, name]
  );
  if (rows.length) { logger.info(`  ~ skip (exists): ${name}`); return; }
  await query(
    `INSERT INTO products (category, name, sizes, price, currency, client_type, is_active)
     VALUES ($1, $2, $3, $4, 'ZAR', $5, true)`,
    [category, name, JSON.stringify(sizes), price, clientType]
  );
  logger.info(`  ✓ product: ${name}`);
}

// ── Helper: insert school catalog entry if it doesn't already exist ───────────
async function insertSchoolItem({ schoolName, uniformType, description, sizes, price, sortOrder = 0 }) {
  const { rows } = await query(
    'SELECT id FROM school_catalog WHERE school_name = $1 AND uniform_type = $2',
    [schoolName, uniformType]
  );
  if (rows.length) { logger.info(`  ~ skip (exists): ${schoolName} — ${uniformType}`); return; }
  await query(
    `INSERT INTO school_catalog (school_name, uniform_type, description, sizes, price, currency, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, 'ZAR', true, $6)`,
    [schoolName, uniformType, description, JSON.stringify(sizes), price, sortOrder]
  );
  logger.info(`  ✓ school item: ${schoolName} — ${uniformType}`);
}

// ════════════════════════════════════════════════════════════════════════════════
// 50 RETAIL PRODUCTS
// ════════════════════════════════════════════════════════════════════════════════
const RETAIL_PRODUCTS = [
  // ── T-Shirts ─────────────────────────────────────────────────────────────
  { category: 'T-Shirts', name: 'Classic Crew-Neck T-Shirt',           sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 89.99,  clientType: 'retail' },
  { category: 'T-Shirts', name: 'V-Neck T-Shirt',                      sizes: ['XS','S','M','L','XL','2XL'],        price: 99.99,  clientType: 'retail' },
  { category: 'T-Shirts', name: 'Long-Sleeve T-Shirt',                 sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 129.99, clientType: 'retail' },
  { category: 'T-Shirts', name: 'Heavy Cotton T-Shirt (220g)',          sizes: ['S','M','L','XL','2XL','3XL'],       price: 109.99, clientType: 'retail' },
  { category: 'T-Shirts', name: 'Performance Dry-Fit T-Shirt',         sizes: ['XS','S','M','L','XL','2XL'],        price: 149.99, clientType: 'retail' },

  // ── Polo / Golf Shirts ────────────────────────────────────────────────────
  { category: 'Polo Shirts', name: 'Classic Polo Shirt',               sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 159.99, clientType: 'retail' },
  { category: 'Polo Shirts', name: 'Premium Pique Polo Shirt',         sizes: ['XS','S','M','L','XL','2XL'],        price: 219.99, clientType: 'retail' },
  { category: 'Polo Shirts', name: 'Ladies Fitted Polo Shirt',         sizes: ['XS','S','M','L','XL','2XL'],        price: 169.99, clientType: 'retail' },
  { category: 'Polo Shirts', name: 'Golf Shirt (Moisture-Wicking)',    sizes: ['S','M','L','XL','2XL','3XL'],       price: 199.99, clientType: 'retail' },
  { category: 'Polo Shirts', name: 'Henley Collar Shirt',              sizes: ['S','M','L','XL','2XL'],             price: 179.99, clientType: 'retail' },

  // ── Hoodies & Sweaters ────────────────────────────────────────────────────
  { category: 'Hoodies', name: 'Pullover Hoodie',                      sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 299.99, clientType: 'retail' },
  { category: 'Hoodies', name: 'Zip-Up Hoodie',                        sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 349.99, clientType: 'retail' },
  { category: 'Hoodies', name: 'Crew-Neck Sweatshirt',                 sizes: ['XS','S','M','L','XL','2XL'],        price: 249.99, clientType: 'retail' },
  { category: 'Hoodies', name: 'Slim-Fit Pullover Hoodie',             sizes: ['XS','S','M','L','XL','2XL'],        price: 319.99, clientType: 'retail' },

  // ── Jackets ───────────────────────────────────────────────────────────────
  { category: 'Jackets', name: 'Softshell Jacket',                     sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 549.99, clientType: 'retail' },
  { category: 'Jackets', name: 'Windbreaker Jacket',                   sizes: ['XS','S','M','L','XL','2XL'],        price: 399.99, clientType: 'retail' },
  { category: 'Jackets', name: 'Fleece Jacket',                        sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 449.99, clientType: 'retail' },
  { category: 'Jackets', name: 'Padded Puffer Jacket',                 sizes: ['S','M','L','XL','2XL'],             price: 649.99, clientType: 'retail' },
  { category: 'Jackets', name: 'Nylon Rain Jacket',                    sizes: ['XS','S','M','L','XL','2XL'],        price: 479.99, clientType: 'retail' },

  // ── Pants & Shorts ────────────────────────────────────────────────────────
  { category: 'Pants',   name: 'Chino Work Trousers',                  sizes: ['28','30','32','34','36','38','40'],  price: 299.99, clientType: 'retail' },
  { category: 'Pants',   name: 'Cargo Pants',                          sizes: ['28','30','32','34','36','38','40'],  price: 329.99, clientType: 'retail' },
  { category: 'Pants',   name: 'Stretch Work Pants',                   sizes: ['28','30','32','34','36','38','40'],  price: 349.99, clientType: 'retail' },
  { category: 'Shorts',  name: 'Work Shorts',                          sizes: ['28','30','32','34','36','38'],       price: 199.99, clientType: 'retail' },
  { category: 'Shorts',  name: 'Sports Shorts (Mesh Lined)',           sizes: ['XS','S','M','L','XL','2XL'],        price: 149.99, clientType: 'retail' },

  // ── Ladies Wear ───────────────────────────────────────────────────────────
  { category: 'Ladies',  name: 'Ladies A-Line Skirt',                  sizes: ['XS','S','M','L','XL','2XL'],        price: 229.99, clientType: 'retail' },
  { category: 'Ladies',  name: 'Ladies Pencil Skirt',                  sizes: ['XS','S','M','L','XL'],              price: 259.99, clientType: 'retail' },
  { category: 'Ladies',  name: 'Ladies Shift Dress',                   sizes: ['XS','S','M','L','XL','2XL'],        price: 349.99, clientType: 'retail' },
  { category: 'Ladies',  name: 'Ladies Blouse',                        sizes: ['XS','S','M','L','XL','2XL'],        price: 199.99, clientType: 'retail' },

  // ── Tracksuits ────────────────────────────────────────────────────────────
  { category: 'Tracksuits', name: 'Tracksuit Top',                     sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 299.99, clientType: 'retail' },
  { category: 'Tracksuits', name: 'Tracksuit Pants',                   sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 249.99, clientType: 'retail' },
  { category: 'Tracksuits', name: 'Full Tracksuit Set',                sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 499.99, clientType: 'retail' },

  // ── Headwear ──────────────────────────────────────────────────────────────
  { category: 'Headwear', name: 'Baseball Cap (Structured)',           sizes: ['One Size'],                          price: 89.99,  clientType: 'retail' },
  { category: 'Headwear', name: 'Bucket Hat',                          sizes: ['One Size'],                          price: 79.99,  clientType: 'retail' },
  { category: 'Headwear', name: 'Beanie (Knit)',                       sizes: ['One Size'],                          price: 69.99,  clientType: 'retail' },
  { category: 'Headwear', name: 'Trucker Cap (Mesh Back)',             sizes: ['One Size'],                          price: 94.99,  clientType: 'retail' },

  // ── Aprons ────────────────────────────────────────────────────────────────
  { category: 'Aprons',   name: 'Bib Apron (100cm)',                   sizes: ['One Size'],                          price: 129.99, clientType: 'retail' },
  { category: 'Aprons',   name: 'Waist Apron (Short)',                 sizes: ['One Size'],                          price: 99.99,  clientType: 'retail' },
  { category: 'Aprons',   name: 'Cross-Back Apron',                   sizes: ['One Size'],                          price: 149.99, clientType: 'retail' },

  // ── Safety / Hi-Vis ───────────────────────────────────────────────────────
  { category: 'Safety',   name: 'Hi-Vis Safety Vest (Class 2)',        sizes: ['S','M','L','XL','2XL','3XL'],        price: 149.99, clientType: 'retail' },
  { category: 'Safety',   name: 'Hi-Vis Safety Jacket',                sizes: ['S','M','L','XL','2XL','3XL'],        price: 349.99, clientType: 'retail' },
  { category: 'Safety',   name: 'Boilersuit / Coverall',               sizes: ['S','M','L','XL','2XL','3XL'],        price: 499.99, clientType: 'retail' },

  // ── School Basics (retail) ────────────────────────────────────────────────
  { category: 'School',   name: 'Boys School Shirt (Short Sleeve)',    sizes: ['24','26','28','30','32','34','36'],   price: 149.99, clientType: 'retail' },
  { category: 'School',   name: 'Girls School Blouse (Short Sleeve)',  sizes: ['24','26','28','30','32','34','36'],   price: 149.99, clientType: 'retail' },
  { category: 'School',   name: 'School Pants (Boys)',                 sizes: ['24','26','28','30','32','34','36'],   price: 199.99, clientType: 'retail' },
  { category: 'School',   name: 'Girls School Skirt',                  sizes: ['24','26','28','30','32','34','36'],   price: 179.99, clientType: 'retail' },
  { category: 'School',   name: 'Girls School Dress (Pinafore)',       sizes: ['24','26','28','30','32','34','36'],   price: 219.99, clientType: 'retail' },
  { category: 'School',   name: 'School Jersey / Sweater',             sizes: ['24','26','28','30','32','34','36'],   price: 249.99, clientType: 'retail' },
  { category: 'School',   name: 'School Blazer',                       sizes: ['24','26','28','30','32','34','36'],   price: 599.99, clientType: 'retail' },
  { category: 'School',   name: 'School Tie',                          sizes: ['One Size'],                           price: 79.99,  clientType: 'retail' },
  { category: 'School',   name: 'School Sports Shorts',                sizes: ['24','26','28','30','32','34','36'],   price: 159.99, clientType: 'retail' },

  // ── Accessories ───────────────────────────────────────────────────────────
  { category: 'Accessories', name: 'Work Socks (Pack of 3)',           sizes: ['One Size'],                           price: 79.99,  clientType: 'retail' },
  { category: 'Accessories', name: 'Staff Lanyard with ID Holder',     sizes: ['One Size'],                           price: 49.99,  clientType: 'retail' },
];

// ════════════════════════════════════════════════════════════════════════════════
// 50 NON-RETAIL PRODUCTS  (corporate, hospitality, security, church, government,
//                          school custom, reseller)
// ════════════════════════════════════════════════════════════════════════════════
const OTHER_PRODUCTS = [
  // ── Corporate (15) ───────────────────────────────────────────────────────
  { category: 'Corporate Shirts',  name: 'Executive Golf Shirt',              sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 289.99, clientType: 'corporate' },
  { category: 'Corporate Shirts',  name: 'Classic Corporate Polo',            sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 249.99, clientType: 'corporate' },
  { category: 'Corporate Shirts',  name: 'Ladies Corporate Blouse',           sizes: ['XS','S','M','L','XL','2XL'],        price: 269.99, clientType: 'corporate' },
  { category: 'Corporate Shirts',  name: 'Corporate Dress Shirt (Men)',       sizes: ['S','M','L','XL','2XL','3XL'],       price: 349.99, clientType: 'corporate' },
  { category: 'Corporate Pants',   name: 'Corporate Trouser (Men)',           sizes: ['28','30','32','34','36','38','40'],  price: 449.99, clientType: 'corporate' },
  { category: 'Corporate Pants',   name: 'Corporate Skirt (Ladies)',          sizes: ['XS','S','M','L','XL','2XL'],        price: 369.99, clientType: 'corporate' },
  { category: 'Corporate Blazers', name: 'Corporate Blazer (Men)',            sizes: ['36','38','40','42','44','46'],       price: 849.99, clientType: 'corporate' },
  { category: 'Corporate Blazers', name: 'Corporate Blazer (Ladies)',         sizes: ['XS','S','M','L','XL','2XL'],        price: 799.99, clientType: 'corporate' },
  { category: 'Corporate Jackets', name: 'Corporate Softshell Jacket',        sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 699.99, clientType: 'corporate' },
  { category: 'Corporate Jackets', name: 'Corporate Windbreaker',             sizes: ['XS','S','M','L','XL','2XL'],        price: 599.99, clientType: 'corporate' },
  { category: 'Corporate Jackets', name: 'Corporate Fleece Jacket',           sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 549.99, clientType: 'corporate' },
  { category: 'Corporate Hoodies', name: 'Corporate Branded Hoodie',          sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 479.99, clientType: 'corporate' },
  { category: 'Corporate Acc.',    name: 'Corporate Branded Cap',             sizes: ['One Size'],                          price: 149.99, clientType: 'corporate' },
  { category: 'Corporate Acc.',    name: 'Corporate Branded Tie',             sizes: ['One Size'],                          price: 149.99, clientType: 'corporate' },
  { category: 'Corporate Acc.',    name: 'Corporate Lanyard (Woven)',         sizes: ['One Size'],                          price: 59.99,  clientType: 'corporate' },

  // ── Hospitality (10) ─────────────────────────────────────────────────────
  { category: 'Chef Wear',         name: 'Chef Jacket (White, Double-Breasted)', sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 349.99, clientType: 'hospitality' },
  { category: 'Chef Wear',         name: 'Chef Jacket (Black)',               sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 349.99, clientType: 'hospitality' },
  { category: 'Chef Wear',         name: 'Chef Pants (Houndstooth Check)',    sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 249.99, clientType: 'hospitality' },
  { category: 'Chef Wear',         name: 'Chef Hat (Toque)',                  sizes: ['One Size'],                          price: 89.99,  clientType: 'hospitality' },
  { category: 'Chef Wear',         name: 'Kitchen Bib Apron',                 sizes: ['One Size'],                          price: 129.99, clientType: 'hospitality' },
  { category: 'Waiter Wear',       name: 'Waiter Shirt (Black)',              sizes: ['XS','S','M','L','XL','2XL'],        price: 229.99, clientType: 'hospitality' },
  { category: 'Waiter Wear',       name: 'Waiter Waist Apron',                sizes: ['One Size'],                          price: 149.99, clientType: 'hospitality' },
  { category: 'Waiter Wear',       name: 'Hospitality Polo Shirt',            sizes: ['XS','S','M','L','XL','2XL'],        price: 229.99, clientType: 'hospitality' },
  { category: 'Waiter Wear',       name: 'Waiter Waistcoat (Vest)',           sizes: ['XS','S','M','L','XL','2XL'],        price: 279.99, clientType: 'hospitality' },
  { category: 'Waiter Wear',       name: 'Hospitality Ladies Dress (Shift)',  sizes: ['XS','S','M','L','XL','2XL'],        price: 379.99, clientType: 'hospitality' },

  // ── Security (8) ─────────────────────────────────────────────────────────
  { category: 'Security',          name: 'Security Shirt (Navy Long-Sleeve)', sizes: ['S','M','L','XL','2XL','3XL'],       price: 229.99, clientType: 'security' },
  { category: 'Security',          name: 'Security Pants (Navy)',             sizes: ['28','30','32','34','36','38','40'],  price: 299.99, clientType: 'security' },
  { category: 'Security',          name: 'Security Jacket (Bomber)',          sizes: ['S','M','L','XL','2XL','3XL'],       price: 549.99, clientType: 'security' },
  { category: 'Security',          name: 'Security Peak Cap',                 sizes: ['One Size'],                          price: 149.99, clientType: 'security' },
  { category: 'Security',          name: 'Security Padded Gilet (Vest)',      sizes: ['S','M','L','XL','2XL','3XL'],       price: 399.99, clientType: 'security' },
  { category: 'Security',          name: 'Hi-Vis Security Vest',              sizes: ['S','M','L','XL','2XL','3XL'],       price: 179.99, clientType: 'security' },
  { category: 'Security',          name: 'Security Tie',                      sizes: ['One Size'],                          price: 99.99,  clientType: 'security' },
  { category: 'Security',          name: 'Security Epaulettes (Pair)',        sizes: ['One Size'],                          price: 79.99,  clientType: 'security' },

  // ── Church (6) ───────────────────────────────────────────────────────────
  { category: 'Church',            name: 'Choir Robe (White)',                sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 499.99, clientType: 'church' },
  { category: 'Church',            name: 'Choir Robe (Royal Blue)',           sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 499.99, clientType: 'church' },
  { category: 'Church',            name: 'Choir Robe (Maroon)',               sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 499.99, clientType: 'church' },
  { category: 'Church',            name: 'Choir Sash / Stole',                sizes: ['One Size'],                          price: 149.99, clientType: 'church' },
  { category: 'Church',            name: 'Ministry T-Shirt',                  sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 149.99, clientType: 'church' },
  { category: 'Church',            name: 'Church Branded Cap',                sizes: ['One Size'],                          price: 99.99,  clientType: 'church' },

  // ── Government (6) ───────────────────────────────────────────────────────
  { category: 'Government',        name: 'Government Uniform Shirt',          sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 299.99, clientType: 'government' },
  { category: 'Government',        name: 'Government Uniform Pants',          sizes: ['28','30','32','34','36','38','40'],  price: 399.99, clientType: 'government' },
  { category: 'Government',        name: 'Government Ladies Skirt',           sizes: ['XS','S','M','L','XL','2XL'],        price: 329.99, clientType: 'government' },
  { category: 'Government',        name: 'Government Utility Jacket',         sizes: ['XS','S','M','L','XL','2XL','3XL'],  price: 699.99, clientType: 'government' },
  { category: 'Government',        name: 'Government Tie',                    sizes: ['One Size'],                          price: 129.99, clientType: 'government' },
  { category: 'Government',        name: 'Government Peak Cap',               sizes: ['One Size'],                          price: 179.99, clientType: 'government' },

  // ── School (custom bulk) (5) ──────────────────────────────────────────────
  { category: 'School Custom',     name: 'School Sports Jersey (Custom)',     sizes: ['24','26','28','30','32','34','36'],  price: 229.99, clientType: 'school' },
  { category: 'School Custom',     name: 'School Sports Shorts (Custom)',     sizes: ['24','26','28','30','32','34','36'],  price: 169.99, clientType: 'school' },
  { category: 'School Custom',     name: 'School Tracksuit Set (Branded)',    sizes: ['24','26','28','30','32','34','36'],  price: 599.99, clientType: 'school' },
  { category: 'School Custom',     name: 'School Swimwear (One-Piece)',       sizes: ['24','26','28','30','32','34','36'],  price: 249.99, clientType: 'school' },
  { category: 'School Custom',     name: 'School Custom Blazer',              sizes: ['24','26','28','30','32','34','36'],  price: 849.99, clientType: 'school' },

  // ── Reseller bulk blanks (5) ──────────────────────────────────────────────
  { category: 'Bulk Blanks',       name: 'Blank T-Shirt Bulk Pack (12 units)', sizes: ['S','M','L','XL','2XL'],           price: 799.99,  clientType: 'reseller' },
  { category: 'Bulk Blanks',       name: 'Blank Polo Shirt Bulk Pack (12 units)', sizes: ['S','M','L','XL','2XL'],        price: 1399.99, clientType: 'reseller' },
  { category: 'Bulk Blanks',       name: 'Blank Hoodie Bulk Pack (6 units)',  sizes: ['S','M','L','XL','2XL'],            price: 1499.99, clientType: 'reseller' },
  { category: 'Bulk Blanks',       name: 'Blank Cap Bulk Pack (12 units)',    sizes: ['One Size'],                         price: 699.99,  clientType: 'reseller' },
  { category: 'Bulk Blanks',       name: 'Blank Jacket Bulk Pack (6 units)',  sizes: ['S','M','L','XL','2XL'],            price: 2499.99, clientType: 'reseller' },
];

// ════════════════════════════════════════════════════════════════════════════════
// SCHOOL CATALOG  (6 schools × ~6–8 items each)
// ════════════════════════════════════════════════════════════════════════════════
const SCHOOL_CATALOG = [

  // ── Greenside High School ─────────────────────────────────────────────────
  { schoolName: 'Greenside High School', uniformType: 'Boys Summer Shirt (White)',        description: 'Short-sleeve white shirt with school crest embroidery',     sizes: ['26','28','30','32','34','36','38'], price: 179.99, sortOrder: 1 },
  { schoolName: 'Greenside High School', uniformType: 'Boys Winter Shirt (Long-Sleeve)',  description: 'Long-sleeve white shirt with school crest',                  sizes: ['26','28','30','32','34','36','38'], price: 199.99, sortOrder: 2 },
  { schoolName: 'Greenside High School', uniformType: 'Boys Grey Trousers',               description: 'Mid-grey school trousers, flat front',                       sizes: ['26','28','30','32','34','36','38'], price: 279.99, sortOrder: 3 },
  { schoolName: 'Greenside High School', uniformType: 'Girls Summer Blouse',              description: 'Short-sleeve white blouse with crest',                       sizes: ['26','28','30','32','34','36','38'], price: 179.99, sortOrder: 4 },
  { schoolName: 'Greenside High School', uniformType: 'Girls Grey Skirt',                 description: 'A-line grey skirt, knee length',                             sizes: ['26','28','30','32','34','36'],      price: 229.99, sortOrder: 5 },
  { schoolName: 'Greenside High School', uniformType: 'School Jersey (Grey)',              description: 'V-neck grey jersey with school stripe on collar',             sizes: ['26','28','30','32','34','36','38'], price: 299.99, sortOrder: 6 },
  { schoolName: 'Greenside High School', uniformType: 'School Blazer (Navy)',              description: 'Navy blazer with school badge, fully lined',                 sizes: ['26','28','30','32','34','36','38'], price: 699.99, sortOrder: 7 },
  { schoolName: 'Greenside High School', uniformType: 'School Tie',                        description: 'Striped school tie (navy/gold)',                             sizes: ['One Size'],                          price: 89.99,  sortOrder: 8 },

  // ── Rosebank Primary School ───────────────────────────────────────────────
  { schoolName: 'Rosebank Primary School', uniformType: 'Boys Summer Shorts (Khaki)',    description: 'Khaki cotton shorts with school logo tab',                   sizes: ['24','26','28','30','32','34'],       price: 189.99, sortOrder: 1 },
  { schoolName: 'Rosebank Primary School', uniformType: 'Boys Long Trousers (Khaki)',    description: 'Khaki trousers for winter term',                             sizes: ['24','26','28','30','32','34'],       price: 249.99, sortOrder: 2 },
  { schoolName: 'Rosebank Primary School', uniformType: 'Boys Polo Shirt (Green)',       description: 'Forest green polo with embroidered school crest',             sizes: ['24','26','28','30','32','34'],       price: 189.99, sortOrder: 3 },
  { schoolName: 'Rosebank Primary School', uniformType: 'Girls Dress (Green Check)',     description: 'Green/white check summer dress',                             sizes: ['24','26','28','30','32','34'],       price: 259.99, sortOrder: 4 },
  { schoolName: 'Rosebank Primary School', uniformType: 'Girls Skirt & Blouse Set',      description: 'Khaki skirt with green polo blouse',                         sizes: ['24','26','28','30','32','34'],       price: 329.99, sortOrder: 5 },
  { schoolName: 'Rosebank Primary School', uniformType: 'School Hoodie (Green)',          description: 'Green pullover hoodie with school name print',               sizes: ['24','26','28','30','32','34'],       price: 279.99, sortOrder: 6 },

  // ── St Dominics College ───────────────────────────────────────────────────
  { schoolName: 'St Dominics College',     uniformType: 'Boys Formal Shirt (White)',     description: 'White long-sleeve formal shirt with college crest',          sizes: ['28','30','32','34','36','38','40'], price: 199.99, sortOrder: 1 },
  { schoolName: 'St Dominics College',     uniformType: 'Boys Formal Trousers (Black)', description: 'Black formal school trousers',                               sizes: ['28','30','32','34','36','38','40'], price: 299.99, sortOrder: 2 },
  { schoolName: 'St Dominics College',     uniformType: 'Girls Formal Blouse',           description: 'White formal blouse with pin-tuck front',                   sizes: ['28','30','32','34','36','38'],      price: 199.99, sortOrder: 3 },
  { schoolName: 'St Dominics College',     uniformType: 'Girls Formal Skirt (Black)',   description: 'Black A-line formal skirt, below knee',                     sizes: ['28','30','32','34','36','38'],      price: 259.99, sortOrder: 4 },
  { schoolName: 'St Dominics College',     uniformType: 'College Blazer (Black & Gold)',description: 'Prestige black blazer with gold trim and emblem',            sizes: ['28','30','32','34','36','38','40'], price: 899.99, sortOrder: 5 },
  { schoolName: 'St Dominics College',     uniformType: 'College Jersey (V-Neck)',       description: 'Black V-neck jersey with gold stripe trim',                 sizes: ['28','30','32','34','36','38','40'], price: 329.99, sortOrder: 6 },
  { schoolName: 'St Dominics College',     uniformType: 'College Tie (Black/Gold)',      description: 'Black and gold striped tie',                                sizes: ['One Size'],                          price: 99.99,  sortOrder: 7 },

  // ── Crawford International Schools ───────────────────────────────────────
  { schoolName: 'Crawford International', uniformType: 'Polo Shirt (Red)',               description: 'Red polo with Crawford International logo embroidered',     sizes: ['24','26','28','30','32','34','36','38'], price: 199.99, sortOrder: 1 },
  { schoolName: 'Crawford International', uniformType: 'Boys Shorts (Grey)',              description: 'Grey school shorts',                                        sizes: ['24','26','28','30','32','34'],           price: 179.99, sortOrder: 2 },
  { schoolName: 'Crawford International', uniformType: 'Boys Trousers (Grey)',            description: 'Grey long trousers for winter',                             sizes: ['24','26','28','30','32','34','36','38'], price: 249.99, sortOrder: 3 },
  { schoolName: 'Crawford International', uniformType: 'Girls Skirt (Grey)',              description: 'Grey pleated skirt',                                        sizes: ['24','26','28','30','32','34','36'],      price: 219.99, sortOrder: 4 },
  { schoolName: 'Crawford International', uniformType: 'Girls Summer Dress',              description: 'Red/white stripe summer dress',                             sizes: ['24','26','28','30','32','34','36'],      price: 269.99, sortOrder: 5 },
  { schoolName: 'Crawford International', uniformType: 'School Fleece Jacket (Red)',      description: 'Red fleece with full zip and logo',                         sizes: ['24','26','28','30','32','34','36','38'], price: 369.99, sortOrder: 6 },
  { schoolName: 'Crawford International', uniformType: 'PE Kit (Shorts + T-Shirt)',       description: 'Red PE shorts and white T-shirt with logo',                 sizes: ['24','26','28','30','32','34','36','38'], price: 299.99, sortOrder: 7 },

  // ── Curro Holdings Schools ────────────────────────────────────────────────
  { schoolName: 'Curro Schools',           uniformType: 'Polo Shirt (Maroon)',            description: 'Maroon polo with Curro branding',                          sizes: ['24','26','28','30','32','34','36','38'], price: 189.99, sortOrder: 1 },
  { schoolName: 'Curro Schools',           uniformType: 'Boys Chino Shorts (Beige)',      description: 'Beige chino-style school shorts',                          sizes: ['24','26','28','30','32','34','36'],      price: 199.99, sortOrder: 2 },
  { schoolName: 'Curro Schools',           uniformType: 'Boys Chino Trousers (Beige)',    description: 'Beige chino-style trousers, formal cut',                   sizes: ['24','26','28','30','32','34','36','38'], price: 269.99, sortOrder: 3 },
  { schoolName: 'Curro Schools',           uniformType: 'Girls Skirt (Beige)',            description: 'Beige A-line skirt',                                       sizes: ['24','26','28','30','32','34','36'],      price: 229.99, sortOrder: 4 },
  { schoolName: 'Curro Schools',           uniformType: 'School Softshell Jacket (Maroon)', description: 'Maroon branded softshell jacket',                        sizes: ['24','26','28','30','32','34','36','38'], price: 399.99, sortOrder: 5 },
  { schoolName: 'Curro Schools',           uniformType: 'PE Shorts (Black)',              description: 'Black mesh PE shorts with Curro print',                   sizes: ['24','26','28','30','32','34','36','38'], price: 169.99, sortOrder: 6 },

  // ── Trinity Academy ───────────────────────────────────────────────────────
  { schoolName: 'Trinity Academy',         uniformType: 'Polo Shirt (Navy/White)',        description: 'Navy polo with white trim and crest embroidery',            sizes: ['24','26','28','30','32','34','36','38'], price: 199.99, sortOrder: 1 },
  { schoolName: 'Trinity Academy',         uniformType: 'Boys Long Pants (Navy)',         description: 'Navy formal trousers',                                     sizes: ['24','26','28','30','32','34','36','38'], price: 259.99, sortOrder: 2 },
  { schoolName: 'Trinity Academy',         uniformType: 'Boys Shorts (Navy)',             description: 'Navy school shorts',                                       sizes: ['24','26','28','30','32','34'],           price: 189.99, sortOrder: 3 },
  { schoolName: 'Trinity Academy',         uniformType: 'Girls Pinafore Dress (Navy)',    description: 'Navy pinafore dress over white shirt',                     sizes: ['24','26','28','30','32','34','36'],      price: 249.99, sortOrder: 4 },
  { schoolName: 'Trinity Academy',         uniformType: 'Girls Skirt (Navy)',             description: 'Navy pleated skirt',                                       sizes: ['24','26','28','30','32','34','36'],      price: 219.99, sortOrder: 5 },
  { schoolName: 'Trinity Academy',         uniformType: 'School Hoodie (Navy)',           description: 'Navy pullover hoodie with Trinity Academy print',           sizes: ['24','26','28','30','32','34','36','38'], price: 299.99, sortOrder: 6 },
  { schoolName: 'Trinity Academy',         uniformType: 'Sports Tracksuit Set',           description: 'Navy tracksuit top and pants with white stripes',          sizes: ['24','26','28','30','32','34','36','38'], price: 549.99, sortOrder: 7 },
];

// ════════════════════════════════════════════════════════════════════════════════
// RUNNER
// ════════════════════════════════════════════════════════════════════════════════
async function seedTesting() {
  logger.info('═══════════════════════════════════════════════');
  logger.info('Seeding RETAIL products (50)...');
  for (const p of RETAIL_PRODUCTS) await insertProduct(p);

  logger.info('');
  logger.info('Seeding NON-RETAIL products (50)...');
  for (const p of OTHER_PRODUCTS) await insertProduct(p);

  logger.info('');
  logger.info('Seeding SCHOOL CATALOG...');
  for (const s of SCHOOL_CATALOG) await insertSchoolItem(s);

  logger.info('');
  logger.info('═══════════════════════════════════════════════');
  logger.info(`Done.`);
  logger.info(`  Retail products  : ${RETAIL_PRODUCTS.length}`);
  logger.info(`  Other products   : ${OTHER_PRODUCTS.length}`);
  logger.info(`  School catalog   : ${SCHOOL_CATALOG.length} items across 6 schools`);
  logger.info('  All prices in ZAR');
}

seedTesting()
  .catch((err) => {
    logger.error('Testing seed failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
