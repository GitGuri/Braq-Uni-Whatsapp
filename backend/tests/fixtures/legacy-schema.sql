-- Legacy schema fixture: exactly what the pre-versioning scripts created
-- (db/migrate.js = columnPatches + migrations, then db/ensureSchema.js patches,
-- which ran on every server boot). Captured before those scripts were deleted;
-- used by tests to prove the versioned migrations upgrade a live database.

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS claimed_at             TIMESTAMPTZ;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS notified_at            TIMESTAMPTZ;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS staff_reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_url      TEXT;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_status   TEXT NOT NULL DEFAULT 'none';

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_notes    TEXT;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_sent_at  TIMESTAMPTZ;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS material_notes JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS orders ALTER COLUMN stage SET DEFAULT 'deposit_pending';

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS auto_quoted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS valid_until DATE;

DO $$ BEGIN
  CREATE TYPE client_type AS ENUM ('retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_status AS ENUM ('sent', 'delivered', 'read', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quotation_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_role AS ENUM ('admin', 'consultant', 'manager');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_category AS ENUM ('wrong_item', 'defective', 'missing_item', 'account_query', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_type AS ENUM ('deposit', 'balance', 'full');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE product_category AS ENUM ('school_wear', 'knitwear', 'medical_wear', 'outdoor_wear', 'corporate_wear', 'safety_wear');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT         NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES ('busy_mode', 'false')
 ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sequence_counters (
  key      VARCHAR(50) NOT NULL,
  date_key VARCHAR(8)  NOT NULL DEFAULT 'global',
  value    INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (key, date_key)
);

INSERT INTO sequence_counters (key, date_key, value) VALUES ('customer', 'global', 0)
 ON CONFLICT (key, date_key) DO NOTHING;

INSERT INTO sequence_counters (key, date_key, value) VALUES ('order', 'global', 0)
 ON CONFLICT (key, date_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  role          staff_role   NOT NULL DEFAULT 'consultant',
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_staff_updated_at
 BEFORE UPDATE ON staff
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS clients (
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
);

CREATE INDEX IF NOT EXISTS idx_clients_whatsapp ON clients(whatsapp_number);

CREATE OR REPLACE TRIGGER trg_clients_updated_at
 BEFORE UPDATE ON clients
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS conversations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  state             TEXT        NOT NULL DEFAULT 'main_menu',
  context           JSONB       NOT NULL DEFAULT '{}',
  is_open           BOOLEAN     NOT NULL DEFAULT true,
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_staff_id UUID        REFERENCES staff(id) ON DELETE SET NULL,
  claimed_at        TIMESTAMPTZ,
  notified_at       TIMESTAMPTZ,
  reminder_sent_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations(client_id);

CREATE INDEX IF NOT EXISTS idx_conversations_open   ON conversations(is_open);

CREATE INDEX IF NOT EXISTS idx_conversations_staff  ON conversations(assigned_staff_id);

CREATE INDEX IF NOT EXISTS idx_conversations_unclaimed ON conversations(notified_at)
 WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_conversation_per_client
 ON conversations(client_id) WHERE is_open = true;

CREATE OR REPLACE TRIGGER trg_conversations_updated_at
 BEFORE UPDATE ON conversations
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS messages (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID              NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_id        UUID              NOT NULL REFERENCES clients(id)        ON DELETE CASCADE,
  body             TEXT,
  direction        message_direction NOT NULL,
  meta_message_id  VARCHAR(200)      UNIQUE,
  is_read_by_staff BOOLEAN           NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_client       ON messages(client_id);

CREATE INDEX IF NOT EXISTS idx_messages_unread       ON messages(is_read_by_staff) WHERE is_read_by_staff = false;

CREATE TABLE IF NOT EXISTS products (
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
);

CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);

CREATE INDEX IF NOT EXISTS idx_products_school_name ON products(school_name) WHERE school_name IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_products_updated_at
 BEFORE UPDATE ON products
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS school_catalog (
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
);

CREATE INDEX IF NOT EXISTS idx_school_catalog_school ON school_catalog(school_name, sort_order);

CREATE OR REPLACE TRIGGER trg_school_catalog_updated_at
 BEFORE UPDATE ON school_catalog
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS quotations (
  id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              VARCHAR(30)      NOT NULL UNIQUE,
  client_id              UUID             NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  status                 quotation_status NOT NULL DEFAULT 'draft',
  line_items             JSONB            NOT NULL DEFAULT '[]',
  subtotal               NUMERIC(12,2)    NOT NULL DEFAULT 0,
  vat                    NUMERIC(12,2)    NOT NULL DEFAULT 0,
  total                  NUMERIC(12,2)    NOT NULL DEFAULT 0,
  currency               VARCHAR(3)       NOT NULL DEFAULT 'ZAR',
  notes                  TEXT,
  sla_remind_at          TIMESTAMPTZ,
  reminder_sent_at       TIMESTAMPTZ,
  approved_by            UUID             REFERENCES staff(id) ON DELETE SET NULL,
  approved_at            TIMESTAMPTZ,
  valid_until            DATE,
  needs_review           BOOLEAN          NOT NULL DEFAULT false,
  auto_quoted            BOOLEAN          NOT NULL DEFAULT false,
  assigned_staff_id      UUID             REFERENCES staff(id) ON DELETE SET NULL,
  claimed_at             TIMESTAMPTZ,
  notified_at            TIMESTAMPTZ,
  staff_reminder_sent_at TIMESTAMPTZ,
  created_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotations_client ON quotations(client_id);

CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);

CREATE INDEX IF NOT EXISTS idx_quotations_sla    ON quotations(sla_remind_at) WHERE reminder_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_quotations_unclaimed ON quotations(notified_at)
 WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_quotations_updated_at
 BEFORE UPDATE ON quotations
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS orders (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                 VARCHAR(30) NOT NULL UNIQUE,
  client_id                 UUID        NOT NULL REFERENCES clients(id)    ON DELETE RESTRICT,
  quotation_id              UUID        REFERENCES quotations(id)          ON DELETE SET NULL,
  client_type               client_type NOT NULL DEFAULT 'retail',
  stage                     TEXT        NOT NULL DEFAULT 'deposit_pending',
  is_on_hold                BOOLEAN     NOT NULL DEFAULT false,
  hold_reason               TEXT,
  po_number                 VARCHAR(100),
  tracking_number           VARCHAR(100),
  payment_status            TEXT        NOT NULL DEFAULT 'unpaid',
  deposit_amount            NUMERIC(12,2),
  balance_amount            NUMERIC(12,2),
  estimated_completion_date DATE,
  assigned_staff_id         UUID        REFERENCES staff(id)               ON DELETE SET NULL,
  proof_url                 TEXT,
  proof_status              TEXT        NOT NULL DEFAULT 'none',
  proof_notes               TEXT,
  proof_sent_at             TIMESTAMPTZ,
  material_notes            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  needs_review              BOOLEAN     NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_client    ON orders(client_id);

CREATE INDEX IF NOT EXISTS idx_orders_stage     ON orders(stage);

CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference);

CREATE INDEX IF NOT EXISTS idx_orders_staff     ON orders(assigned_staff_id);

CREATE INDEX IF NOT EXISTS idx_orders_on_hold   ON orders(is_on_hold) WHERE is_on_hold = true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_quotation
 ON orders(quotation_id) WHERE quotation_id IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_orders_updated_at
 BEFORE UPDATE ON orders
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS order_stage_history (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage      TEXT        NOT NULL,
  notes      TEXT,
  changed_by UUID        REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_stage_history_order ON order_stage_history(order_id);

CREATE TABLE IF NOT EXISTS order_size_entries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  person_name TEXT        NOT NULL,
  size        VARCHAR(50) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_size_entries_order ON order_size_entries(order_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID         NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  order_id     UUID         REFERENCES orders(id)              ON DELETE SET NULL,
  po_number    VARCHAR(100) NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'pending_review'
                            CHECK (status IN ('pending_review', 'valid', 'invalid')),
  notes        TEXT,
  validated_by UUID         REFERENCES staff(id)               ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_quotation ON purchase_orders(quotation_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_order     ON purchase_orders(order_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_created   ON purchase_orders(created_at DESC);

CREATE OR REPLACE TRIGGER trg_purchase_orders_updated_at
 BEFORE UPDATE ON purchase_orders
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS payments (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       payment_type  NOT NULL,
  amount     NUMERIC(12,2) NOT NULL,
  currency   VARCHAR(3)    NOT NULL DEFAULT 'ZAR',
  notes      TEXT,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS tickets (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID            NOT NULL REFERENCES clients(id)  ON DELETE RESTRICT,
  order_id          UUID            REFERENCES orders(id)            ON DELETE SET NULL,
  category          ticket_category NOT NULL,
  status            ticket_status   NOT NULL DEFAULT 'open',
  description       TEXT            NOT NULL,
  assigned_staff_id UUID            REFERENCES staff(id)             ON DELETE SET NULL,
  sla_due_at        TIMESTAMPTZ     NOT NULL,
  resolved_at       TIMESTAMPTZ,
  claimed_at        TIMESTAMPTZ,
  notified_at       TIMESTAMPTZ,
  reminder_sent_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE INDEX IF NOT EXISTS idx_tickets_client ON tickets(client_id);

CREATE INDEX IF NOT EXISTS idx_tickets_sla    ON tickets(sla_due_at) WHERE status NOT IN ('resolved','closed');

CREATE INDEX IF NOT EXISTS idx_tickets_unclaimed ON tickets(notified_at)
 WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_tickets_updated_at
 BEFORE UPDATE ON tickets
 FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS broadcasts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by         UUID        REFERENCES staff(id) ON DELETE SET NULL,
  message_type    TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  recipient_count INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC);

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS claimed_at             TIMESTAMPTZ;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS notified_at            TIMESTAMPTZ;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS staff_reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_url      TEXT;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_status   TEXT NOT NULL DEFAULT 'none';

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_notes    TEXT;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS proof_sent_at  TIMESTAMPTZ;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS material_notes JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS orders ALTER COLUMN stage SET DEFAULT 'deposit_pending';

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS auto_quoted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS quotations ADD COLUMN IF NOT EXISTS valid_until DATE;

CREATE TABLE IF NOT EXISTS broadcasts (
     id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     sent_by          UUID        REFERENCES staff(id) ON DELETE SET NULL,
     message_type     TEXT        NOT NULL,
     body             TEXT        NOT NULL,
     recipient_count  INT         NOT NULL DEFAULT 0,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC);

CREATE TABLE IF NOT EXISTS order_stage_history (
     id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id   UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     stage      TEXT        NOT NULL,
     notes      TEXT,
     changed_by UUID        REFERENCES staff(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

CREATE INDEX IF NOT EXISTS idx_order_stage_history_order ON order_stage_history(order_id);

CREATE TABLE IF NOT EXISTS order_size_entries (
     id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id    UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     person_name TEXT        NOT NULL,
     size        VARCHAR(50) NOT NULL,
     notes       TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

CREATE INDEX IF NOT EXISTS idx_order_size_entries_order ON order_size_entries(order_id);

CREATE TABLE IF NOT EXISTS school_catalog (
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
   );

CREATE INDEX IF NOT EXISTS idx_school_catalog_school ON school_catalog(school_name, sort_order);

CREATE OR REPLACE TRIGGER trg_school_catalog_updated_at
   BEFORE UPDATE ON school_catalog
   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS purchase_orders (
     id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     quotation_id UUID         NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
     order_id     UUID         REFERENCES orders(id)              ON DELETE SET NULL,
     po_number    VARCHAR(100) NOT NULL,
     status       TEXT         NOT NULL DEFAULT 'pending_review'
                               CHECK (status IN ('pending_review', 'valid', 'invalid')),
     notes        TEXT,
     validated_by UUID         REFERENCES staff(id)               ON DELETE SET NULL,
     created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   );

CREATE INDEX IF NOT EXISTS idx_purchase_orders_quotation ON purchase_orders(quotation_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_order     ON purchase_orders(order_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_created   ON purchase_orders(created_at DESC);

CREATE OR REPLACE TRIGGER trg_purchase_orders_updated_at
   BEFORE UPDATE ON purchase_orders
   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_quotations_unclaimed    ON quotations(notified_at)    WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_unclaimed       ON tickets(notified_at)       WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_unclaimed ON conversations(notified_at) WHERE assigned_staff_id IS NULL AND notified_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_conversation_per_client
   ON conversations(client_id) WHERE is_open = true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_quotation
   ON orders(quotation_id) WHERE quotation_id IS NOT NULL;

INSERT INTO sequence_counters (key, date_key, value)
   VALUES ('order', 'global', 0)
   ON CONFLICT (key, date_key) DO NOTHING;
