-- Add result_encrypted flag for E2E encrypted results
-- When true, the explorer shows "E2E Encrypted" badge instead of "Loading from IPFS..."
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_encrypted BOOLEAN DEFAULT FALSE;

-- Add pending_state for WS live status badges (Processing.../Confirming...)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_state VARCHAR(50);

-- Add file attachment columns for description and result
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_file_cid VARCHAR(128);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_file_name VARCHAR(256);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_file_cid VARCHAR(128);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_file_name VARCHAR(256);
