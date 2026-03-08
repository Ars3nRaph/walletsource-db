-- Migration v4.0 — Add missing tables and columns
-- Run this on existing databases to upgrade schema

-- ━━━ Add token_snapshots table if not exists ━━━
CREATE TABLE IF NOT EXISTS token_snapshots (
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

-- Indexes for token_snapshots
CREATE INDEX IF NOT EXISTS idx_snapshot_token ON token_snapshots(token_address);
CREATE INDEX IF NOT EXISTS idx_snapshot_time ON token_snapshots(snapshot_at);
CREATE INDEX IF NOT EXISTS idx_snapshot_token_time ON token_snapshots(token_address, snapshot_at);

-- ━━━ Add playbook columns to wallet_profiles if not exists ━━━
DO $$
BEGIN
  -- Add rugger_playbook column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wallet_profiles' AND column_name = 'rugger_playbook'
  ) THEN
    ALTER TABLE wallet_profiles ADD COLUMN rugger_playbook JSONB;
  END IF;

  -- Add playbook_confidence column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wallet_profiles' AND column_name = 'playbook_confidence'
  ) THEN
    ALTER TABLE wallet_profiles ADD COLUMN playbook_confidence REAL CHECK (playbook_confidence BETWEEN 0 AND 1);
  END IF;

  -- Add playbook_updated_at column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wallet_profiles' AND column_name = 'playbook_updated_at'
  ) THEN
    ALTER TABLE wallet_profiles ADD COLUMN playbook_updated_at TIMESTAMP;
  END IF;
END $$;

-- ━━━ Verification ━━━
-- Check that all tables exist
DO $$
DECLARE
  missing_tables TEXT[];
BEGIN
  SELECT ARRAY_AGG(table_name)
  INTO missing_tables
  FROM (
    VALUES
      ('wallet_profiles'),
      ('wallet_ancestry'),
      ('token_events'),
      ('token_snapshots'),
      ('cartel_groups'),
      ('taint_log'),
      ('monitoring_queue'),
      ('calibration_log')
  ) AS expected(table_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = expected.table_name
  );

  IF array_length(missing_tables, 1) > 0 THEN
    RAISE EXCEPTION 'Missing tables: %', array_to_string(missing_tables, ', ');
  ELSE
    RAISE NOTICE '✓ All 8 tables present';
  END IF;
END $$;

-- ━━━ Summary ━━━
SELECT
  'Table Count' as metric,
  COUNT(*) as value
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'wallet_profiles', 'wallet_ancestry', 'token_events', 'token_snapshots',
    'cartel_groups', 'taint_log', 'monitoring_queue', 'calibration_log'
  )
UNION ALL
SELECT
  'wallet_profiles columns' as metric,
  COUNT(*) as value
FROM information_schema.columns
WHERE table_name = 'wallet_profiles'
  AND column_name IN ('rugger_playbook', 'playbook_confidence', 'playbook_updated_at')
UNION ALL
SELECT
  'token_snapshots exists' as metric,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'token_snapshots'
  ) THEN 1 ELSE 0 END as value;
