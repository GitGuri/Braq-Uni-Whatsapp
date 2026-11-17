-- 0012 bot idempotency (audit DAT-2). Additive and idempotent; no existing row is changed.
--
-- A WhatsApp bot turn creates quotations / tickets / direct orders before its own
-- transaction commits. If the turn is replayed (worker crash, deploy, retry), the
-- same inbound event must not create a second record. Each record the bot creates
-- carries the inbound_events.id that caused it; the unique index makes a replay
-- find the existing record instead of inserting a new one.
-- (Direct orders are keyed through their accepted quotation: uniq_orders_quotation.)
-- No foreign key: inbound_events is an operational log.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS source_event_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotations_source_event
  ON quotations (source_event_id) WHERE source_event_id IS NOT NULL;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_event_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_source_event
  ON tickets (source_event_id) WHERE source_event_id IS NOT NULL;
