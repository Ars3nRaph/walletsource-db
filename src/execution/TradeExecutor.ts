import type { Pool } from 'pg';
import type { RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { logger } from '../utils/logger.js';

export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'NONE';

export interface TradeSignal {
  action: TradeAction;
  confidence: number;         // 0.0 → 1.0
  percentage?: number;
  reason: string;
  playbook_strategy?: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
  signals?: SignalBreakdown;  // détail des facteurs
}

interface SignalBreakdown {
  timing_score: number;        // position dans la fenêtre attendue
  momentum_score: number;      // buy pressure actuelle
  consistency_score: number;   // fiabilité historique du wallet
  risk_score: number;          // risque de rug imminent
  wallet_score: number;        // signature comportementale du wallet
}

interface OpenPosition {
  entryMC: number;
  entryTime: Date;
  highestMC: number;
  lowestMCAfterEntry: number;
  tradeCount: number;         // nb de snapshots depuis l'entrée
}

interface LiveTradeState {
  buyCount: number;
  sellCount: number;
  buyVol: number;
  sellVol: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  firstSellAt: Date | null;
  lastSeenAt: Date;
  recentSells: number;         // sells dans les 10 dernières secondes
  recentBuys: number;
  cascadeDetected: boolean;
}

/**
 * TradeExecutor v4.4 — Prediction Engine Multi-Signal
 *
 * Utilise les playbooks enrichis (tick-level) + trade_events live pour :
 * - Scoring multi-facteur (timing, momentum, consistency, risk, wallet signature)
 * - Détection cascade en temps réel depuis trade_events
 * - Stop-loss adaptatif basé sur avg_rug_duration_sec du wallet
 * - Entry timing en secondes (précision ms) au lieu de minutes
 * - Seuil de confidence ajusté par creator_sold_rate + cascade_score
 */
export class TradeExecutor {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;

  private openPositions = new Map<string, OpenPosition>();
  private firstMC = new Map<string, number>();
  private liveState = new Map<string, LiveTradeState>();

  // Min confidence pour déclencher un BUY (ajusté par wallet risk)
  private readonly BASE_BUY_CONFIDENCE = 0.60;

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
  }

  /**
   * Appelé depuis PumpTradeStream sur chaque trade (tick-level, <100ms latency)
   */
  onTrade(tokenAddress: string, txType: 'buy' | 'sell', _mcUsd: number, volUsd: number, trader: string): void {
    let state = this.liveState.get(tokenAddress);
    if (!state) {
      state = {
        buyCount: 0, sellCount: 0, buyVol: 0, sellVol: 0,
        uniqueBuyers: new Set(), uniqueSellers: new Set(),
        firstSellAt: null, lastSeenAt: new Date(),
        recentSells: 0, recentBuys: 0, cascadeDetected: false
      };
      this.liveState.set(tokenAddress, state);
    }

    const now = new Date();
    if (txType === 'buy') {
      state.buyCount++;
      state.buyVol += volUsd;
      state.uniqueBuyers.add(trader);
      state.recentBuys++;
    } else {
      state.sellCount++;
      state.sellVol += volUsd;
      state.uniqueSellers.add(trader);
      state.recentSells++;
      if (!state.firstSellAt) state.firstSellAt = now;
    }
    state.lastSeenAt = now;

    // Cascade detection: 3+ sells consécutifs sans buy intercalé
    if (txType === 'sell' && state.recentSells >= 3 && state.recentBuys === 0) {
      state.cascadeDetected = true;
    }
    if (txType === 'buy') {
      state.recentSells = 0;
      state.recentBuys = 0;
      state.cascadeDetected = false;
    }
  }

  /**
   * Évaluation principale — appelée toutes les 10s depuis TokenTracker
   */
  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    try {
      if (!this.firstMC.has(tokenAddress)) {
        this.firstMC.set(tokenAddress, currentMC);
      }

      const pos = this.openPositions.get(tokenAddress);
      if (pos) {
        if (currentMC > pos.highestMC) pos.highestMC = currentMC;
        if (currentMC < pos.lowestMCAfterEntry) pos.lowestMCAfterEntry = currentMC;
        pos.tradeCount++;
      }

      const token = await this.tokenRepo.getByAddress(tokenAddress);
      if (!token) return this.none('Token not found');

      const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
      if (!wallet) return this.none('Wallet not found');

      const playbook: RuggerPlaybook | null = wallet.rugger_playbook
        ? (typeof wallet.rugger_playbook === 'string'
            ? JSON.parse(wallet.rugger_playbook)
            : wallet.rugger_playbook)
        : null;

      if (!playbook) return this.none('No playbook');

      if (playbook.recommended_strategy !== 'RIDE') {
        return this.none(`Strategy ${playbook.recommended_strategy} — RIDE only`, playbook.recommended_strategy);
      }

      // Validation minimale du playbook
      const validation = this.validatePlaybook(playbook);
      if (!validation.ok) return this.none(validation.reason!, 'RIDE');

      return this.evaluateRide(playbook, elapsedMinutes, tokenAddress, currentMC, token.creator_wallet);

    } catch (err) {
      logger.error({ err, tokenAddress }, 'TradeExecutor error');
      return this.none('Evaluation error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // VALIDATION
  // ─────────────────────────────────────────────────────────────

  private validatePlaybook(p: RuggerPlaybook): { ok: boolean; reason?: string } {
    if ((p.avg_peak_mc ?? 0) < 2000)
      return { ok: false, reason: `avg_peak_mc $${p.avg_peak_mc?.toFixed(0)} < $2000` };
    if (p.consistency_score < 0.7)
      return { ok: false, reason: `consistency ${p.consistency_score.toFixed(2)} < 0.70` };
    if ((p.avg_pump_multiple ?? 0) < 1.5)
      return { ok: false, reason: `pump multiple ${p.avg_pump_multiple?.toFixed(1)}x < 1.5x` };
    // Si creator_sold_rate > 80% → trop risqué pour RIDE
    if ((p.creator_sold_rate ?? 0) > 0.8)
      return { ok: false, reason: `creator_sold_rate ${((p.creator_sold_rate ?? 0) * 100).toFixed(0)}% > 80% — trop risqué` };
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // SCORING MULTI-FACTEUR
  // ─────────────────────────────────────────────────────────────

  private computeSignals(
    p: RuggerPlaybook,
    elapsedSec: number,
    currentMC: number,
    _firstMC: number,
    state: LiveTradeState | undefined
  ): SignalBreakdown {

    // 1. TIMING SCORE — à quelle position sommes-nous dans la fenêtre attendue ?
    const avgPeakSec = p.avg_time_to_peak_sec ?? (p.avg_time_to_peak_min * 60);
    const stdPeakSec = p.std_time_to_peak_sec ?? (p.std_time_to_peak_min * 60);
    const entryWindowStart = Math.max(0, avgPeakSec - stdPeakSec * 1.5);
    const entryWindowEnd   = avgPeakSec + stdPeakSec * 0.5; // légèrement avant le peak

    let timingScore = 0;
    if (elapsedSec < entryWindowStart) {
      // Trop tôt — score proportionnel à l'approche de la fenêtre
      timingScore = elapsedSec / Math.max(entryWindowStart, 1) * 0.5;
    } else if (elapsedSec <= entryWindowEnd) {
      // Dans la fenêtre → pic à 1.0 au milieu
      const mid = (entryWindowStart + entryWindowEnd) / 2;
      const halfWidth = (entryWindowEnd - entryWindowStart) / 2;
      timingScore = 1.0 - Math.abs(elapsedSec - mid) / Math.max(halfWidth, 1) * 0.3;
    } else {
      // Après la fenêtre — décroît rapidement
      timingScore = Math.max(0, 1.0 - (elapsedSec - entryWindowEnd) / Math.max(stdPeakSec, 30));
    }

    // 2. MOMENTUM SCORE — buy pressure live depuis trade_events
    let momentumScore = 0.5; // neutre si pas de données live
    if (state && (state.buyCount + state.sellCount) > 3) {
      const bsr = state.buyVol / Math.max(state.sellVol, 1);
      const uniqueBuyerRatio = state.uniqueBuyers.size / Math.max(state.buyCount, 1);
      // Pression forte = bsr > 1.5, acheteurs variés
      momentumScore = Math.min(1.0,
        (Math.min(bsr, 3.0) / 3.0) * 0.6 +
        uniqueBuyerRatio * 0.4
      );
      // Cascade détectée → momentum très négatif
      if (state.cascadeDetected) momentumScore = 0.1;
      // Premier sell déjà arrivé → attention
      if (state.firstSellAt) {
        const sellDelaySec = (Date.now() - state.firstSellAt.getTime()) / 1000;
        const expectedDelaySec = p.avg_first_sell_delay_sec ?? 30;
        // Si le sell arrive bien plus tôt que d'habitude → signal négatif
        if (sellDelaySec < expectedDelaySec * 0.5) {
          momentumScore *= 0.7;
        }
      }
    }

    // 3. CONSISTENCY SCORE — fiabilité du wallet
    // Préférer la précision secondes si dispo
    const consistScore = p.consistency_score_sec ?? p.consistency_score;

    // 4. RISK SCORE (inversé : 1.0 = faible risque, 0.0 = danger)
    let riskScore = 1.0;
    // Creator qui vend souvent → risque élevé
    riskScore -= (p.creator_sold_rate ?? 0) * 0.3;
    // Cascade habituelle forte → risque élevé
    riskScore -= (p.avg_cascade_score ?? 0) * 0.2;
    // Rug très rapide (< 30s) → difficile à sortir
    const avgRugSec = p.avg_rug_duration_sec ?? 999;
    if (avgRugSec < 30) riskScore -= 0.3;
    else if (avgRugSec < 60) riskScore -= 0.1;
    // MC actuel > avg_peak_mc → on est peut-être déjà au peak
    if (currentMC > p.avg_peak_mc * 0.9) riskScore -= 0.2;
    riskScore = Math.max(0, Math.min(1, riskScore));

    // 5. WALLET SIGNATURE SCORE — est-ce que ce token ressemble au pattern habituel ?
    let walletScore = 0.5;
    if (state && p.avg_buy_wallet_count) {
      // Nb d'acheteurs dans la norme historique ?
      const buyerRatio = state.uniqueBuyers.size / p.avg_buy_wallet_count;
      walletScore = Math.min(1.0, buyerRatio * 0.8 + 0.2);
    }
    // Micro-buy pattern habituel chez ce rugger ?
    if (p.micro_buy_rate && p.micro_buy_rate > 0.5 && state) {
      // Attendre confirmation du pattern avant d'entrer
      walletScore *= 0.9;
    }

    return {
      timing_score: Math.max(0, Math.min(1, timingScore)),
      momentum_score: Math.max(0, Math.min(1, momentumScore)),
      consistency_score: Math.max(0, Math.min(1, consistScore)),
      risk_score: riskScore,
      wallet_score: Math.max(0, Math.min(1, walletScore)),
    };
  }

  private aggregateConfidence(s: SignalBreakdown): number {
    // Poids : consistency et risk sont les plus importants
    return (
      s.timing_score      * 0.25 +
      s.momentum_score    * 0.20 +
      s.consistency_score * 0.30 +
      s.risk_score        * 0.15 +
      s.wallet_score      * 0.10
    );
  }

  // ─────────────────────────────────────────────────────────────
  // RIDE EVALUATION
  // ─────────────────────────────────────────────────────────────

  private evaluateRide(
    p: RuggerPlaybook,
    elapsedMinutes: number,
    tokenAddress: string,
    currentMC: number,
    creatorWallet: string
  ): TradeSignal {
    const elapsedSec = elapsedMinutes * 60;
    const state = this.liveState.get(tokenAddress);
    const pos = this.openPositions.get(tokenAddress);

    const firstMCval = this.firstMC.get(tokenAddress) ?? currentMC;
    const signals = this.computeSignals(p, elapsedSec, currentMC, firstMCval, state);
    const confidence = this.aggregateConfidence(signals);

    // Timing absolu : fenêtre de sortie en secondes
    const avgRugSec   = p.avg_time_to_rug_sec ?? (p.avg_time_to_rug_min * 60);
    const stdRugSec   = p.std_time_to_rug_sec ?? (p.std_time_to_rug_min * 60);
    const exitStartSec = Math.max(0, avgRugSec - stdRugSec * 0.8);
    const exitEndSec   = avgRugSec + stdRugSec * 0.3;

    // Stop-loss adaptatif selon vitesse du rug historique
    const rugDurSec = p.avg_rug_duration_sec ?? 60;
    const stopLossPct = rugDurSec < 15 ? 0.03   // rug ultra-rapide → SL très serré (3%)
                      : rugDurSec < 30 ? 0.05   // rug rapide → SL serré (5%)
                      : rugDurSec < 60 ? 0.07   // rug normal → SL modéré (7%)
                      :                  0.10;  // rug lent → SL large (10%)

    const trailingStopPct = stopLossPct * 1.5; // trailing toujours plus large que SL initial

    // ── POSITION OUVERTE ──────────────────────────────────────
    if (pos) {
      // 1. Cascade détectée en live → sortie immédiate
      if (state?.cascadeDetected) {
        this.closePosition(tokenAddress);
        return this.sell(100, confidence, 'RIDE',
          `🌊 CASCADE live (${state.sellCount} sells / ${state.buyCount} buys) — sortie urgente`,
          signals);
      }

      // 2. Stop-loss depuis entry
      const dropFromEntry = (pos.entryMC - currentMC) / pos.entryMC;
      if (dropFromEntry >= stopLossPct) {
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `🛑 STOP-LOSS ${(dropFromEntry*100).toFixed(1)}% > ${(stopLossPct*100).toFixed(0)}% seuil (rug_dur=${rugDurSec.toFixed(0)}s)`,
          signals);
      }

      // 3. Trailing stop depuis highest
      const dropFromHigh = (pos.highestMC - currentMC) / pos.highestMC;
      if (dropFromHigh >= trailingStopPct && pos.highestMC > pos.entryMC * 1.03) {
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `📉 TRAILING STOP ${(dropFromHigh*100).toFixed(1)}% (high $${pos.highestMC.toFixed(0)} → $${currentMC.toFixed(0)})`,
          signals);
      }

      // 4. Premier sell du créateur → sortie immédiate si creator_sold_rate > 50%
      if (state?.firstSellAt && (p.creator_sold_rate ?? 0) > 0.5) {
        const sellDelaySec = (Date.now() - state.firstSellAt.getTime()) / 1000;
        const expectedDelaySec = p.avg_first_sell_delay_sec ?? 999;
        if (sellDelaySec > expectedDelaySec * 0.8) {
          this.closePosition(tokenAddress);
          return this.sell(100, 0.9, 'RIDE',
            `👤 CREATOR SELL détecté (rate=${((p.creator_sold_rate??0)*100).toFixed(0)}%, delay=${sellDelaySec.toFixed(0)}s)`,
            signals);
        }
      }

      // 5. Fenêtre de sortie temporelle (secondes)
      if (elapsedSec >= exitStartSec) {
        const windowLen = Math.max(exitEndSec - exitStartSec, 1);
        const progress = Math.min(1.0, (elapsedSec - exitStartSec) / windowLen);
        const pct = Math.round(progress * 100);

        if (elapsedSec > exitEndSec) {
          this.closePosition(tokenAddress);
          return this.sell(100, 1.0, 'RIDE',
            `⏱ Fenêtre terminée (>${(exitEndSec/60).toFixed(1)}min) — force close`,
            signals);
        }

        return this.sell(pct, confidence * (0.7 + progress * 0.3), 'RIDE',
          `📤 Sortie progressive ${pct}% (fenêtre ${(exitStartSec/60).toFixed(1)}-${(exitEndSec/60).toFixed(1)}min)`,
          signals);
      }

      // 6. Confidence chute fortement → sortie défensive
      if (confidence < 0.35 && pos.tradeCount > 3) {
        this.closePosition(tokenAddress);
        return this.sell(100, confidence, 'RIDE',
          `⚠️ Confidence chutée à ${(confidence*100).toFixed(0)}% — sortie défensive`,
          signals);
      }

      // HOLD
      return {
        action: 'HOLD', confidence, playbook_strategy: 'RIDE', signals,
        reason: `HOLD — conf=${(confidence*100).toFixed(0)}% timing=${(signals.timing_score*100).toFixed(0)}% mom=${(signals.momentum_score*100).toFixed(0)}% risk=${(signals.risk_score*100).toFixed(0)}%`
      };
    }

    // ── PAS DE POSITION : évaluer l'entrée ───────────────────

    // Trop tard
    const avgPeakSec = p.avg_time_to_peak_sec ?? (p.avg_time_to_peak_min * 60);
    const stdPeakSec = p.std_time_to_peak_sec ?? (p.std_time_to_peak_min * 60);
    const maxEntrySec = avgPeakSec + stdPeakSec * 0.5;
    if (elapsedSec > maxEntrySec) {
      return this.none(`⏰ Trop tard (${elapsedSec.toFixed(0)}s > ${maxEntrySec.toFixed(0)}s max)`, 'RIDE');
    }

    // Pump insuffisant (token mort ou pas encore décollé)
    const firstMCval2 = this.firstMC.get(tokenAddress) ?? currentMC;
    const mcRise = (currentMC - firstMCval2) / Math.max(firstMCval2, 1);
    if (mcRise < 0.03 && elapsedSec > 30) {
      return this.none(`Pump < 3% après ${elapsedSec.toFixed(0)}s — token plat`, 'RIDE');
    }

    // Déjà au-delà du peak attendu
    if (currentMC > p.avg_peak_mc * 0.95) {
      return this.none(`MC $${currentMC.toFixed(0)} ≥ 95% du avg_peak $${p.avg_peak_mc.toFixed(0)} — entrée manquée`, 'RIDE');
    }

    // Cascade déjà en cours → ne pas entrer
    if (state?.cascadeDetected) {
      return this.none('CASCADE en cours — pas d\'entrée', 'RIDE');
    }

    // Confidence insuffisante
    const minConfidence = this.computeMinConfidence(p);
    if (confidence < minConfidence) {
      return this.none(
        `Conf ${(confidence*100).toFixed(0)}% < ${(minConfidence*100).toFixed(0)}% requis | t=${(signals.timing_score*100).toFixed(0)}% m=${(signals.momentum_score*100).toFixed(0)}% r=${(signals.risk_score*100).toFixed(0)}%`,
        'RIDE'
      );
    }

    // ✅ BUY
    this.openPositions.set(tokenAddress, {
      entryMC: currentMC,
      entryTime: new Date(),
      highestMC: currentMC,
      lowestMCAfterEntry: currentMC,
      tradeCount: 0,
    });

    logger.info({
      token: tokenAddress.slice(0, 8),
      wallet: creatorWallet.slice(0, 8),
      mc: currentMC.toFixed(0),
      elapsedSec: elapsedSec.toFixed(0),
      confidence: (confidence * 100).toFixed(0) + '%',
      signals: {
        timing: (signals.timing_score*100).toFixed(0)+'%',
        momentum: (signals.momentum_score*100).toFixed(0)+'%',
        consistency: (signals.consistency_score*100).toFixed(0)+'%',
        risk: (signals.risk_score*100).toFixed(0)+'%',
      }
    }, '🟢 BUY SIGNAL');

    return {
      action: 'BUY', confidence, percentage: 100, playbook_strategy: 'RIDE', signals,
      reason: `BUY — conf=${(confidence*100).toFixed(0)}% | +${(mcRise*100).toFixed(1)}% pump | t=${(signals.timing_score*100).toFixed(0)}% m=${(signals.momentum_score*100).toFixed(0)}% c=${(signals.consistency_score*100).toFixed(0)}% r=${(signals.risk_score*100).toFixed(0)}%`
    };
  }

  /**
   * Seuil de confidence minimum dynamique selon le profil de risque du wallet
   */
  private computeMinConfidence(p: RuggerPlaybook): number {
    let min = this.BASE_BUY_CONFIDENCE;
    // Wallet qui vend souvent → exiger plus de certitude
    if ((p.creator_sold_rate ?? 0) > 0.5) min += 0.05;
    // Cascade forte habituelle → plus de certitude
    if ((p.avg_cascade_score ?? 0) > 0.6) min += 0.05;
    // Rug très rapide → plus de certitude (pas le temps de réagir)
    if ((p.avg_rug_duration_sec ?? 999) < 20) min += 0.10;
    return Math.min(0.80, min);
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  private none(reason: string, strategy?: 'RIDE'|'FADE'|'WATCH'|'AVOID'): TradeSignal {
    return { action: 'NONE', confidence: 0, reason, playbook_strategy: strategy };
  }

  private sell(pct: number, confidence: number, strategy: 'RIDE', reason: string, signals: SignalBreakdown): TradeSignal {
    return { action: 'SELL', confidence, percentage: pct, reason, playbook_strategy: strategy, signals };
  }

  private closePosition(tokenAddress: string): void {
    const pos = this.openPositions.get(tokenAddress);
    if (pos) {
      const holdMin = (Date.now() - pos.entryTime.getTime()) / 60000;
      const pnl = ((pos.highestMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
      logger.info({
        token: tokenAddress.slice(0, 8),
        entryMC: pos.entryMC.toFixed(0),
        highMC: pos.highestMC.toFixed(0),
        holdMin: holdMin.toFixed(2),
        maxPnlPct: pnl + '%'
      }, '🔴 POSITION CLOSED');
      this.openPositions.delete(tokenAddress);
    }
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
  }

  closePositionIfOpen(tokenAddress: string): void {
    if (this.openPositions.has(tokenAddress)) this.closePosition(tokenAddress);
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
  }

  hasPosition(tokenAddress: string): boolean {
    return this.openPositions.has(tokenAddress);
  }
}
