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
  strategy: 'AVOID' | 'SHORT' | 'WATCH' | 'LONG';
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
  fdv_at_check: number | null;
  liquidity_at_check: number | null;
  price_change_5m: number | null;
  dexscreener_pair: string | null;
  p_exit_v1: number | null;
  p_exit_v2: number | null;
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
  auto_strategy: 'AVOID' | 'SHORT' | 'WATCH' | 'LONG';
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
  fdv: number;
  liquidity: { usd: number };
  priceChange: { m5: number };
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
