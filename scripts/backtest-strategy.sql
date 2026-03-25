-- BACKTEST: Current vs Proposed Strategy Rules

-- 1. Current strategy performance
WITH wallet_stats AS (
  SELECT wp.strategy, te.token_address,
    te.peak_mc / NULLIF(te.fdv_at_detection, 0) AS pump_ratio
  FROM wallet_profiles wp
  JOIN token_events te ON te.creator_wallet = wp.wallet_address
  WHERE te.fdv_at_detection > 0 AND te.peak_mc > 0
)
SELECT strategy, COUNT(*) AS tokens,
  COUNT(*) FILTER (WHERE pump_ratio >= 1.5) AS pumps,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pump_ratio >= 1.5) / NULLIF(COUNT(*), 0), 1) AS pump_rate,
  COUNT(*) FILTER (WHERE pump_ratio >= 2.0) AS pumps_2x,
  ROUND(AVG(CASE WHEN pump_ratio < 1.0 THEN pump_ratio - 1 ELSE LEAST(pump_ratio, 1.5) - 1 END)::numeric * 100, 1) AS avg_pnl_pct
FROM wallet_stats GROUP BY strategy ORDER BY avg_pnl_pct DESC;

-- 2. RIDE survival impact
WITH ride_data AS (
  SELECT wp.wallet_address, wp.survival_count, wp.rug_rate,
    COUNT(te.*) AS total, COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 1.5) AS pumps
  FROM wallet_profiles wp JOIN token_events te ON te.creator_wallet = wp.wallet_address
  WHERE wp.strategy = 'RIDE' AND te.fdv_at_detection > 0 AND te.peak_mc > 0
  GROUP BY wp.wallet_address, wp.survival_count, wp.rug_rate HAVING COUNT(te.*) >= 3
)
SELECT CASE WHEN survival_count = 0 THEN 'surv=0' WHEN survival_count BETWEEN 1 AND 3 THEN 'surv=1-3'
  WHEN survival_count BETWEEN 4 AND 9 THEN 'surv=4-9' ELSE 'surv=10+' END AS bucket,
  COUNT(*) AS wallets, SUM(total) AS tokens, SUM(pumps) AS pump_tokens,
  ROUND(100.0 * SUM(pumps) / NULLIF(SUM(total), 0), 1) AS pump_rate,
  ROUND(AVG(rug_rate)::numeric, 3) AS avg_rug_rate
FROM ride_data GROUP BY 1 ORDER BY pump_rate DESC;

-- 3. Threshold sweep
WITH eligible AS (
  SELECT wp.wallet_address, wp.survival_count AS surv, wp.rug_rate AS rr, wp.rug_count,
    (wp.rugger_playbook->>'avg_pump_multiple')::float AS pump_x,
    COUNT(te.*) AS tokens,
    COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 1.5) AS pumps
  FROM wallet_profiles wp JOIN token_events te ON te.creator_wallet = wp.wallet_address
  WHERE (wp.strategy IN ('RIDE','FADE','WATCH') OR (wp.rug_count = 0 AND wp.survival_count >= 3))
    AND te.fdv_at_detection > 0 AND te.peak_mc > 0
  GROUP BY wp.wallet_address, wp.survival_count, wp.rug_rate, wp.rug_count, wp.rugger_playbook
  HAVING COUNT(te.*) >= 3
)
SELECT label, COUNT(*) AS wallets, SUM(tokens) AS tokens, SUM(pumps) AS pumps,
  ROUND(100.0 * SUM(pumps) / NULLIF(SUM(tokens), 0), 1) AS pump_rate,
  ROUND((100.0 * SUM(pumps) / NULLIF(SUM(tokens), 0) * 0.50 - 
    (100 - 100.0 * SUM(pumps) / NULLIF(SUM(tokens), 0)) * 0.15)::numeric, 1) AS est_ev_pct
FROM eligible,
LATERAL (VALUES
  ('ALL_RIDE_FADE', strategy_in(wallet_address)),
  ('surv>=1', surv >= 1),
  ('surv>=2', surv >= 2),
  ('surv>=3', surv >= 3),
  ('rr<=0.85', rr <= 0.85),
  ('rr<=0.80', rr <= 0.80),
  ('clean(rr=0)', rug_count = 0),
  ('clean+surv>=3', rug_count = 0 AND surv >= 3),
  ('clean+surv>=5', rug_count = 0 AND surv >= 5),
  ('surv>=1+rr<=0.85', surv >= 1 AND rr <= 0.85),
  ('surv>=1+rr<=0.80', surv >= 1 AND rr <= 0.80),
  ('pump_x>=3+surv>=1', pump_x >= 3 AND surv >= 1),
  ('pump_x>=5+surv>=1', pump_x >= 5 AND surv >= 1),
  ('COMBINED: clean5 OR s1+rr85', (rug_count = 0 AND surv >= 5) OR (surv >= 1 AND rr <= 0.85)),
  ('COMBINED: clean3 OR s1+rr80', (rug_count = 0 AND surv >= 3) OR (surv >= 1 AND rr <= 0.80))
) AS combos(label, included)
WHERE included
GROUP BY label ORDER BY est_ev_pct DESC;

