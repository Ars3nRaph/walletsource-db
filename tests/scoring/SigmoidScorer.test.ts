import { describe, it, expect } from 'vitest';
import {
  sigmoid,
  computeToxicity,
  computeCartelConfidenceV2,
  computeRiskScore,
  getStrategy,
  computeProfileVector,
  cosineSimilarity
} from '../../src/scoring/SigmoidScorer.js';
import type { WalletProfile, CartelGroup } from '../../src/types/index.js';

describe('SigmoidScorer', () => {
  describe('sigmoid', () => {
    it('should compute basic sigmoid function', () => {
      expect(sigmoid(0)).toBeCloseTo(0.5, 2);
      expect(sigmoid(1)).toBeCloseTo(0.731, 2);
      expect(sigmoid(-1)).toBeCloseTo(0.269, 2);
      expect(sigmoid(5)).toBeCloseTo(0.993, 2);
      expect(sigmoid(-5)).toBeCloseTo(0.007, 2);
    });

    it('should apply steepness parameter k', () => {
      expect(sigmoid(0, 2)).toBeCloseTo(0.5, 2);
      expect(sigmoid(1, 2)).toBeCloseTo(0.881, 2);
      expect(sigmoid(1, 0.5)).toBeCloseTo(0.622, 2);
    });
  });

  describe('computeToxicity', () => {
    // Test values from PRD section 7.2
    it('should match PRD toxicity values for taint scores', () => {
      expect(computeToxicity(0)).toBeCloseTo(0.076, 2);
      expect(computeToxicity(50)).toBeCloseTo(0.224, 2);
      expect(computeToxicity(100)).toBeCloseTo(0.500, 2);
      expect(computeToxicity(200)).toBeCloseTo(0.924, 2);
    });

    it('should handle edge cases', () => {
      expect(computeToxicity(0)).toBeGreaterThan(0);
      expect(computeToxicity(0)).toBeLessThan(0.1);
      expect(computeToxicity(1000)).toBeGreaterThan(0.99);
      expect(computeToxicity(1000)).toBeLessThan(1.0);
    });
  });

  describe('computeCartelConfidenceV2', () => {
    it('should penalize cartels with few tokens', () => {
      // 5 tokens = 50% penalty
      const conf5 = computeCartelConfidenceV2(0.8, 5);
      const conf10 = computeCartelConfidenceV2(0.8, 10);

      expect(conf5).toBeLessThan(conf10);
      expect(conf10).toBeCloseTo(sigmoid(6.0 * (0.8 - 0.5)), 2);
    });

    it('should reward high survival rates', () => {
      const confLow = computeCartelConfidenceV2(0.3, 10);
      const confMid = computeCartelConfidenceV2(0.5, 10);
      const confHigh = computeCartelConfidenceV2(0.8, 10);

      expect(confLow).toBeLessThan(confMid);
      expect(confMid).toBeLessThan(confHigh);
    });

    it('should cap token penalty at 100% for N_min+ tokens', () => {
      const conf10 = computeCartelConfidenceV2(0.7, 10);
      const conf20 = computeCartelConfidenceV2(0.7, 20);

      expect(conf10).toBeCloseTo(conf20, 3);
    });
  });

  describe('computeRiskScore', () => {
    it('should return AVOID range for high-risk wallet', () => {
      // rug_rate=0.9, high toxicity, high cartel rug
      const toxicity = computeToxicity(200); // ~0.924
      const riskScore = computeRiskScore(0.9, toxicity, 0.85);

      expect(riskScore).toBeGreaterThan(0.75); // AVOID threshold
    });

    it('should return LONG range for low-risk wallet', () => {
      // rug_rate=0.1, low toxicity, no cartel
      const toxicity = computeToxicity(10); // ~0.11
      const riskScore = computeRiskScore(0.1, toxicity, 0.0);

      expect(riskScore).toBeLessThan(0.25); // LONG threshold
    });

    it('should weight components correctly', () => {
      // Test with isolated components (note: sigmoid prevents perfect isolation)

      // High rug_rate only (weight 0.40)
      const highRug = computeRiskScore(0.9, 0.0, 0.0);
      expect(highRug).toBeGreaterThan(0.3); // Should dominate

      // High toxicity dominates (weight 0.35)
      // Note: Even with rugRate=0, sigmoid(-3.0) ≈ 0.047, so total ≈ 0.35 + 0.40×0.047 + 0.25×0.047 ≈ 0.38
      const highToxicity = computeRiskScore(0.0, 1.0, 0.0);
      expect(highToxicity).toBeGreaterThan(0.35);
      expect(highToxicity).toBeLessThan(0.40);

      // High cartel only (weight 0.25)
      const highCartel = computeRiskScore(0.0, 0.0, 0.9);
      expect(highCartel).toBeGreaterThan(0.2);
    });
  });

  describe('getStrategy', () => {
    it('should map risk scores to correct strategies', () => {
      expect(getStrategy(0.00)).toBe('RIDE');
      expect(getStrategy(0.15)).toBe('RIDE');
      expect(getStrategy(0.24)).toBe('RIDE');

      expect(getStrategy(0.25)).toBe('WATCH');
      expect(getStrategy(0.35)).toBe('WATCH');
      expect(getStrategy(0.49)).toBe('WATCH');

      expect(getStrategy(0.50)).toBe('FADE');
      expect(getStrategy(0.60)).toBe('FADE');
      expect(getStrategy(0.74)).toBe('FADE');

      expect(getStrategy(0.75)).toBe('AVOID');
      expect(getStrategy(0.85)).toBe('AVOID');
      expect(getStrategy(1.00)).toBe('AVOID');
    });
  });

  describe('computeProfileVector', () => {
    it('should apply correct weights to wallet features', () => {
      const wallet: WalletProfile = {
        wallet_address: 'test',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
        rug_count: 9,
        survival_count: 1,
        neutral_count: 0,
        rug_rate: 0.9,
        taint_score: 100,
        toxicity_score: 0.5,
        risk_score: 0.7,
        cartel_id: null,
        profile_vector: '',
        strategy: 'FADE',
        rugger_playbook: null,
        playbook_confidence: 0,
        playbook_updated_at: null
      };

      const vector = computeProfileVector(wallet);

      expect(vector.rug_rate).toBeCloseTo(0.9 * 3.0, 2); // weight 3.0
      expect(vector.taint_score).toBeCloseTo(100 * 2.0, 2); // weight 2.0
    });

    it('should include cartel rug rate when cartel provided', () => {
      const wallet: WalletProfile = {
        wallet_address: 'test',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
        rug_count: 5,
        survival_count: 5,
        neutral_count: 0,
        rug_rate: 0.5,
        taint_score: 50,
        toxicity_score: 0.3,
        risk_score: 0.4,
        cartel_id: 'cartel1',
        profile_vector: '',
        strategy: 'WATCH',
        rugger_playbook: null,
        playbook_confidence: 0,
        playbook_updated_at: null
      };

      const cartel: CartelGroup = {
        cartel_id: 'cartel1',
        name: 'Test Cartel',
        wallet_count: 5,
        total_rug_count: 20,
        total_survival_count: 5,
        avg_rug_rate: 0.8,
        confidence_score: 0.7,
        confidence_score_v2: 0.65,
        auto_strategy: 'AVOID'
      };

      const vector = computeProfileVector(wallet, cartel);

      expect(vector.cartel_rug_rate).toBeCloseTo(0.8 * 2.5, 2); // weight 2.5
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const vec1 = {
        rug_rate: 2.7,
        taint_score: 200,
        avg_token_lifespan: 5,
        cartel_rug_rate: 2.0,
        ancestry_depth: 1.5,
        funding_diversity: 0.8,
        token_frequency: 3.0
      };

      const similarity = cosineSimilarity(vec1, vec1);
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const vec1 = {
        rug_rate: 1,
        taint_score: 0,
        avg_token_lifespan: 0,
        cartel_rug_rate: 0,
        ancestry_depth: 0,
        funding_diversity: 0,
        token_frequency: 0
      };

      const vec2 = {
        rug_rate: 0,
        taint_score: 1,
        avg_token_lifespan: 0,
        cartel_rug_rate: 0,
        ancestry_depth: 0,
        funding_diversity: 0,
        token_frequency: 0
      };

      const similarity = cosineSimilarity(vec1, vec2);
      expect(similarity).toBeCloseTo(0.0, 5);
    });

    it('should detect high similarity > 0.85 for behavioral overlap', () => {
      const vec1 = {
        rug_rate: 2.7,
        taint_score: 200,
        avg_token_lifespan: 5,
        cartel_rug_rate: 2.0,
        ancestry_depth: 1.5,
        funding_diversity: 0.8,
        token_frequency: 3.0
      };

      const vec2 = {
        rug_rate: 2.6,
        taint_score: 195,
        avg_token_lifespan: 5.1,
        cartel_rug_rate: 2.1,
        ancestry_depth: 1.4,
        funding_diversity: 0.85,
        token_frequency: 2.9
      };

      const similarity = cosineSimilarity(vec1, vec2);
      expect(similarity).toBeGreaterThan(0.85); // Cartel detection threshold
    });
  });
});
