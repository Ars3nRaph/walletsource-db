-- Test impact of depth 2 vs depth 3 for cartel detection

-- Current state with depth 0-1
SELECT
  'Current Coverage' as metric,
  COUNT(DISTINCT parent_wallet) as funders,
  COUNT(DISTINCT child_wallet) as ruggers,
  SUM(CASE WHEN depth = 0 THEN 50.0
           WHEN depth = 1 THEN 35.0
           WHEN depth = 2 THEN 24.5
      END) as total_taint_potential
FROM wallet_ancestry;

-- Simulate depth 3 impact (if we had continued)
-- Estimate: assume 50% of depth 1 funders have depth 2 parents
-- and 30% of depth 2 would have depth 3 parents

WITH depth_projection AS (
  SELECT
    COUNT(DISTINCT parent_wallet) as depth1_funders
  FROM wallet_ancestry
  WHERE depth = 1
)
SELECT
  'Projected Depth 3' as metric,
  ROUND(depth1_funders * 0.5) as estimated_depth2_wallets,
  ROUND(depth1_funders * 0.5 * 0.3) as estimated_depth3_wallets,
  ROUND(depth1_funders * 0.5 * 17.15) as additional_taint_points,
  ROUND((depth1_funders * 0.5 * 17.15) / 109.5 * 100, 1) || '%' as taint_increase_pct
FROM depth_projection;

-- Check for potential multi-level cartels
-- (multiple ruggers funded by same depth 1 source)
SELECT
  parent_wallet as potential_cartel_master,
  COUNT(DISTINCT child_wallet) as rugger_count,
  STRING_AGG(DISTINCT child_wallet, ', ') as rugger_wallets
FROM wallet_ancestry
WHERE depth = 0
GROUP BY parent_wallet
HAVING COUNT(DISTINCT child_wallet) >= 2
ORDER BY rugger_count DESC;
