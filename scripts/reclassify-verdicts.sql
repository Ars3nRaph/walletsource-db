-- Reclassify tokens with corrected thresholds
-- Run with: docker exec walletsource-db psql -U walletsource -d walletsource -f /path/to/reclassify-verdicts.sql

BEGIN;

-- Track changes for reporting
CREATE TEMP TABLE verdict_changes AS
SELECT
  token_address,
  verdict as old_verdict,
  peak_mc,
  liquidity_at_peak,
  CASE
    -- RUG_NO_PAIR: vraiment mort (< 500$ FDV ET < 100$ liquidity)
    WHEN peak_mc < 500 AND COALESCE(liquidity_at_peak, 0) < 100 THEN 'RUG_NO_PAIR'

    -- RUG_METRICS: dump détecté (50%+ drop from peak OU liquidity removed)
    -- Déjà correctement classé, on garde
    WHEN verdict = 'RUG_METRICS' THEN 'RUG_METRICS'

    -- SUCCESS: > 30k FDV ET > 5k liquidity
    WHEN peak_mc > 30000 AND COALESCE(liquidity_at_peak, 0) > 5000 THEN 'SUCCESS'

    -- NEUTRAL: tout le reste (tokens entre 500$ et 30k$ sans dump)
    ELSE 'NEUTRAL'
  END as new_verdict
FROM token_events
WHERE verdict IS NOT NULL;

-- Show changes summary
SELECT
  old_verdict,
  new_verdict,
  COUNT(*) as count,
  ROUND(AVG(peak_mc)::numeric, 2) as avg_peak_mc,
  ROUND(AVG(liquidity_at_peak)::numeric, 2) as avg_liquidity
FROM verdict_changes
GROUP BY old_verdict, new_verdict
ORDER BY old_verdict, new_verdict;

-- Apply reclassification
UPDATE token_events te
SET verdict = vc.new_verdict
FROM verdict_changes vc
WHERE te.token_address = vc.token_address
  AND te.verdict <> vc.new_verdict; -- Only update if changed

-- Show final distribution
SELECT verdict, COUNT(*) as count
FROM token_events
WHERE verdict IS NOT NULL
GROUP BY verdict
ORDER BY count DESC;

COMMIT;
