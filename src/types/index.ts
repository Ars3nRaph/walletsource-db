// Table: wallet_profiles
export interface WalletProfile {
  wallet_address: string;
  first_seen_at: Date;
  last_seen_at: Date;
  rug_count: number;
  survival_count: number;
  neutral_count: number;
  rug_rate: number; // GENERATED column
  taint_score: number;
  toxicity_score: number;
  risk_score: number;
  cartel_id: string | null;
  profile_vector: string; // JSON stringified
  strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
  rugger_playbook: RuggerPlaybook | null;
  playbook_confidence: number;
  playbook_updated_at: Date | null;
}

// Table: wallet_ancestry
export interface WalletAncestry {
  id: number;
  parent_wallet: string;
  child_wallet: string;
  funding_tx: string;
  funding_amount_sol: number;
  depth: number; // 0-3
  confidence: number; // 0-1
  detected_at: Date;
}

// Table: token_events
export interface TokenEvent {
  token_address: string;
  creator_wallet: string;
  detected_at: Date;
  checked_at: Date | null;
  verdict: 'RUG_NO_PAIR' | 'RUG_METRICS' | 'SUCCESS' | 'NEUTRAL' | null;
  fdv_at_detection: number | null;
  fdv_at_check: number | null;
  liquidity_at_check: number | null;
  price_change_5m: number | null;
  dexscreener_pair: string | null;
  p_exit_v1: number | null;
  p_exit_v2: number | null;
  // v4.0 — Tracking lifecycle (30 minutes)
  peak_mc: number | null;
  peak_at: Date | null;
  time_to_peak_min: number | null;
  time_to_rug_min: number | null;
  dump_speed_pct_per_min: number | null;
  liquidity_at_peak: number | null;
  liquidity_removed: number | null;
  buy_volume_before_dump: number | null;
  peak_price: number | null;
  rug_price: number | null;
  tracking_complete: boolean;
  snapshot_count: number;
  // v4.2 — Peak duration for SHORT timing
  peak_duration_min: number | null;
  peak_time: Date | null;
}

// Table: cartel_groups
export interface CartelGroup {
  cartel_id: string;
  name: string;
  wallet_count: number;
  total_rug_count: number;
  total_survival_count: number;
  avg_rug_rate: number;
  confidence_score: number;
  confidence_score_v2: number;
  auto_strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
}

// Table: taint_log
export interface TaintLog {
  id: number;
  wallet_address: string;
  source_token: string;
  points_applied: number;
  propagation_depth: number;
  reason: 'RUG_NO_PAIR' | 'RUG_METRICS';
  applied_at: Date;
}

// Table: monitoring_queue
export interface MonitoringQueue {
  id: number;
  token_address: string;
  creator_wallet: string;
  detected_at: Date;
  check_at: Date;
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'RETRY';
  retry_count: number;
  processed_at: Date | null;
}

// Table: calibration_log
export interface CalibrationLog {
  id: number;
  calibrated_at: Date;
  param_name: string;
  old_value: number;
  new_value: number;
  improvement_pct: number;
  tokens_evaluated: number;
  accepted: boolean;
}

// API Response Types
export interface DexScreenerPair {
  pairAddress: string;
  fdv: number | null;
  marketCap: number | null;
  priceUsd: string | null;
  liquidity: {
    usd: number | null;
    base: number | null;
    quote: number | null;
  };
  priceChange: {
    m1: number | null;
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  volume: {
    m1: number | null;
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  txns: {
    m1: { buys: number; sells: number } | null;
    m5: { buys: number; sells: number } | null;
    h1: { buys: number; sells: number } | null;
    h6: { buys: number; sells: number } | null;
    h24: { buys: number; sells: number } | null;
  };
  pairCreatedAt: number | null;
}

export interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // in lamports
}

export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  nativeTransfers: HeliusNativeTransfer[];
}

// Profile Vector (7 features)
export interface ProfileVector {
  rug_rate: number;
  taint_score: number;
  avg_token_lifespan: number; // hours
  cartel_rug_rate: number;
  ancestry_depth: number;
  funding_diversity: number; // unique sources / total funding txs
  token_frequency: number; // tokens launched per day
}

// Table: token_snapshots (v4.0)
export interface TokenSnapshot {
  id: number;
  token_address: string;
  snapshot_at: Date;
  fdv: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  price_change_5m: number | null;
  volume_5m: number | null;
  buy_count_5m: number | null;
  sell_count_5m: number | null;
}

// Rugger Playbook (v4.0)
export interface RuggerPlaybook {
  // ── Core identity ──────────────────────────────────────
  sample_size: number;
  recommended_strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
  consistency_score: number;           // 1 - CV(time_to_rug) — predictability

  // ── Timing — minutes (legacy, kept for TradeExecutor compat) ──
  avg_time_to_peak_min: number;
  std_time_to_peak_min: number;
  avg_time_to_rug_min: number;
  std_time_to_rug_min: number;
  avg_peak_duration_min: number;       // v4.2
  std_peak_duration_min: number;       // v4.2

  // ── Timing — seconds (tick-level precision, v4.4) ─────
  avg_time_to_peak_sec: number | null;
  std_time_to_peak_sec: number | null;
  avg_time_to_rug_sec: number | null;
  std_time_to_rug_sec: number | null;
  avg_first_sell_delay_sec: number | null; // delay créateur → 1er sell
  avg_rug_duration_sec: number | null;     // durée de la chute
  consistency_score_sec: number | null;    // consistance timing secondes

  // ── Market cap ────────────────────────────────────────
  avg_peak_mc: number;
  std_peak_mc: number;
  avg_pump_multiple: number;           // v4.3 — peak/entry ratio
  avg_pump_speed_mc_per_sec: number | null; // vitesse de montée tick-level

  // ── Volume & liquidité ────────────────────────────────
  avg_dump_speed: number;              // legacy %/min
  avg_liquidity_at_peak: number;
  avg_total_buy_vol_usd: number | null;
  avg_total_sell_vol_usd: number | null;
  avg_buy_sell_ratio: number | null;   // pression nette buy vs sell
  avg_largest_sell_pct: number | null; // plus gros sell / peak MC

  // ── Comportement wallets ──────────────────────────────
  avg_buy_wallet_count: number | null;
  avg_sell_wallet_count: number | null;
  creator_sold_rate: number | null;    // % tokens où le créateur vend
  avg_top_buyer_pct: number | null;    // concentration achat
  avg_top_seller_pct: number | null;   // concentration vente

  // ── Pattern signatures ────────────────────────────────
  micro_buy_rate: number | null;       // % tokens avec bots micro-achat
  avg_cascade_score: number | null;    // intensité dump coordonné
  avg_pump_dump_speed_ratio: number | null; // pump lent vs dump rapide

  // ── Fenêtres d'entrée/sortie (minutes) ───────────────
  entry_window_end_min: number;
  exit_window_start_min: number;
  exit_window_end_min: number;
  short_window_start_min: number;
  short_window_end_min: number;
}
