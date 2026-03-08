-- Rebuild playbooks for wallets with 3+ RUGs after backfill
-- This will be called from a bash script in batches

-- Temporary function to rebuild a single wallet's playbook
-- (Simplified version - full rebuild will be done by PlaybookBuilder in TypeScript)

DO $$
DECLARE
  wallet_rec RECORD;
  rug_count INT;
  total_processed INT := 0;
BEGIN
  -- Get all wallets with 3+ RUGs
  FOR wallet_rec IN (
    SELECT creator_wallet, COUNT(*) as rugs
    FROM token_events
    WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      AND time_to_peak_min IS NOT NULL
      AND time_to_rug_min IS NOT NULL
    GROUP BY creator_wallet
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC
  )
  LOOP
    -- Log progress
    total_processed := total_processed + 1;
    IF total_processed % 10 = 0 THEN
      RAISE NOTICE 'Processed % wallets...', total_processed;
    END IF;

    -- Note: Actual playbook rebuild will be done by TypeScript PlaybookBuilder
    -- This SQL just marks wallets that need rebuilding
    UPDATE wallet_profiles
    SET playbook_updated_at = NULL -- Force rebuild
    WHERE wallet_address = wallet_rec.creator_wallet;
  END LOOP;

  RAISE NOTICE 'Marked % wallets for playbook rebuild', total_processed;
END $$;
