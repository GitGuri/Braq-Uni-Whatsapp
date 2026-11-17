-- 0014 broadcast outcomes (audit MSG-5). Additive and idempotent.
-- One row per broadcast recipient send (the whatsapp.send job): recording an outcome
-- is idempotent (job_id primary key), so a retried job can never count twice, and a
-- send whose count was lost can be counted on its retry. broadcasts.sent_count /
-- failed_count are bumped in the same statement that inserts the outcome.
-- No foreign key to jobs: finished jobs are pruned after 14 days.
CREATE TABLE IF NOT EXISTS broadcast_outcomes (
  job_id       BIGINT      PRIMARY KEY,
  broadcast_id UUID        NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  outcome      TEXT        NOT NULL CHECK (outcome IN ('sent', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcast_outcomes_broadcast ON broadcast_outcomes (broadcast_id);
