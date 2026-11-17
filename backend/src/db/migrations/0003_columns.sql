-- 0003 new nullable columns for the job lifecycle, outbox and overrides.
-- Additive only: ADD COLUMN IF NOT EXISTS, no table rewrite.

-- Orders: the order's own total (backfilled in 0004), links and delivery info
ALTER TABLE orders     ADD COLUMN IF NOT EXISTS total_amount    NUMERIC(12,2);
ALTER TABLE orders     ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE orders     ADD COLUMN IF NOT EXISTS delivery_type   TEXT;
ALTER TABLE orders     ADD COLUMN IF NOT EXISTS cancelled_at    TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

-- Messages: delivery status (Meta receipts) and the outbox job that sent it
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS job_id BIGINT UNIQUE;

-- Stage history: transition source and manager overrides
ALTER TABLE order_stage_history ADD COLUMN IF NOT EXISTS from_stage        TEXT;
ALTER TABLE order_stage_history ADD COLUMN IF NOT EXISTS override_reason   TEXT;
ALTER TABLE order_stage_history ADD COLUMN IF NOT EXISTS overridden_guards TEXT[];

-- Broadcasts: fan-out progress
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'done';
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS sent_count   INT;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS failed_count INT;

-- Tickets: how it was resolved
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT;
