/**
 * Testing seed — Braq Connect™ new schema
 * Populates: staff, products, clients, quotations, orders, payments, tickets, conversations, messages
 * Safe to re-run: uses ON CONFLICT DO NOTHING / skip-if-exists guards.
 */
import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';
import { logger } from '../utils/logger.js';

// ── helpers ────────────────────────────────────────────────────────────────────
const calc = (items) => {
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const vat      = parseFloat((subtotal * 0.15).toFixed(2));
  return { subtotal: parseFloat(subtotal.toFixed(2)), vat, total: parseFloat((subtotal + vat).toFixed(2)) };
};

const item = (name, qty, price, category = 'corporate_wear') => ({
  name, quantity: qty, price, lineTotal: parseFloat((qty * price).toFixed(2)), category,
});

async function skip(table, whereCol, whereVal) {
  const { rows } = await query(`SELECT id FROM ${table} WHERE ${whereCol} = $1`, [whereVal]);
  return rows.length > 0;
}

// ── 1. STAFF ──────────────────────────────────────────────────────────────────
async function seedStaff() {
  logger.info('Seeding staff…');
  const PASS = await bcrypt.hash('Braq@2025!', 12);

  const members = [
    { name: 'Thabo Nkosi',         email: 'thabo@braquni.com',    role: 'admin' },
    { name: 'Lerato Sithole',       email: 'lerato@braquni.com',   role: 'consultant' },
    { name: 'Sipho Mahlangu',       email: 'sipho@braquni.com',    role: 'consultant' },
    { name: 'Priya Naidoo',         email: 'priya@braquni.com',    role: 'consultant' },
    { name: 'Zanele Dlamini',       email: 'zanele@braquni.com',   role: 'consultant' },
    { name: 'Ruan van der Merwe',   email: 'ruan@braquni.com',     role: 'consultant' },
  ];

  for (const m of members) {
    if (await skip('staff', 'email', m.email)) { logger.info(`  ~ skip: ${m.email}`); continue; }
    await query(
      `INSERT INTO staff (name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      [m.name, m.email, PASS, m.role]
    );
    logger.info(`  ✓ staff: ${m.name} (${m.role})`);
  }
}

// ── 2. PRODUCTS ───────────────────────────────────────────────────────────────
async function seedProducts() {
  logger.info('Seeding products…');

  const products = [
    // school_wear — Laerskool Dalview
    { category: 'school_wear', name: 'School Polo Shirt (Navy)',    school_name: 'Laerskool Dalview',  sizes: ['4','6','8','10','12','14'],           price: 189.99, description: 'Navy polo with embroidered school crest' },
    { category: 'school_wear', name: 'School Shorts (Grey)',         school_name: 'Laerskool Dalview',  sizes: ['4','6','8','10','12','14'],           price: 159.99, description: 'Mid-grey school shorts' },
    { category: 'school_wear', name: 'School Skirt (Grey)',          school_name: 'Laerskool Dalview',  sizes: ['4','6','8','10','12','14'],           price: 169.99, description: 'A-line grey school skirt' },
    { category: 'school_wear', name: 'School Jersey (Navy V-Neck)',  school_name: 'Laerskool Dalview',  sizes: ['4','6','8','10','12','14'],           price: 249.99, description: 'Navy V-neck jersey with school stripe' },
    // school_wear — Hoerskool Stoffberg
    { category: 'school_wear', name: 'School Polo (Green)',          school_name: 'Hoerskool Stoffberg', sizes: ['28','30','32','34','36','38'],        price: 199.99, description: 'Forest green polo with embroidered crest' },
    { category: 'school_wear', name: 'School Pants (Dark Grey)',     school_name: 'Hoerskool Stoffberg', sizes: ['28','30','32','34','36','38','40'],   price: 279.99, description: 'Dark grey formal school trousers' },
    // school_wear — generic
    { category: 'school_wear', name: 'School Blazer',                school_name: null,                  sizes: ['24','26','28','30','32','34','36','38'], price: 649.99, description: 'Fully lined school blazer — customised per school' },

    // knitwear
    { category: 'knitwear', name: 'Pullover Hoodie (310g)',        school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 299.99, description: 'Heavyweight cotton-fleece pullover hoodie' },
    { category: 'knitwear', name: 'Zip-Up Hoodie',                 school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 349.99, description: 'Full-zip hoodie with front pockets' },
    { category: 'knitwear', name: 'Crew-Neck Sweatshirt',          school_name: null, sizes: ['XS','S','M','L','XL','2XL'],        price: 249.99, description: '300g fleece crew-neck sweatshirt' },
    { category: 'knitwear', name: 'Knit Jersey (V-Neck)',           school_name: null, sizes: ['XS','S','M','L','XL','2XL'],        price: 229.99, description: 'Acrylic blend V-neck jersey' },

    // medical_wear
    { category: 'medical_wear', name: 'Medical Scrub Top',           school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 249.99, description: 'Poly-cotton medical scrub top — multiple colour options' },
    { category: 'medical_wear', name: 'Medical Scrub Pants',         school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 229.99, description: 'Drawstring scrub pants with side pockets' },
    { category: 'medical_wear', name: 'Medical Lab Coat',            school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 399.99, description: 'Long white lab coat with 3 pockets' },

    // outdoor_wear
    { category: 'outdoor_wear', name: 'Softshell Jacket',            school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 549.99, description: 'Water-resistant softshell, 3-layer bonded' },
    { category: 'outdoor_wear', name: 'Windbreaker Jacket',          school_name: null, sizes: ['XS','S','M','L','XL','2XL'],        price: 399.99, description: 'Lightweight packable windbreaker' },
    { category: 'outdoor_wear', name: 'Hi-Vis Safety Vest (Class 2)',school_name: null, sizes: ['S','M','L','XL','2XL','3XL'],       price: 149.99, description: 'SABS-compliant high-visibility mesh vest' },
    { category: 'outdoor_wear', name: 'Fleece Jacket',               school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 449.99, description: 'Anti-pill 300g micro fleece full-zip jacket' },

    // corporate_wear
    { category: 'corporate_wear', name: 'Classic Corporate Polo',     school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 249.99, description: 'Pique cotton polo for corporate branding' },
    { category: 'corporate_wear', name: 'Executive Golf Shirt',        school_name: null, sizes: ['XS','S','M','L','XL','2XL','3XL'], price: 289.99, description: 'Moisture-wicking executive golf shirt' },
    { category: 'corporate_wear', name: 'Corporate Blazer (Men)',      school_name: null, sizes: ['36','38','40','42','44','46'],       price: 849.99, description: 'Fully lined corporate blazer with satin lining' },
    { category: 'corporate_wear', name: 'Ladies Corporate Blouse',     school_name: null, sizes: ['XS','S','M','L','XL','2XL'],        price: 269.99, description: 'Satin-weave ladies corporate blouse' },
    { category: 'corporate_wear', name: 'Corporate Trouser (Men)',     school_name: null, sizes: ['28','30','32','34','36','38','40'], price: 449.99, description: 'Flat-front formal trouser with stretch waistband' },

    // safety_wear
    { category: 'safety_wear', name: 'Hi-Vis Safety Jacket',          school_name: null, sizes: ['S','M','L','XL','2XL','3XL'],       price: 349.99, description: 'Class 3 high-visibility bomber jacket' },
    { category: 'safety_wear', name: 'Boilersuit / Coverall',         school_name: null, sizes: ['S','M','L','XL','2XL','3XL'],       price: 499.99, description: 'Cotton-polyester boilersuit with zip front' },
    { category: 'safety_wear', name: 'Safety Hard Hat (Type 1)',      school_name: null, sizes: ['One Size'],                          price: 199.99, description: 'SABS-approved industrial hard hat' },
  ];

  for (const p of products) {
    const { rows } = await query(
      `SELECT id FROM products WHERE category = $1 AND name = $2 AND (school_name IS NULL AND $3::text IS NULL OR school_name = $3)`,
      [p.category, p.name, p.school_name]
    );
    if (rows.length) { logger.info(`  ~ skip: ${p.name}`); continue; }
    await query(
      `INSERT INTO products (category, name, school_name, sizes, price, currency, description, is_active)
       VALUES ($1,$2,$3,$4,$5,'ZAR',$6,true)`,
      [p.category, p.name, p.school_name, JSON.stringify(p.sizes), p.price, p.description]
    );
    logger.info(`  ✓ product: ${p.name}`);
  }
}

// ── 3. CLIENTS ────────────────────────────────────────────────────────────────
async function seedClients() {
  logger.info('Seeding clients…');

  const clients = [
    {
      whatsapp_number: '27821234567', name: 'Nomsa Khumalo',       client_type: 'retail',
      physical_address: '14 Voortrekker Rd, Brakpan', customer_number: 'C-0001',
      school_name: null, organisation: null, profile_complete: true,
    },
    {
      whatsapp_number: '27829876543', name: 'David van Tonder',    client_type: 'retail',
      physical_address: '7 Main St, Springs', customer_number: 'C-0002',
      school_name: null, organisation: null, profile_complete: true,
    },
    {
      whatsapp_number: '27831112233', name: 'Mpho Pieterse',       client_type: 'school',
      physical_address: '1 Dalview Rd, Brakpan', customer_number: 'C-0003',
      school_name: 'Laerskool Dalview', organisation: null, profile_complete: true,
    },
    {
      whatsapp_number: '27834445566', name: 'Bongani Mokoena',     client_type: 'corporate',
      physical_address: '22 Rand Show Rd, Johannesburg', customer_number: 'C-0004',
      school_name: null, organisation: 'TechCorp SA', profile_complete: true,
    },
    {
      whatsapp_number: '27836667788', name: 'Zanele Mthembu',      client_type: 'hospitality',
      physical_address: '5 Beach Rd, Benoni', customer_number: 'C-0005',
      school_name: null, organisation: 'Sunflower Hotel Group', profile_complete: true,
    },
    {
      whatsapp_number: '27839998877', name: 'Johan Visser',        client_type: 'security',
      physical_address: '88 Industrial Way, Boksburg', customer_number: 'C-0006',
      school_name: null, organisation: 'Prime Security Solutions', profile_complete: true,
    },
    {
      whatsapp_number: '27823334455', name: 'Pastor Trevor Matthews', client_type: 'church',
      physical_address: '33 Church St, Brakpan', customer_number: 'C-0007',
      school_name: null, organisation: 'Grace Assembly Church', profile_complete: true,
    },
  ];

  for (const c of clients) {
    if (await skip('clients', 'whatsapp_number', c.whatsapp_number)) {
      logger.info(`  ~ skip: ${c.name}`); continue;
    }
    await query(
      `INSERT INTO clients
         (whatsapp_number, name, client_type, physical_address, customer_number,
          school_name, organisation, profile_complete)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.whatsapp_number, c.name, c.client_type, c.physical_address, c.customer_number,
       c.school_name, c.organisation, c.profile_complete]
    );
    logger.info(`  ✓ client: ${c.name}`);
  }

  // Sync sequence counter for customers
  await query(
    `UPDATE sequence_counters SET value = 7 WHERE key = 'customer' AND date_key = 'global'`
  );
  logger.info('  ✓ customer sequence synced → 7');
}

