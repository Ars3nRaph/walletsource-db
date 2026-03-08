-- WalletSourceDB v4.1 Migration — Price & Liquidity Metrics

-- Add price/MC metrics to token_events
ALTER TABLE token_events
ADD COLUMN IF NOT EXISTS mc_at_detection REAL,
ADD COLUMN IF NOT EXISTS liquidity_at_detection REAL,
ADD COLUMN IF NOT EXISTS price_at_detection REAL,
ADD COLUMN IF NOT EXISTS peak_multiplier REAL,       -- peak_mc / mc_at_detection
ADD COLUMN IF NOT EXISTS dump_percentage REAL,       -- % drop from peak
ADD COLUMN IF NOT EXISTS liquidity_removed_pct REAL; -- % liquidity removed

-- Add price metrics to token_snapshots for real-time detection
ALTER TABLE token_snapshots
ADD COLUMN IF NOT EXISTS price REAL,
ADD COLUMN IF NOT EXISTS volume_5m REAL,
ADD COLUMN IF NOT EXISTS buy_pressure REAL;  -- buy_volume / total_volume

-- Index for fast peak/dump detection queries
CREATE INDEX IF NOT EXISTS idx_snapshots_peak_detection 
  ON token_snapshots(token_address, fdv DESC, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_liquidity 
  ON token_snapshots(token_address, liquidity DESC, snapshot_at DESC);
