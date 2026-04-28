-- Add tx_status to activity_events for pending/confirmed/finalized animation
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS tx_status VARCHAR(20) DEFAULT 'finalized';

-- Add tx_status to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_status VARCHAR(20) DEFAULT 'finalized';
