import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const migrations = [

// ── 000: clean slate — drop everything ───────────────────────────────────────
`DROP TABLE IF EXISTS
  order_stage_history, order_size_entries, broadcasts, purchase_orders,
  school_catalog, payments, tickets, quotations, orders, messages,
  conversations, products, clients, staff, settings, sequence_counters
  CASCADE`,

`DROP TYPE IF EXISTS
  order_stage, session_state, purchase_order_status, payment_status,
  client_type, message_direction, message_status, quotation_status,
  staff_role, ticket_category, ticket_status, payment_type, product_category
  CASCADE`,

// ── 001: enums ────────────────────────────────────────────────────────────────
`CREATE TYPE client_type AS ENUM (
  'retail', 'school', 'corporate', 'hospitality',
  'church', 'security', 'government', 'reseller'
)`,

`CREATE TYPE message_direction AS ENUM ('inbound', 'outbound')`,
`CREATE TYPE message_status   AS ENUM ('sent', 'delivered', 'read', 'failed')`,
`CREATE TYPE quotation_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired')`,
`CREATE TYPE staff_role       AS ENUM ('admin', 'consultant', 'manager')`,

`CREATE TYPE ticket_category AS ENUM (
  'wrong_item', 'defective', 'missing_item', 'account_query', 'other'
)`,
`CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed')`,

`CREATE TYPE payment_type AS ENUM ('deposit', 'balance', 'full')`,

`CREATE TYPE product_category AS ENUM (
  'school_wear', 'knitwear', 'medical_wear',
  'outdoor_wear', 'corporate_wear', 'safety_wear'
)`,

// ── 002: updated_at trigger function ─────────────────────────────────────────
`CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,

// ── 003: settings (key-value store — e.g. busy_mode) ─────────────────────────
`CREATE TABLE settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT         NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

`INSERT INTO settings (key, value) VALUES ('busy_mode', 'false')`,

// ── 004: sequence counters ────────────────────────────────────────────────────
`CREATE TABLE sequence_counters (
  key      VARCHAR(50) NOT NULL,
  date_key VARCHAR(8)  NOT NULL DEFAULT 'global',
  value    INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (key, date_key)
)`,

`INSERT INTO sequence_counters (key, date_key, value) VALUES ('customer', 'global', 0)`,

// ── 005: staff ────────────────────────────────────────────────────────────────
`CREATE TABLE staff (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  role          staff_role   NOT NULL DEFAULT 'consultant',
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

`CREATE TRIGGER trg_staff_updated_at
 BEFORE UPDATE ON staff
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 006: clients ──────────────────────────────────────────────────────────────
`CREATE TABLE clients (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number          VARCHAR(20) NOT NULL UNIQUE,
  name                     VARCHAR(200),
  email                    VARCHAR(200),
  client_type              client_type NOT NULL DEFAULT 'retail',
  organisation             VARCHAR(200),
  contact_person           VARCHAR(200),
  physical_address         TEXT,
  preferred_store_location VARCHAR(120),
  school_name              VARCHAR(200),
  customer_number          VARCHAR(20)  UNIQUE,
  profile_complete         BOOLEAN      NOT NULL DEFAULT false,
  delivery_preference      VARCHAR(20),
  vat_number               VARCHAR(50),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_clients_whatsapp ON clients(whatsapp_number)`,

`CREATE TRIGGER trg_clients_updated_at
 BEFORE UPDATE ON clients
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 007: conversations ────────────────────────────────────────────────────────
`CREATE TABLE conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  state            TEXT        NOT NULL DEFAULT 'main_menu',
  context          JSONB       NOT NULL DEFAULT '{}',
  is_open          BOOLEAN     NOT NULL DEFAULT true,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_staff_id UUID       REFERENCES staff(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_conversations_client ON conversations(client_id)`,
`CREATE INDEX idx_conversations_open   ON conversations(is_open)`,
`CREATE INDEX idx_conversations_staff  ON conversations(assigned_staff_id)`,

`CREATE TRIGGER trg_conversations_updated_at
 BEFORE UPDATE ON conversations
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 008: messages ─────────────────────────────────────────────────────────────
`CREATE TABLE messages (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID              NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_id        UUID              NOT NULL REFERENCES clients(id)        ON DELETE CASCADE,
  body             TEXT,
  direction        message_direction NOT NULL,
  meta_message_id  VARCHAR(200)      UNIQUE,
  is_read_by_staff BOOLEAN           NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_messages_conversation ON messages(conversation_id)`,
`CREATE INDEX idx_messages_client       ON messages(client_id)`,
`CREATE INDEX idx_messages_unread       ON messages(is_read_by_staff) WHERE is_read_by_staff = false`,

// ── 009: products (merged with school_catalog) ────────────────────────────────
`CREATE TABLE products (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  category    product_category NOT NULL,
  name        VARCHAR(200)     NOT NULL,
  school_name VARCHAR(200),
  sizes       JSONB            NOT NULL DEFAULT '[]',
  price       NUMERIC(10,2)    NOT NULL DEFAULT 0,
  currency    VARCHAR(3)       NOT NULL DEFAULT 'ZAR',
  description TEXT,
  is_active   BOOLEAN          NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_products_category    ON products(category)`,
`CREATE INDEX idx_products_school_name ON products(school_name) WHERE school_name IS NOT NULL`,

`CREATE TRIGGER trg_products_updated_at
 BEFORE UPDATE ON products
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 010: quotations ───────────────────────────────────────────────────────────
`CREATE TABLE quotations (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        VARCHAR(30)      NOT NULL UNIQUE,
  client_id        UUID             NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  status           quotation_status NOT NULL DEFAULT 'draft',
  line_items       JSONB            NOT NULL DEFAULT '[]',
  subtotal         NUMERIC(12,2)    NOT NULL DEFAULT 0,
  vat              NUMERIC(12,2)    NOT NULL DEFAULT 0,
  total            NUMERIC(12,2)    NOT NULL DEFAULT 0,
  currency         VARCHAR(3)       NOT NULL DEFAULT 'ZAR',
  notes            TEXT,
  sla_remind_at    TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  approved_by      UUID             REFERENCES staff(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  needs_review     BOOLEAN          NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_quotations_client ON quotations(client_id)`,
`CREATE INDEX idx_quotations_status ON quotations(status)`,
`CREATE INDEX idx_quotations_sla    ON quotations(sla_remind_at) WHERE reminder_sent_at IS NULL`,

`CREATE TRIGGER trg_quotations_updated_at
 BEFORE UPDATE ON quotations
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 011: orders ───────────────────────────────────────────────────────────────
// stage is plain text validated in application code against 10 fixed values:
// quotation_requested, quotation_submitted, po_received, materials_procurement,
// production_scheduled, manufacturing, branding_embroidery, quality_control,
// packing_dispatch, completed
// payment_status is plain text: unpaid | deposit_paid | paid_in_full
`CREATE TABLE orders (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                VARCHAR(30) NOT NULL UNIQUE,
  client_id                UUID        NOT NULL REFERENCES clients(id)    ON DELETE RESTRICT,
  quotation_id             UUID        REFERENCES quotations(id)          ON DELETE SET NULL,
  client_type              client_type NOT NULL DEFAULT 'retail',
  stage                    TEXT        NOT NULL DEFAULT 'quotation_requested',
  is_on_hold               BOOLEAN     NOT NULL DEFAULT false,
  hold_reason              TEXT,
  po_number                VARCHAR(100),
  tracking_number          VARCHAR(100),
  payment_status           TEXT        NOT NULL DEFAULT 'unpaid',
  deposit_amount           NUMERIC(12,2),
  balance_amount           NUMERIC(12,2),
  estimated_completion_date DATE,
  assigned_staff_id        UUID        REFERENCES staff(id)               ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_orders_client    ON orders(client_id)`,
`CREATE INDEX idx_orders_stage     ON orders(stage)`,
`CREATE INDEX idx_orders_reference ON orders(reference)`,
`CREATE INDEX idx_orders_staff     ON orders(assigned_staff_id)`,
`CREATE INDEX idx_orders_on_hold   ON orders(is_on_hold) WHERE is_on_hold = true`,

`CREATE TRIGGER trg_orders_updated_at
 BEFORE UPDATE ON orders
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

// ── 012: payments ─────────────────────────────────────────────────────────────
`CREATE TABLE payments (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       payment_type  NOT NULL,
  amount     NUMERIC(12,2) NOT NULL,
  currency   VARCHAR(3)    NOT NULL DEFAULT 'ZAR',
  notes      TEXT,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_payments_order ON payments(order_id)`,

// ── 013: tickets ──────────────────────────────────────────────────────────────
`CREATE TABLE tickets (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID            NOT NULL REFERENCES clients(id)  ON DELETE RESTRICT,
  order_id          UUID            REFERENCES orders(id)            ON DELETE SET NULL,
  category          ticket_category NOT NULL,
  status            ticket_status   NOT NULL DEFAULT 'open',
  description       TEXT            NOT NULL,
  assigned_staff_id UUID            REFERENCES staff(id)             ON DELETE SET NULL,
  sla_due_at        TIMESTAMPTZ     NOT NULL,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
)`,

`CREATE INDEX idx_tickets_status ON tickets(status)`,
`CREATE INDEX idx_tickets_client ON tickets(client_id)`,
`CREATE INDEX idx_tickets_sla    ON tickets(sla_due_at) WHERE status NOT IN ('resolved','closed')`,

`CREATE TRIGGER trg_tickets_updated_at
 BEFORE UPDATE ON tickets
 FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

];

async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running migrations — full schema reset...');
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 70).replace(/\s+/g, ' ');
      try {
        await client.query(sql);
        logger.info(`  ✓ ${preview}`);
      } catch (err) {
        if (err.code === '42710' || err.code === '42P07' || err.code === '42P16') {
          logger.info(`  ~ already exists: ${preview}`);
        } else {
          logger.error(`  ✗ ${preview}`, { error: err.message, code: err.code });
          throw err;
        }
      }
    }
    logger.info('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
