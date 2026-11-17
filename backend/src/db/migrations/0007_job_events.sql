-- 0007 job_events: one row per lifecycle event that has no table of its own
-- (quotation created / sent / accepted / declined / revised / resent, proof
-- sent / approved / changes requested, purchase order recorded, ticket resolved).
-- Read by GET /api/jobs/:quotationId to build the job's history timeline.
-- Additive only.
CREATE TABLE IF NOT EXISTS job_events (
  id           BIGSERIAL   PRIMARY KEY,
  quotation_id UUID        REFERENCES quotations(id) ON DELETE CASCADE,
  order_id     UUID        REFERENCES orders(id)     ON DELETE CASCADE,
  type         TEXT        NOT NULL,
  actor_id     UUID        REFERENCES staff(id)      ON DELETE SET NULL,
  data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_events_quotation ON job_events (quotation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_events_order     ON job_events (order_id, created_at);
