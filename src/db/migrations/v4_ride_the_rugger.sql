-- MIGRATION v3.0 → v4.0 — Ride the Rugger
-- Execute this migration to upgrade from v3.0 to v4.0

-- 1. CREATE TABLE token_snapshots
-- Stores price/liquidity snapshots every 30 seconds during token tracking (30 minutes)
CREATE TABLE IF NOT EXISTS token_snapshots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES token_events(token_address) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL,
  fdv REAL,
  liquidity_usd REAL,
  price_usd REAL,
  price_change_5m REAL,
  volume_5m REAL,
  buy_count_5m INTEGER,
  sell_count_5m INTEGER
);

CREATE INDEX idx_snapshots_token ON token_snapshots(token_address, snapshot_at);

-- 2. ALTER TABLE token_events — Add 12 columns for tracking lifecycle
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS peak_mc REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS peak_at TIMESTAMPTZ;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS time_to_peak_min REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS time_to_rug_min REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS dump_speed_pct_per_min REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS liquidity_at_peak REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS liquidity_removed REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS buy_volume_before_dump REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS peak_price REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS rug_price REAL;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS tracking_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE token_events ADD COLUMN IF NOT EXISTS snapshot_count INTEGER DEFAULT 0;

-- 3. ALTER TABLE wallet_profiles — Add rugger playbook
ALTER TABLE wallet_profiles ADD COLUMN IF NOT EXISTS rugger_playbook JSONB;
ALTER TABLE wallet_profiles ADD COLUMN IF NOT EXISTS playbook_confidence REAL DEFAULT 0;
ALTER TABLE wallet_profiles ADD COLUMN IF NOT EXISTS playbook_updated_at TIMESTAMPTZ;

-- 4. Update strategy constraint to include new values (RIDE, FADE)
-- Note: PostgreSQL doesn't support ALTER CONSTRAINT directly, so we drop and recreate
ALTER TABLE wallet_profiles DROP CONSTRAINT IF EXISTS wallet_profiles_strategy_check;
ALTER TABLE wallet_profiles ADD CONSTRAINT wallet_profiles_strategy_check
  CHECK (strategy IN ('RIDE', 'FADE', 'WATCH', 'AVOID'));

-- Migration complete
-- New rate limit: 300 req/min (DexScreener)
-- Tracking duration: 30 minutes (was 15 minutes)
