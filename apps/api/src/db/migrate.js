import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const migrations = [

// ── 001: enums ───────────────────────────────────────────────────────────────
`CREATE TYPE client_type AS ENUM (
  'retail',
  'school',
  'corporate',
  'hospitality',
  'church',
  'security',
  'government',
  'reseller'
)`,

`CREATE TYPE order_stage AS ENUM (
  'quotation_requested',
  'quotation_submitted',
  'purchase_order_received',
  'materials_procurement',
  'production_scheduled',
  'manufacturing',
  'branding_embroidery',
  'quality_control',
  'packing_dispatch',
  'completed',
  'cancelled',
  'on_hold'
)`,

`CREATE TYPE message_direction AS ENUM ('inbound', 'outbound')`,
`CREATE TYPE message_status   AS ENUM ('sent', 'delivered', 'read', 'failed')`,
`CREATE TYPE quotation_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired')`,
`CREATE TYPE staff_role       AS ENUM ('admin', 'consultant', 'manager')`,
`CREATE TYPE session_state    AS ENUM (
  'new',
  'main_menu',
  'retail_menu',
  'retail_pricing',
  'retail_school_info',
  'retail_hours',
  'retail_layby',
  'retail_collection',
  'corporate_menu',
  'corporate_new_order',
  'corporate_repeat_order',
  'quotation_requested',
  'order_tracking',
  'branding_enquiry',
  'store_info',
  'awaiting_consultant',
  'consultant_active'
)`,

// ── 002: staff ───────────────────────────────────────────────────────────────
`CREATE TABLE staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  role          staff_role   NOT NULL DEFAULT 'consultant',
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

// ── 003: clients ─────────────────────────────────────────────────────────────
`CREATE TABLE clients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number VARCHAR(20) NOT NULL UNIQUE,
  name            VARCHAR(200),
  email           VARCHAR(200),
  client_type     client_type NOT NULL DEFAULT 'retail',
  organisation    VARCHAR(200),
  contact_person  VARCHAR(200),
  notes           TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_clients_whatsapp ON clients(whatsapp_number)`,

// ── 004: conversations / sessions ─────────────────────────────────────────────
`CREATE TABLE conversations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assigned_staff  UUID         REFERENCES staff(id) ON DELETE SET NULL,
  state           session_state NOT NULL DEFAULT 'new',
  context         JSONB        NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_open         BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_conversations_client   ON conversations(client_id)`,
`CREATE INDEX idx_conversations_open     ON conversations(is_open)`,
`CREATE INDEX idx_conversations_staff    ON conversations(assigned_staff)`,

// ── 005: messages ─────────────────────────────────────────────────────────────
`CREATE TABLE messages (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID             NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_id        UUID             NOT NULL REFERENCES clients(id)        ON DELETE CASCADE,
  meta_message_id  VARCHAR(200)     UNIQUE,
  direction        message_direction NOT NULL,
  body             TEXT,
  message_type     VARCHAR(50)      NOT NULL DEFAULT 'text',
  status           message_status   NOT NULL DEFAULT 'sent',
  is_read_by_staff BOOLEAN          NOT NULL DEFAULT false,
  sent_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ,
  read_at          TIMESTAMPTZ,
  metadata         JSONB            NOT NULL DEFAULT '{}'
)`,

`CREATE INDEX idx_messages_conversation ON messages(conversation_id)`,
`CREATE INDEX idx_messages_client       ON messages(client_id)`,
`CREATE INDEX idx_messages_unread       ON messages(is_read_by_staff) WHERE is_read_by_staff = false`,

// ── 006: orders ───────────────────────────────────────────────────────────────
`CREATE TABLE orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         VARCHAR(30) NOT NULL UNIQUE,
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  assigned_staff_id UUID        REFERENCES staff(id) ON DELETE SET NULL,
  stage             order_stage NOT NULL DEFAULT 'quotation_requested',
  client_type       client_type NOT NULL DEFAULT 'retail',
  description       TEXT,
  quantity          INTEGER,
  estimated_completion DATE,
  special_notes     TEXT,
  is_urgent         BOOLEAN     NOT NULL DEFAULT false,
  is_delayed        BOOLEAN     NOT NULL DEFAULT false,
  delay_reason      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_orders_client    ON orders(client_id)`,
`CREATE INDEX idx_orders_stage     ON orders(stage)`,
`CREATE INDEX idx_orders_reference ON orders(reference)`,
`CREATE INDEX idx_orders_staff     ON orders(assigned_staff_id)`,

`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100)`,

...[
  'corporate_uniform_garment',
  'corporate_uniform_sizes',
  'corporate_uniform_branding',
  'corporate_uniform_quantity',
  'corporate_manufacturing_update',
  'corporate_delivery_schedule',
].map(v => `ALTER TYPE session_state ADD VALUE IF NOT EXISTS '${v}'`),

// ── 007: order stage history ─────────────────────────────────────────────────
`CREATE TABLE order_stage_history (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_stage     order_stage,
  to_stage       order_stage NOT NULL,
  changed_by     UUID        REFERENCES staff(id) ON DELETE SET NULL,
  notes          TEXT,
  wa_message_id  VARCHAR(200),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_stage_history_order ON order_stage_history(order_id)`,

// ── 008: quotations ───────────────────────────────────────────────────────────
`CREATE TABLE quotations (
  id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     VARCHAR(30)      NOT NULL UNIQUE,
  order_id      UUID             REFERENCES orders(id) ON DELETE SET NULL,
  client_id     UUID             NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  created_by    UUID             REFERENCES staff(id) ON DELETE SET NULL,
  status        quotation_status NOT NULL DEFAULT 'draft',
  line_items    JSONB            NOT NULL DEFAULT '[]',
  subtotal      NUMERIC(12,2)    NOT NULL DEFAULT 0,
  vat_rate      NUMERIC(5,2)     NOT NULL DEFAULT 15.00,
  vat_amount    NUMERIC(12,2)    NOT NULL DEFAULT 0,
  total         NUMERIC(12,2)    NOT NULL DEFAULT 0,
  currency      VARCHAR(3)       NOT NULL DEFAULT 'USD',
  valid_until   DATE,
  payment_terms VARCHAR(200),
  lead_time     VARCHAR(100),
  notes         TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_quotations_client ON quotations(client_id)`,
`CREATE INDEX idx_quotations_order  ON quotations(order_id)`,
`CREATE INDEX idx_quotations_status ON quotations(status)`,

// ── 009: broadcast messages ───────────────────────────────────────────────────
`CREATE TABLE broadcasts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by      UUID        REFERENCES staff(id) ON DELETE SET NULL,
  message_type VARCHAR(50) NOT NULL,
  body         TEXT        NOT NULL,
  recipient_count INTEGER  NOT NULL DEFAULT 0,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

// ── 010: products (catalog) ───────────────────────────────────────────────────
`CREATE TABLE products (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category    VARCHAR(50) NOT NULL,
  name        VARCHAR(200) NOT NULL,
  sizes       JSONB       NOT NULL DEFAULT '[]',
  price       NUMERIC(10,2) NOT NULL,
  currency    VARCHAR(3)  NOT NULL DEFAULT 'USD',
  client_type client_type,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_products_category ON products(category)`,

// ── 011: sequential numbering (customers + quotations) ───────────────────────
`CREATE SEQUENCE IF NOT EXISTS clients_customer_seq`,

`CREATE TABLE IF NOT EXISTS sequence_counters (
  key   VARCHAR(50) NOT NULL,
  year  INT         NOT NULL,
  value INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (key, year)
)`,

`ALTER TABLE clients ADD COLUMN IF NOT EXISTS customer_number VARCHAR(20) UNIQUE`,

`UPDATE clients SET customer_number = sub.num
 FROM (
   SELECT id, 'BRQ-CUST-' || LPAD(nextval('clients_customer_seq')::text, 4, '0') AS num
   FROM clients WHERE customer_number IS NULL ORDER BY created_at
 ) sub
 WHERE clients.id = sub.id`,

// ── 012: CRM structured fields ────────────────────────────────────────────────
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS physical_address TEXT`,
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS vat_number VARCHAR(50)`,
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_store_location VARCHAR(120)`,
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS school_name VARCHAR(200)`,
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_complete BOOLEAN NOT NULL DEFAULT false`,

`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'registration_name'`,
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'registration_org_or_school'`,
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'registration_address'`,

// ── 013: purchase orders ──────────────────────────────────────────────────────
`CREATE TYPE purchase_order_status AS ENUM ('pending_review', 'valid', 'invalid')`,

`CREATE TABLE IF NOT EXISTS purchase_orders (
  id            UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id  UUID                  NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  order_id      UUID                  REFERENCES orders(id) ON DELETE SET NULL,
  po_number     VARCHAR(100)          NOT NULL,
  status        purchase_order_status NOT NULL DEFAULT 'pending_review',
  notes         TEXT,
  validated_by  UUID                  REFERENCES staff(id) ON DELETE SET NULL,
  received_at   TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_purchase_orders_quotation ON purchase_orders(quotation_id)`,

`ALTER TABLE orders ADD COLUMN IF NOT EXISTS quotation_id UUID REFERENCES quotations(id)`,

`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'corporate_po_quotation_ref'`,
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'corporate_po_number'`,

// ── 014: design approval stage ────────────────────────────────────────────────
`ALTER TYPE order_stage ADD VALUE IF NOT EXISTS 'design_approval_pending'`,

`ALTER TABLE orders ADD COLUMN IF NOT EXISTS design_approved_at TIMESTAMPTZ`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS design_rejection_reason TEXT`,

`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'corporate_design_approval'`,

// ── 015: payment & deposit tracking ───────────────────────────────────────────
`CREATE TYPE payment_status AS ENUM ('not_required', 'deposit_required', 'deposit_received', 'balance_outstanding', 'paid_in_full')`,
`CREATE TYPE payment_type   AS ENUM ('deposit', 'balance', 'full')`,

`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status payment_status NOT NULL DEFAULT 'not_required'`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_percentage NUMERIC(5,2)`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12,2)`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(12,2)`,
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS deposit_percentage NUMERIC(5,2) NOT NULL DEFAULT 60`,

`CREATE TABLE IF NOT EXISTS payments (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  payment_type  payment_type  NOT NULL,
  recorded_by   UUID          REFERENCES staff(id) ON DELETE SET NULL,
  notes         TEXT,
  received_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_payments_order ON payments(order_id)`,

// ── 016: bulk sizing upload ───────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS order_size_entries (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  person_name  VARCHAR(200) NOT NULL,
  size         VARCHAR(20)  NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_order_size_entries_order ON order_size_entries(order_id)`,

// ── 017: complaints/returns tickets + SLA ─────────────────────────────────────
`CREATE TYPE ticket_category AS ENUM ('wrong_item', 'defective', 'missing_item', 'other')`,
`CREATE TYPE ticket_status   AS ENUM ('open', 'in_progress', 'resolved', 'closed')`,

`CREATE TABLE IF NOT EXISTS tickets (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID            NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  order_id          UUID            REFERENCES orders(id) ON DELETE SET NULL,
  category          ticket_category NOT NULL,
  description       TEXT            NOT NULL,
  status            ticket_status   NOT NULL DEFAULT 'open',
  assigned_staff_id UUID            REFERENCES staff(id) ON DELETE SET NULL,
  sla_due_at        TIMESTAMPTZ     NOT NULL,
  escalation_level  INT             NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ
)`,

`CREATE INDEX idx_tickets_status ON tickets(status)`,
`CREATE INDEX idx_tickets_client ON tickets(client_id)`,

`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'ticket_category'`,
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'ticket_description'`,

// ── 019: retail school select state ──────────────────────────────────────────
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'retail_school_select'`,

// ── 020: quotation multi-turn gathering state ─────────────────────────────────
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'quotation_gathering'`,

// ── 021: school catalog ───────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS school_catalog (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_name  VARCHAR(200)  NOT NULL,
  uniform_type VARCHAR(200)  NOT NULL,
  description  TEXT,
  sizes        JSONB         NOT NULL DEFAULT '[]',
  price        NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency     VARCHAR(3)    NOT NULL DEFAULT 'ZAR',
  is_active    BOOLEAN       NOT NULL DEFAULT true,
  sort_order   INT           NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX IF NOT EXISTS idx_school_catalog_school ON school_catalog(school_name)`,

// ── 023: quotation approval workflow ─────────────────────────────────────────
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sla_remind_at   TIMESTAMPTZ`,
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`,
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approved_by     UUID REFERENCES staff(id) ON DELETE SET NULL`,
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ`,

// ── 022: data-integrity flags (Phase 5) ──────────────────────────────────────
// needs_review = true when a record fails validator checks.
// Set by the backfill script and cleared by consultant action or re-validation.
`ALTER TABLE orders     ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false`,
`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false`,

// delivery_preference: explicit column replacing the derived check across
// preferred_store_location / physical_address used in Phase 1–4 validators.
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS delivery_preference VARCHAR(20)`,

// sizes_tbc_by: lets consultants defer the sizing roster to a future date
// rather than blocking the stage-advance gate immediately.
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sizes_tbc_by DATE`,

`CREATE INDEX IF NOT EXISTS idx_orders_needs_review      ON orders(needs_review)     WHERE needs_review = true`,
`CREATE INDEX IF NOT EXISTS idx_quotations_needs_review  ON quotations(needs_review) WHERE needs_review = true`,

// ── 025: size availability bot state ─────────────────────────────────────────
`ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'retail_size_availability'`,

// ── 024: remap product categories to 6-category catalog ──────────────────────
`UPDATE products SET category = 'school_wear'   WHERE category IN ('uniform')`,
`UPDATE products SET category = 'corporate_wear' WHERE category IN ('corporate', 'hospitality', 'accessories', 'other')`,
`UPDATE products SET category = 'outdoor_wear'   WHERE category IN ('sports')`,

// ── 018: updated_at auto-trigger ─────────────────────────────────────────────
`CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,

...['staff','clients','conversations','orders','quotations','products','tickets'].map(t =>
  `CREATE TRIGGER trg_${t}_updated_at
   BEFORE UPDATE ON ${t}
   FOR EACH ROW EXECUTE FUNCTION update_updated_at()`
),

];

async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running migrations...');
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      try {
        await client.query(sql);
        logger.info(`  ✓ ${preview}`);
      } catch (err) {
        if (err.code === '42710' || err.code === '42P07' || err.code === '42P16') {
          logger.info(`  ~ already exists: ${preview}`);
        } else {
          throw err;
        }
      }
    }
    logger.info('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
