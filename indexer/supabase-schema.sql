-- ENACT Protocol Indexer Schema
-- Run this in Supabase SQL Editor

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL,
  factory_type VARCHAR(4) NOT NULL CHECK (factory_type IN ('ton', 'usdt')),
  address VARCHAR(66) NOT NULL UNIQUE,
  factory_address VARCHAR(66) NOT NULL,
  state INTEGER NOT NULL DEFAULT 0,
  state_name VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  client VARCHAR(66) NOT NULL,
  provider VARCHAR(66),
  evaluator VARCHAR(66) NOT NULL,
  budget BIGINT NOT NULL DEFAULT 0,
  budget_formatted VARCHAR(50),
  desc_hash VARCHAR(64) NOT NULL,
  result_hash VARCHAR(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  timeout INTEGER NOT NULL DEFAULT 86400,
  created_at INTEGER NOT NULL DEFAULT 0,
  eval_timeout INTEGER NOT NULL DEFAULT 86400,
  submitted_at INTEGER NOT NULL DEFAULT 0,
  result_type INTEGER DEFAULT 0,
  description_text TEXT,
  description_ipfs_url TEXT,
  result_text TEXT,
  result_ipfs_url TEXT,
  reason_text TEXT,
  reason_ipfs_url TEXT,
  reason_hash VARCHAR(64),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, factory_type)
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  job_address VARCHAR(66) NOT NULL,
  tx_hash VARCHAR(128) NOT NULL UNIQUE,
  fee VARCHAR(20),
  utime INTEGER NOT NULL,
  opcode INTEGER,
  event_type VARCHAR(20),
  from_address VARCHAR(66),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity events (denormalized feed)
CREATE TABLE IF NOT EXISTS activity_events (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL,
  factory_type VARCHAR(4) NOT NULL,
  job_address VARCHAR(66) NOT NULL,
  event VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  time INTEGER NOT NULL,
  amount VARCHAR(50),
  from_address VARCHAR(66),
  tx_hash VARCHAR(128),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexer state tracking
CREATE TABLE IF NOT EXISTS indexer_state (
  factory_address VARCHAR(66) PRIMARY KEY,
  last_job_count INTEGER DEFAULT 0,
  last_lt VARCHAR(40) DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
CREATE INDEX IF NOT EXISTS idx_jobs_evaluator ON jobs(evaluator);
CREATE INDEX IF NOT EXISTS idx_jobs_factory ON jobs(factory_type);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_job ON transactions(job_address);
CREATE INDEX IF NOT EXISTS idx_tx_utime ON transactions(utime DESC);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_events(time DESC);
CREATE INDEX IF NOT EXISTS idx_activity_job ON activity_events(job_address);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE activity_events;

-- RLS: allow anonymous reads, restrict writes to service role
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE indexer_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read jobs" ON jobs FOR SELECT USING (true);
CREATE POLICY "Service write jobs" ON jobs FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Public read transactions" ON transactions FOR SELECT USING (true);
CREATE POLICY "Service write transactions" ON transactions FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Public read activity" ON activity_events FOR SELECT USING (true);
CREATE POLICY "Service write activity" ON activity_events FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service manage indexer_state" ON indexer_state FOR ALL USING (auth.role() = 'service_role');

-- Stats function for charts
CREATE OR REPLACE FUNCTION get_daily_stats()
RETURNS TABLE (
  day DATE,
  factory_type VARCHAR,
  job_count BIGINT,
  volume BIGINT
) AS $$
  SELECT DATE(to_timestamp(created_at)) as day,
         factory_type,
         COUNT(*) as job_count,
         COALESCE(SUM(budget), 0) as volume
  FROM jobs
  WHERE created_at > 0
  GROUP BY day, factory_type
  ORDER BY day ASC;
$$ LANGUAGE SQL STABLE;
