-- WalletSourceDB v4.2 Migration — Peak Duration Metric

-- Add peak duration to token_events (lifecycle analysis)
ALTER TABLE token_events
ADD COLUMN IF NOT EXISTS peak_duration_min REAL,  -- Temps entre peak et début du dump
ADD COLUMN IF NOT EXISTS peak_time TIMESTAMP;      -- Quand le peak a été atteint

-- Index pour queries rapides
CREATE INDEX IF NOT EXISTS idx_token_events_peak_duration 
  ON token_events(creator_wallet, peak_duration_min) 
  WHERE peak_duration_min IS NOT NULL;

COMMENT ON COLUMN token_events.peak_duration_min IS 
  'Duration between peak and dump start (5% drop) in minutes';

COMMENT ON COLUMN token_events.peak_time IS 
  'Timestamp when peak MC was reached';
