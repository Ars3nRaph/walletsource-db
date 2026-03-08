-- WalletSourceDB v4.0 Migration — "Ride the Rugger"
-- Add token_snapshots table and rugger_playbook fields

-- Add rugger playbook fields to wallet_profiles
ALTER TABLE wallet_profiles 
ADD COLUMN IF NOT EXISTS rugger_playbook JSONB,
ADD COLUMN IF NOT EXISTS playbook_confidence REAL CHECK (playbook_confidence BETWEEN 0 AND 1),
ADD COLUMN IF NOT EXISTS playbook_updated_at TIMESTAMP;

-- Create token_snapshots table for 30-minute tracking
CREATE TABLE IF NOT EXISTS token_snapshots (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES token_events(token_address) ON DELETE CASCADE,
  snapshot_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fdv REAL,
  liquidity REAL,
  price_change_5m REAL,
  holder_count INTEGER,
  peak_detected BOOLEAN DEFAULT FALSE,
  dump_detected BOOLEAN DEFAULT FALSE,
  UNIQUE(token_address, snapshot_at)
);

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_token_snapshots_token ON token_snapshots(token_address);
CREATE INDEX IF NOT EXISTS idx_token_snapshots_time ON token_snapshots(snapshot_at DESC);

-- Add lifecycle analysis fields to token_events
ALTER TABLE token_events
ADD COLUMN IF NOT EXISTS peak_mc REAL,
ADD COLUMN IF NOT EXISTS time_to_peak_min REAL,
ADD COLUMN IF NOT EXISTS time_to_rug_min REAL,
ADD COLUMN IF NOT EXISTS dump_speed_pct_per_min REAL,
ADD COLUMN IF NOT EXISTS liquidity_at_peak REAL;
