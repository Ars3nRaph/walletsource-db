-- WalletSourceDB v4.0 — Schema PostgreSQL
-- 8 tables: wallet_profiles, wallet_ancestry, token_events, token_snapshots, cartel_groups, taint_log, monitoring_queue, calibration_log

-- Drop tables if they exist (for idempotent schema loading)
DROP TABLE IF EXISTS calibration_log CASCADE;
DROP TABLE IF EXISTS monitoring_queue CASCADE;
DROP TABLE IF EXISTS taint_log CASCADE;
DROP TABLE IF EXISTS token_snapshots CASCADE;
DROP TABLE IF EXISTS token_events CASCADE;
DROP TABLE IF EXISTS wallet_ancestry CASCADE;
DROP TABLE IF EXISTS cartel_groups CASCADE;
DROP TABLE IF EXISTS wallet_profiles CASCADE;

-- 1. cartel_groups (no dependencies)
CREATE TABLE cartel_groups (
  cartel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wallet_count INTEGER NOT NULL DEFAULT 0,
  total_rug_count INTEGER NOT NULL DEFAULT 0,
  total_survival_count INTEGER NOT NULL DEFAULT 0,
  avg_rug_rate REAL NOT NULL DEFAULT 0,
  confidence_score REAL NOT NULL DEFAULT 0 CHECK (confidence_score BETWEEN 0 AND 1),
  confidence_score_v2 REAL NOT NULL DEFAULT 0 CHECK (confidence_score_v2 BETWEEN 0 AND 1),
  auto_strategy TEXT NOT NULL DEFAULT 'WATCH' CHECK (auto_strategy IN ('RIDE', 'FADE', 'WATCH', 'AVOID'))
);

-- 2. wallet_profiles (depends on cartel_groups)
CREATE TABLE wallet_profiles (
  wallet_address TEXT PRIMARY KEY,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rug_count INTEGER NOT NULL DEFAULT 0,
  survival_count INTEGER NOT NULL DEFAULT 0,
  neutral_count INTEGER NOT NULL DEFAULT 0,
  rug_rate REAL NOT NULL DEFAULT 0,
  taint_score REAL NOT NULL DEFAULT 0,
  toxicity_score REAL NOT NULL DEFAULT 0.5 CHECK (toxicity_score BETWEEN 0 AND 1),
  risk_score REAL NOT NULL DEFAULT 0.5 CHECK (risk_score BETWEEN 0 AND 1),
  cartel_id TEXT REFERENCES cartel_groups(cartel_id) ON DELETE SET NULL,
  profile_vector TEXT NOT NULL DEFAULT '{}',
  strategy TEXT NOT NULL DEFAULT 'WATCH' CHECK (strategy IN ('RIDE', 'FADE', 'WATCH', 'AVOID')),
  -- v4.0 Playbook columns
  rugger_playbook JSONB,
  playbook_confidence REAL CHECK (playbook_confidence BETWEEN 0 AND 1),
  playbook_updated_at TIMESTAMP
);

-- 3. wallet_ancestry (depends on wallet_profiles)
CREATE TABLE wallet_ancestry (
  id SERIAL PRIMARY KEY,
  parent_wallet TEXT NOT NULL REFERENCES wallet_profiles(wallet_address) ON DELETE CASCADE,
  child_wallet TEXT NOT NULL REFERENCES wallet_profiles(wallet_address) ON DELETE CASCADE,
  funding_tx TEXT NOT NULL,
  funding_amount_sol REAL NOT NULL,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 3),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ancestry_child ON wallet_ancestry(child_wallet);
CREATE INDEX idx_ancestry_parent ON wallet_ancestry(parent_wallet);
CREATE INDEX idx_ancestry_depth ON wallet_ancestry(depth);

-- 4. token_events (depends on wallet_profiles)
CREATE TABLE token_events (
  token_address TEXT PRIMARY KEY,
  creator_wallet TEXT NOT NULL REFERENCES wallet_profiles(wallet_address) ON DELETE CASCADE,
  detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_at TIMESTAMP,
  verdict TEXT,
  fdv_at_check REAL,
  liquidity_at_check REAL,
  price_change_5m REAL,
  dexscreener_pair TEXT,
  p_exit_v1 REAL,
  p_exit_v2 REAL,
  -- v4.2 lifecycle analysis columns
  peak_mc REAL,
  peak_at TIMESTAMP,
  peak_price REAL,
  time_to_peak_min REAL,
  time_to_rug_min REAL,
  dump_speed_pct_per_min REAL,
  liquidity_at_peak REAL,
  liquidity_removed REAL,
  buy_volume_before_dump REAL,
  rug_price REAL,
  tracking_complete BOOLEAN DEFAULT FALSE,
  snapshot_count INTEGER DEFAULT 0,
  peak_duration_min REAL,
  peak_time TIMESTAMP
);

CREATE INDEX idx_token_creator ON token_events(creator_wallet);
CREATE INDEX idx_token_verdict ON token_events(verdict);

-- 4b. token_snapshots (depends on token_events) — v4.0 NEW
CREATE TABLE token_snapshots (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES token_events(token_address) ON DELETE CASCADE,
  snapshot_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fdv REAL,
  liquidity_usd REAL,
  price_usd REAL,
  price_change_5m REAL,
  volume_5m REAL,
  buy_count_5m INTEGER,
  sell_count_5m INTEGER,
  txns_5m_buys INTEGER,
  txns_5m_sells INTEGER
);

CREATE INDEX idx_snapshot_token ON token_snapshots(token_address);
CREATE INDEX idx_snapshot_time ON token_snapshots(snapshot_at);
CREATE INDEX idx_snapshot_token_time ON token_snapshots(token_address, snapshot_at);

-- 5. taint_log (depends on wallet_profiles and token_events)
CREATE TABLE taint_log (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL REFERENCES wallet_profiles(wallet_address) ON DELETE CASCADE,
  source_token TEXT NOT NULL REFERENCES token_events(token_address) ON DELETE CASCADE,
  points_applied REAL NOT NULL,
  propagation_depth INTEGER NOT NULL CHECK (propagation_depth BETWEEN 0 AND 3),
  reason TEXT NOT NULL CHECK (reason IN ('RUG_NO_PAIR', 'RUG_METRICS')),
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_taint_wallet ON taint_log(wallet_address);
CREATE INDEX idx_taint_source ON taint_log(source_token);

-- 6. monitoring_queue (depends on wallet_profiles)
CREATE TABLE monitoring_queue (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL UNIQUE,
  creator_wallet TEXT NOT NULL REFERENCES wallet_profiles(wallet_address) ON DELETE CASCADE,
  detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  check_at TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'RETRY')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  processed_at TIMESTAMP
);

CREATE INDEX idx_monitoring_check_at ON monitoring_queue(check_at);
CREATE INDEX idx_monitoring_status ON monitoring_queue(status);
CREATE INDEX idx_monitoring_status_check ON monitoring_queue(status, check_at);

-- 7. calibration_log (no dependencies)
CREATE TABLE calibration_log (
  id SERIAL PRIMARY KEY,
  calibrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  param_name TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  improvement_pct REAL NOT NULL,
  tokens_evaluated INTEGER NOT NULL,
  accepted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_calibration_date ON calibration_log(calibrated_at);
CREATE INDEX idx_calibration_param ON calibration_log(param_name);
