-- 0002 durable Postgres job queue / outbox + inbound webhook event log.
-- Jobs are enqueued in the same transaction as the domain write (core/queue.js)
-- and claimed with FOR UPDATE SKIP LOCKED, FIFO per queue_key (workers/loop.js).

CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL   PRIMARY KEY,
  type         TEXT        NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'done', 'dead')),
  queue_key    TEXT,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 8,
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  last_error   TEXT,
  dedupe_key   TEXT        UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_ready     ON jobs (run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_queue_key ON jobs (queue_key, id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_running   ON jobs (locked_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS inbound_events (
  id              BIGSERIAL   PRIMARY KEY,
  meta_message_id TEXT        UNIQUE,
  phone           TEXT,
  kind            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