// ── 4. QUOTATIONS ─────────────────────────────────────────────────────────────
async function seedQuotations() {
  logger.info('Seeding quotations…');

  // Get client IDs
  const { rows: cls } = await query(
    `SELECT id, whatsapp_number FROM clients
     WHERE whatsapp_number IN ('27821234567','27829876543','27831112233','27834445566','27836667788','27839998877')`
  );
  const cMap = Object.fromEntries(cls.map(c => [c.whatsapp_number, c.id]));

  const today    = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // 20260704
  const SLA_4H   = `NOW() + INTERVAL '4 hours'`;
  const CREATED_6H_AGO = `NOW() - INTERVAL '6 hours'`;
  const SLA_6H_AGO     = `NOW() - INTERVAL '2 hours'`; // overdue

  const quotations = [
    {
      ref: `BRQ-Q-${today}-0001`,
      clientWa: '27821234567',
      status: 'draft',
      notes: 'School polo shirts and jerseys for Laerskool Dalview — parent enquiry',
      items: [
        item('School Polo Shirt (Navy)', 5, 189.99, 'school_wear'),
        item('School Jersey (Navy V-Neck)', 5, 249.99, 'school_wear'),
      ],
    },
    {
      ref: `BRQ-Q-${today}-0002`,
      clientWa: '27834445566',
      status: 'draft',
      notes: 'Corporate bulk order — branded golf shirts and trousers for all staff',
      items: [
        item('Executive Golf Shirt', 50, 289.99, 'corporate_wear'),
        item('Corporate Trouser (Men)', 50, 449.99, 'corporate_wear'),
      ],
      overdue: true,
    },
    {
      ref: `BRQ-Q-${today}-0003`,
      clientWa: '27831112233',
      status: 'sent',
      notes: 'Full school uniform order for Laerskool Dalview — Q2 intake',
      items: [
        item('School Polo Shirt (Navy)', 120, 189.99, 'school_wear'),
        item('School Shorts (Grey)', 80, 159.99, 'school_wear'),
        item('School Jersey (Navy V-Neck)', 60, 249.99, 'school_wear'),
      ],
    },
    {
      ref: `BRQ-Q-${today}-0004`,
      clientWa: '27839998877',
      status: 'accepted',
      notes: 'Hi-vis safety wear for security staff — urgent deployment',
      items: [
        item('Hi-Vis Safety Jacket', 20, 349.99, 'safety_wear'),
        item('Boilersuit / Coverall', 20, 499.99, 'safety_wear'),
      ],
    },
    {
      ref: `BRQ-Q-${today}-0005`,
      clientWa: '27836667788',
      status: 'rejected',
      notes: 'Hospitality wear — client chose alternate supplier',
      items: [
        item('Classic Corporate Polo', 30, 249.99, 'corporate_wear'),
      ],
    },
  ];

  const refMap = {};

  for (const q of quotations) {
    if (await skip('quotations', 'reference', q.ref)) {
      logger.info(`  ~ skip: ${q.ref}`);
      // Still capture the ID for orders linkage
      const { rows } = await query('SELECT id FROM quotations WHERE reference = $1', [q.ref]);
      if (rows.length) refMap[q.ref] = rows[0].id;
      continue;
    }

    const { subtotal, vat, total } = calc(q.items);
    const clientId = cMap[q.clientWa];

    if (q.overdue) {
      await query(
        `INSERT INTO quotations
           (reference, client_id, status, line_items, subtotal, vat, total, notes,
            sla_remind_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${SLA_6H_AGO},${CREATED_6H_AGO},${CREATED_6H_AGO})
         RETURNING id`,
        [q.ref, clientId, q.status, JSON.stringify(q.items), subtotal, vat, total, q.notes]
      ).then(r => { refMap[q.ref] = r.rows[0].id; });
    } else {
      const { rows } = await query(
        `INSERT INTO quotations
           (reference, client_id, status, line_items, subtotal, vat, total, notes, sla_remind_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${SLA_4H})
         RETURNING id`,
        [q.ref, clientId, q.status, JSON.stringify(q.items), subtotal, vat, total, q.notes]
      );
      refMap[q.ref] = rows[0].id;
    }
    logger.info(`  ✓ quotation: ${q.ref} (${q.status}) — R${total.toFixed(2)}`);
  }

  // Sync quotation sequence for today
  await query(
    `INSERT INTO sequence_counters (key, date_key, value) VALUES ('quotation', $1, 5)
     ON CONFLICT (key, date_key) DO UPDATE SET value = GREATEST(sequence_counters.value, 5)`,
    [today]
  );

  return refMap;
}