-- 4. Proposed new strategy classification
WITH proposed AS (
  SELECT wp.wallet_address,
    CASE
      WHEN wp.rug_count = 0 AND wp.survival_count >= 3 THEN 'CLEAN_RIDE'
      WHEN (wp.rugger_playbook->>'consistency_score')::float >= 0.7
        AND (wp.rugger_playbook->>'sample_size')::int >= 5
        AND (wp.rugger_playbook->>'avg_pump_multiple')::float >= 1.5
        AND wp.survival_count >= 1 THEN 'RIDE_v2'
      WHEN (wp.rugger_playbook->>'avg_pump_multiple')::float >= 2.0
        AND (wp.rugger_playbook->>'sample_size')::int >= 3
        AND (wp.rugger_playbook->>'avg_peak_mc')::float >= 2000
        AND wp.survival_count >= 1 THEN 'RIDE_v2'
      WHEN (wp.rugger_playbook->>'consistency_score')::float >= 0.6
        AND (wp.rugger_playbook->>'sample_size')::int >= 5
        AND (wp.rugger_playbook->>'avg_pump_multiple')::float >= 1.5
        AND wp.rug_rate <= 0.90 THEN 'FADE_v2'
      WHEN wp.rug_rate > 0.95 THEN 'AVOID_v2'
      ELSE 'WATCH_v2'
    END AS new_strat
  FROM wallet_profiles wp WHERE wp.rugger_playbook IS NOT NULL
)
SELECT p.new_strat, COUNT(DISTINCT p.wallet_address) AS wallets, COUNT(te.*) AS tokens,
  COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 1.5) AS pumps,
  ROUND(100.0 * COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 1.5) / NULLIF(COUNT(te.*), 0), 1) AS pump_rate,
  ROUND(AVG(CASE WHEN te.peak_mc / NULLIF(te.fdv_at_detection, 0) < 1.0 
    THEN te.peak_mc / NULLIF(te.fdv_at_detection, 0) - 1
    ELSE LEAST(te.peak_mc / NULLIF(te.fdv_at_detection, 0), 1.5) - 1 END)::numeric * 100, 1) AS avg_pnl_pct
FROM proposed p
JOIN token_events te ON te.creator_wallet = p.wallet_address
WHERE te.fdv_at_detection > 0 AND te.peak_mc > 0
GROUP BY p.new_strat ORDER BY avg_pnl_pct DESC;

-- 5. Transition matrix
WITH proposed AS (
  SELECT wp.wallet_address, wp.strategy AS old_s,
    CASE
      WHEN wp.rug_count = 0 AND wp.survival_count >= 3 THEN 'CLEAN_RIDE'
      WHEN (wp.rugger_playbook->>'consistency_score')::float >= 0.7
        AND (wp.rugger_playbook->>'sample_size')::int >= 5
        AND (wp.rugger_playbook->>'avg_pump_multiple')::float >= 1.5
        AND wp.survival_count >= 1 THEN 'RIDE_v2'
      WHEN (wp.rugger_playbook->>'avg_pump_multiple')::float >= 2.0
        AND (wp.rugger_playbook->>'sample_size')::int >= 3
        AND (wp.rugger_playbook->>'avg_peak_mc')::float >= 2000
        AND wp.survival_count >= 1 THEN 'RIDE_v2'
      WHEN (wp.rugger_playbook->>'consistency_score')::float >= 0.6
        AND (wp.rugger_playbook->>'sample_size')::int >= 5
        AND (wp.rugger_playbook->>'avg_pump_multiple')::float >= 1.5
        AND wp.rug_rate <= 0.90 THEN 'FADE_v2'
      WHEN wp.rug_rate > 0.95 THEN 'AVOID_v2'
      ELSE 'WATCH_v2'
    END AS new_s
  FROM wallet_profiles wp WHERE wp.rugger_playbook IS NOT NULL
)
SELECT old_s || ' -> ' || new_s AS transition, COUNT(*) AS wallets
FROM proposed GROUP BY 1 ORDER BY 1;

-- 6. Clean wallets deep dive
WITH clean AS (
  SELECT wp.wallet_address, wp.survival_count,
    COUNT(te.*) AS tokens,
    COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 1.5) AS pumps,
    COUNT(te.*) FILTER (WHERE te.peak_mc / NULLIF(te.fdv_at_detection, 0) >= 3.0) AS pumps_3x,
    ROUND(AVG(te.peak_mc)::numeric, 0) AS avg_peak_mc
  FROM wallet_profiles wp JOIN token_events te ON te.creator_wallet = wp.wallet_address
  WHERE wp.rug_count = 0 AND wp.survival_count >= 3 AND te.fdv_at_detection > 0 AND te.peak_mc > 0
  GROUP BY wp.wallet_address, wp.survival_count HAVING COUNT(te.*) >= 3
)
SELECT CASE WHEN survival_count >= 10 THEN '10+' WHEN survival_count >= 5 THEN '5-9' ELSE '3-4' END AS surv,
  COUNT(*) AS wallets, SUM(tokens) AS tokens, SUM(pumps) AS pumps,
  ROUND(100.0 * SUM(pumps) / NULLIF(SUM(tokens), 0), 1) AS pump_rate,
  SUM(pumps_3x) AS pumps_3x, ROUND(AVG(avg_peak_mc)::numeric, 0) AS avg_peak_mc
FROM clean GROUP BY 1 ORDER BY pump_rate DESC;
