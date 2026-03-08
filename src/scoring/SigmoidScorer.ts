import type { WalletProfile, CartelGroup, ProfileVector } from '../types/index.js';

// Constants from PRD section 7
const TAINT_MU = 100; // μ for toxicity sigmoid
const TAINT_SIGMA = 40; // σ for toxicity sigmoid
const CONFIDENCE_K = 6.0; // k for cartel confidence v2
const N_MIN = 10; // minimum tokens for full cartel confidence
const RISK_WEIGHTS = {
  rug_rate: 0.40,
  toxicity: 0.35,
  cartel: 0.25
};
const RISK_K_RUG = 6.0;
const RISK_K_CARTEL = 5.0;

// Profile vector feature weights from PRD section 6
const PROFILE_WEIGHTS = {
  rug_rate: 3.0,
  taint_score: 2.0,
  avg_token_lifespan: 1.0,
  cartel_rug_rate: 2.5,
  ancestry_depth: 0.5,
  funding_diversity: 1.0,
  token_frequency: 1.5
};

/**
 * Basic sigmoid function: 1 / (1 + e^(-k * x))
 * @param x - Input value
 * @param k - Steepness parameter (default: 1)
 * @returns Sigmoid output in range [0, 1]
 */
export function sigmoid(x: number, k: number = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}

/**
 * Compute toxicity score from taint score using sigmoid normalization.
 * Formula: sigmoid((taintScore - μ) / σ) where μ=100, σ=40
 *
 * Examples from PRD section 7.2:
 * - taint=0   → 0.076
 * - taint=50  → 0.224
 * - taint=100 → 0.500
 * - taint=200 → 0.924
 *
 * @param taintScore - Raw taint score (0+)
 * @returns Toxicity score in range [0, 1]
 */
export function computeToxicity(taintScore: number): number {
  return sigmoid((taintScore - TAINT_MU) / TAINT_SIGMA);
}

/**
 * Compute cartel confidence score v2 using sigmoid and token count penalty.
 * Formula: sigmoid(k × (survivalRate - 0.5)) × min(1, totalTokens / N_min)
 *
 * @param survivalRate - Cartel survival rate (0-1)
 * @param totalTokens - Total tokens created by cartel
 * @returns Confidence score in range [0, 1]
 */
export function computeCartelConfidenceV2(survivalRate: number, totalTokens: number): number {
  const tokenPenalty = Math.min(1, totalTokens / N_MIN);
  return sigmoid(CONFIDENCE_K * (survivalRate - 0.5)) * tokenPenalty;
}

/**
 * Compute composite risk score from wallet metrics.
 * Formula: w1 × sigmoid(k1 × (rugRate - 0.5))
 *        + w2 × toxicityScore
 *        + w3 × sigmoid(k3 × (cartelRugRate - 0.5))
 *
 * Weights: rug_rate=0.40, toxicity=0.35, cartel=0.25
 *
 * @param rugRate - Wallet's rug rate (0-1)
 * @param toxicityScore - Pre-computed toxicity score (0-1)
 * @param cartelRugRate - Cartel's average rug rate (0-1, 0 if no cartel)
 * @returns Risk score in range [0, 1]
 */
export function computeRiskScore(
  rugRate: number,
  toxicityScore: number,
  cartelRugRate: number
): number {
  const rugComponent = RISK_WEIGHTS.rug_rate * sigmoid(RISK_K_RUG * (rugRate - 0.5));
  const toxicityComponent = RISK_WEIGHTS.toxicity * toxicityScore;
  const cartelComponent = RISK_WEIGHTS.cartel * sigmoid(RISK_K_CARTEL * (cartelRugRate - 0.5));

  return rugComponent + toxicityComponent + cartelComponent;
}

/**
 * Map risk score to trading strategy.
 * Ranges from PRD section 7.3 (v4.0 updated):
 * - [0.00-0.25]: RIDE (exploit predictable ruggers)
 * - [0.25-0.50]: WATCH (insufficient data)
 * - [0.50-0.75]: FADE (short predictable dumps)
 * - [0.75-1.00]: AVOID (too risky/unpredictable)
 *
 * @param riskScore - Risk score (0-1)
 * @returns Trading strategy
 */
export function getStrategy(riskScore: number): 'RIDE' | 'WATCH' | 'FADE' | 'AVOID' {
  if (riskScore < 0.25) return 'RIDE';
  if (riskScore < 0.50) return 'WATCH';
  if (riskScore < 0.75) return 'FADE';
  return 'AVOID';
}

/**
 * Compute weighted profile vector for a wallet.
 * 7 features with weights from PRD section 6:
 * - rug_rate (×3.0)
 * - taint_score (×2.0)
 * - avg_token_lifespan (×1.0)
 * - cartel_rug_rate (×2.5)
 * - ancestry_depth (×0.5)
 * - funding_diversity (×1.0)
 * - token_frequency (×1.5)
 *
 * @param wallet - Wallet profile data
 * @param cartel - Optional cartel data for cartel_rug_rate
 * @returns Profile vector with weighted features
 */
export function computeProfileVector(wallet: WalletProfile, cartel?: CartelGroup): ProfileVector {
  return {
    rug_rate: wallet.rug_rate * PROFILE_WEIGHTS.rug_rate,
    taint_score: wallet.taint_score * PROFILE_WEIGHTS.taint_score,
    avg_token_lifespan: 0 * PROFILE_WEIGHTS.avg_token_lifespan, // TODO: calculate from token_events
    cartel_rug_rate: (cartel?.avg_rug_rate ?? 0) * PROFILE_WEIGHTS.cartel_rug_rate,
    ancestry_depth: 0 * PROFILE_WEIGHTS.ancestry_depth, // TODO: calculate from wallet_ancestry
    funding_diversity: 0 * PROFILE_WEIGHTS.funding_diversity, // TODO: calculate from wallet_ancestry
    token_frequency: 0 * PROFILE_WEIGHTS.token_frequency // TODO: calculate from token_events
  };
}

/**
 * Calculate cosine similarity between two profile vectors.
 * Used for cartel behavioral overlap detection.
 * Formula: (A · B) / (||A|| × ||B||)
 *
 * @param vec1 - First profile vector
 * @param vec2 - Second profile vector
 * @returns Cosine similarity in range [-1, 1], typically [0, 1] for positive features
 */
export function cosineSimilarity(vec1: ProfileVector, vec2: ProfileVector): number {
  // Convert vectors to arrays for calculation
  const a = [
    vec1.rug_rate,
    vec1.taint_score,
    vec1.avg_token_lifespan,
    vec1.cartel_rug_rate,
    vec1.ancestry_depth,
    vec1.funding_diversity,
    vec1.token_frequency
  ];

  const b = [
    vec2.rug_rate,
    vec2.taint_score,
    vec2.avg_token_lifespan,
    vec2.cartel_rug_rate,
    vec2.ancestry_depth,
    vec2.funding_diversity,
    vec2.token_frequency
  ];

  // Dot product
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);

  // Magnitudes
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  // Avoid division by zero
  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dotProduct / (magnitudeA * magnitudeB);
}