// ── 5. ORDERS ─────────────────────────────────────────────────────────────────
async function seedOrders(quotationRefMap) {
  logger.info('Seeding orders…');

  const { rows: cls } = await query(
    `SELECT id, whatsapp_number FROM clients
     WHERE whatsapp_number IN ('27829876543','27831112233','27834445566','27839998877')`
  );
  const cMap = Object.fromEntries(cls.map(c => [c.whatsapp_number, c.id]));

  const { rows: sf } = await query(`SELECT id, email FROM staff`);
  const staffMap = Object.fromEntries(sf.map(s => [s.email, s.id]));

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const orders = [
    {
      ref: `BRQ-O-${today}-0001`,
      clientWa: '27834445566',
      clientType: 'corporate',
      stage: 'manufacturing',
      paymentStatus: 'deposit_paid',
      depositAmount: 21274.43,
      balanceAmount: 21274.42,
      estimatedCompletion: '2026-07-25',
      quotationRef: null,
      poNumber: 'TC-2026-089',
      assignedEmail: 'sipho@braquni.com',
      isOnHold: false,
    },
    {
      ref: `BRQ-O-${today}-0002`,
      clientWa: '27831112233',
      clientType: 'school',
      stage: 'materials_procurement',
      paymentStatus: 'unpaid',
      depositAmount: 20468.85,
      balanceAmount: 20468.85,
      estimatedCompletion: '2026-08-10',
      quotationRef: null, // will be linked below
      poNumber: null,
      assignedEmail: 'lerato@braquni.com',
      isOnHold: false,
    },
    {
      ref: `BRQ-O-${today}-0003`,
      clientWa: '27839998877',
      clientType: 'security',
      stage: 'quality_control',
      paymentStatus: 'deposit_paid',
      depositAmount: 9774.77,
      balanceAmount: 9774.77,
      estimatedCompletion: '2026-07-18',
      quotationRef: null,
      poNumber: 'PS-2026-034',
      assignedEmail: 'priya@braquni.com',
      isOnHold: true,
      holdReason: 'supplier_delay',
    },
    {
      ref: `BRQ-O-${today}-0004`,
      clientWa: '27829876543',
      clientType: 'retail',
      stage: 'packing_dispatch',
      paymentStatus: 'paid_in_full',
      depositAmount: 2100.00,
      balanceAmount: 0.00,
      estimatedCompletion: '2026-07-06',
      quotationRef: null,
      poNumber: null,
      assignedEmail: 'ruan@braquni.com',
      trackingNumber: 'CPT20260704-008',
      isOnHold: false,
    },
  ];

  // Link order 0002 to quotation 0003 if it exists
  const q3ref = `BRQ-Q-${today}-0003`;
  const q3id  = quotationRefMap[q3ref] ?? null;

  const orderIds = {};

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (await skip('orders', 'reference', o.ref)) {
      logger.info(`  ~ skip: ${o.ref}`);
      const { rows } = await query('SELECT id FROM orders WHERE reference = $1', [o.ref]);
      if (rows.length) orderIds[o.ref] = rows[0].id;
      continue;
    }

    const clientId      = cMap[o.clientWa];
    const assignedStaff = staffMap[o.assignedEmail] ?? null;
    const quotationId   = (i === 1 && q3id) ? q3id : null;

    const { rows } = await query(
      `INSERT INTO orders
         (reference, client_id, client_type, quotation_id, stage, payment_status,
          deposit_amount, balance_amount, estimated_completion_date, assigned_staff_id,
          po_number, tracking_number, is_on_hold, hold_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        o.ref, clientId, o.clientType, quotationId, o.stage, o.paymentStatus,
        o.depositAmount, o.balanceAmount, o.estimatedCompletion, assignedStaff,
        o.poNumber ?? null, o.trackingNumber ?? null, o.isOnHold, o.holdReason ?? null,
      ]
    );
    orderIds[o.ref] = rows[0].id;
    logger.info(`  ✓ order: ${o.ref} (${o.stage}${o.isOnHold ? ' — ON HOLD' : ''})`);
  }

  // Sync order sequence for today
  await query(
    `INSERT INTO sequence_counters (key, date_key, value) VALUES ('order', $1, 4)
     ON CONFLICT (key, date_key) DO UPDATE SET value = GREATEST(sequence_counters.value, 4)`,
    [today]
  );

  return orderIds;
}

// ── 6. PAYMENTS ───────────────────────────────────────────────────────────────
async function seedPayments(orderIds) {
  logger.info('Seeding payments…');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const payments = [
    { orderRef: `BRQ-O-${today}-0001`, type: 'deposit', amount: 21274.43, notes: 'EFT received — Nedbank ref: 20260702-TC' },
    { orderRef: `BRQ-O-${today}-0003`, type: 'deposit', amount: 9774.77,  notes: 'EFT received — FNB ref: 20260701-PS' },
    { orderRef: `BRQ-O-${today}-0004`, type: 'full',    amount: 4200.00,  notes: 'Full payment via card on collection' },
  ];

  for (const p of payments) {
    const orderId = orderIds[p.orderRef];
    if (!orderId) { logger.warn(`  ! no order found for: ${p.orderRef}`); continue; }

    const { rows: existing } = await query(
      `SELECT id FROM payments WHERE order_id = $1 AND type = $2 AND amount = $3`,
      [orderId, p.type, p.amount]
    );
    if (existing.length) { logger.info(`  ~ skip payment for: ${p.orderRef}`); continue; }

    await query(
      `INSERT INTO payments (order_id, type, amount, currency, notes) VALUES ($1,$2,$3,'ZAR',$4)`,
      [orderId, p.type, p.amount, p.notes]
    );
    logger.info(`  ✓ payment: ${p.type} R${p.amount} → ${p.orderRef}`);
  }
}

// ── 7. TICKETS ────────────────────────────────────────────────────────────────
async function seedTickets(orderIds) {
  logger.info('Seeding tickets…');

  const { rows: cls } = await query(
    `SELECT id, whatsapp_number FROM clients
     WHERE whatsapp_number IN ('27821234567','27829876543','27834445566')`
  );
  const cMap = Object.fromEntries(cls.map(c => [c.whatsapp_number, c.id]));

  const { rows: sf } = await query(`SELECT id, email FROM staff`);
  const staffMap = Object.fromEntries(sf.map(s => [s.email, s.id]));

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const tickets = [
    {
      clientWa: '27821234567',
      orderRef: null,
      category: 'wrong_item',
      status: 'open',
      description: 'I received grey school shorts instead of the navy ones I ordered. Order number is BRQ-O-' + today + '-0004. My child needs the correct ones before next Monday for school.',
      assignedEmail: null,
      slaOffset: '+4 hours',
    },
    {
      clientWa: '27829876543',
      orderRef: `BRQ-O-${today}-0004`,
      category: 'defective',
      status: 'in_progress',
      description: 'The zip on the softshell jacket received yesterday is completely broken — it jams halfway up and cannot be closed. This is unacceptable for a R550 jacket. Please advise on the return/replacement process.',
      assignedEmail: 'lerato@braquni.com',
      slaOffset: '+1 hour',
    },
    {
      clientWa: '27834445566',
      orderRef: null,
      category: 'account_query',
      status: 'resolved',
      description: 'We have not received an invoice for order BRQ-O-' + today + '-0001. Please send to accounts@techcorpsa.co.za. Also please update our VAT number to 4810245632.',
      assignedEmail: 'sipho@braquni.com',
      slaOffset: '-2 hours',
      resolved: true,
    },
  ];

  for (const t of tickets) {
    const clientId      = cMap[t.clientWa];
    const assignedStaff = t.assignedEmail ? (staffMap[t.assignedEmail] ?? null) : null;
    const orderId       = t.orderRef ? (orderIds[t.orderRef] ?? null) : null;

    // Check duplicate by client + category + description prefix
    const { rows: existing } = await query(
      `SELECT id FROM tickets WHERE client_id = $1 AND category = $2 AND description LIKE $3`,
      [clientId, t.category, t.description.slice(0, 40) + '%']
    );
    if (existing.length) { logger.info(`  ~ skip ticket: ${t.category} / ${t.clientWa}`); continue; }

    const slaDue = t.slaOffset.startsWith('+')
      ? `NOW() + INTERVAL '${t.slaOffset.slice(1)}'`
      : `NOW() - INTERVAL '${t.slaOffset.slice(1)}'`;

    const resolvedClause = t.resolved
      ? `, resolved_at = NOW(), updated_at = NOW(), status = 'resolved'`
      : '';

    const claimedClause  = assignedStaff ? `, claimed_at = NOW()` : '';
    const notifiedClause = `, notified_at = NOW() - INTERVAL '30 minutes'`;

    await query(
      `INSERT INTO tickets
         (client_id, order_id, category, status, description, assigned_staff_id, sla_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,(${slaDue}))`,
      [clientId, orderId, t.category, t.status, t.description, assignedStaff]
    );

    if (t.resolved || assignedStaff) {
      await query(
        `UPDATE tickets
         SET ${t.resolved ? "resolved_at = NOW(), status = 'resolved'," : ''}
             ${assignedStaff ? 'claimed_at = NOW(),' : ''}
             notified_at = NOW() - INTERVAL '30 minutes',
             updated_at = NOW()
         WHERE client_id = $1 AND category = $2 AND description LIKE $3`,
        [clientId, t.category, t.description.slice(0, 40) + '%']
      );
    }

    logger.info(`  ✓ ticket: ${t.category} / ${t.status}`);
  }
}

// ── 8. CONVERSATIONS & MESSAGES ───────────────────────────────────────────────
async function seedConversations() {
  logger.info('Seeding conversations…');

  const { rows: cls } = await query(
    `SELECT id, whatsapp_number FROM clients
     WHERE whatsapp_number IN ('27821234567','27834445566','27823334455')`
  );
  const cMap = Object.fromEntries(cls.map(c => [c.whatsapp_number, c.id]));

  const { rows: sf } = await query(`SELECT id, email FROM staff`);
  const staffMap = Object.fromEntries(sf.map(s => [s.email, s.id]));

  const convos = [
    {
      clientWa: '27821234567', // Nomsa
      state: 'awaiting_consultant',
      assignedEmail: null,
      messages: [
        { dir: 'inbound',  body: 'Hi, I need help with my order please' },
        { dir: 'outbound', body: 'Hi Nomsa! 😊 I\'ve noted your query and passed it to our team. A consultant will assist you shortly.' },
        { dir: 'inbound',  body: 'I received the wrong items in my delivery' },
        { dir: 'inbound',  body: 'I ordered navy shorts but got grey ones' },
      ],
    },
    {
      clientWa: '27834445566', // TechCorp / Bongani
      state: 'consultant_active',
      assignedEmail: 'sipho@braquni.com',
      messages: [
        { dir: 'inbound',  body: 'Good morning, we need to query our account balance and also get a tax invoice for our last order' },
        { dir: 'outbound', body: 'Good morning Bongani! I\'m Sipho from Braq Uni. I\'m pulling up your account details now — I\'ll have the invoice and balance ready in just a moment.' },
        { dir: 'inbound',  body: 'Thank you Sipho, our VAT number also needs to be updated' },
        { dir: 'outbound', body: 'Noted — I\'ll update your VAT number to the one on file and send the invoice to accounts@techcorpsa.co.za as requested. Give me 10 minutes.' },
      ],
    },
    {
      clientWa: '27823334455', // Pastor Matthews
      state: 'main_menu',
      assignedEmail: null,
      messages: [
        { dir: 'inbound',  body: 'Hello I would like to enquire about choir robes for our church' },
        { dir: 'outbound', body: 'Hello! 👋 Welcome to Braq Uni. I\'m your virtual assistant.\n\nWe specialise in custom choir robes for churches. Please choose from the main menu:\n\n1. Shop / Retail\n2. School / Corporate Bulk\n3. Request Quotation\n4. Track Order\n5. Branding & Embroidery\n6. Store Information\n7. Speak to Consultant\n\nReply *0* anytime to return to this menu.' },
      ],
    },
  ];

  for (const cv of convos) {
    const clientId      = cMap[cv.clientWa];
    const assignedStaff = cv.assignedEmail ? (staffMap[cv.assignedEmail] ?? null) : null;

    // Check if conversation already exists for this client in this state
    const { rows: existing } = await query(
      `SELECT id FROM conversations WHERE client_id = $1 AND is_open = true`,
      [clientId]
    );
    if (existing.length) { logger.info(`  ~ skip conversation: ${cv.clientWa}`); continue; }

    const notifiedClause = cv.state === 'awaiting_consultant'
      ? `, notified_at = NOW() - INTERVAL '20 minutes'`
      : '';

    const { rows: [convo] } = await query(
      `INSERT INTO conversations (client_id, state, assigned_staff_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [clientId, cv.state, assignedStaff]
    );

    if (cv.state === 'awaiting_consultant') {
      await query(
        `UPDATE conversations SET notified_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
        [convo.id]
      );
    }

    // Insert messages with staggered timestamps
    for (let i = 0; i < cv.messages.length; i++) {
      const msg    = cv.messages[i];
      const offset = (cv.messages.length - i) * 5; // 5min apart, most recent last
      const fakeId = `seed-${cv.clientWa}-${i}-${Date.now()}`;

      await query(
        `INSERT INTO messages
           (conversation_id, client_id, direction, body, meta_message_id,
            is_read_by_staff, created_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW() - ($7 || ' minutes')::INTERVAL)`,
        [convo.id, clientId, msg.dir, msg.body, fakeId,
         msg.dir === 'outbound', offset.toString()]
      );
    }

    logger.info(`  ✓ conversation: ${cv.clientWa} — state: ${cv.state} (${cv.messages.length} messages)`);
  }
}

// ── RUNNER ────────────────────────────────────────────────────────────────────
async function run() {
  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(' Braq Connect™ — Testing Seed (new schema)');
  logger.info('═══════════════════════════════════════════════════════════════');

  await seedStaff();
  logger.info('');
  await seedProducts();
  logger.info('');
  await seedClients();
  logger.info('');
  const quotationRefMap = await seedQuotations();
  logger.info('');
  const orderIds = await seedOrders(quotationRefMap);
  logger.info('');
  await seedPayments(orderIds);
  logger.info('');
  await seedTickets(orderIds);
  logger.info('');
  await seedConversations();

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(' Seed complete ✓');
  logger.info('  Staff         : 1 admin + 5 consultants  (password: Braq@2025!)');
  logger.info('  Products      : 26 across 6 categories');
  logger.info('  Clients       : 7 (retail/school/corporate/hospitality/security/church)');
  logger.info('  Quotations    : 5 (2 draft, 1 sent, 1 accepted, 1 rejected)');
  logger.info('  Orders        : 4 (various stages, 1 on hold)');
  logger.info('  Tickets       : 3 (open / in_progress / resolved)');
  logger.info('  Conversations : 3 (awaiting_consultant / consultant_active / main_menu)');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('');
}

run()
  .catch((err) => {
    logger.error('Seed failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
