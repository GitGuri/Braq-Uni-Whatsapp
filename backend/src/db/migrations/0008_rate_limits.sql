-- 0008 shared rate-limit counters (login brute-force guard) so limits hold
-- across API instances. Keys are hashed (no IPs / emails stored). Additive only.
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT        PRIMARY KEY,
  count    INT         NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits (reset_at);
