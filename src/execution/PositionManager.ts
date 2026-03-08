/**
 * PositionManager — Gestion des positions LONG/SHORT actives
 *
 * Track les positions ouvertes avec levier et calcule le PnL en temps réel.
 */

export type PositionType = 'LONG' | 'SHORT';

export interface Position {
  token: string;
  type: PositionType;
  entry_mc: number;
  entry_time: Date;
  leverage: number;
  target_mc: number;     // 2x pour LONG, 0.5x pour SHORT
  stop_loss_mc: number;  // Stagnation pour LONG, +10% pour SHORT
}

export class PositionManager {
  private positions: Map<string, Position> = new Map();

  /**
   * Ouvrir une position LONG
   */
  openLong(
    tokenAddress: string,
    entryMC: number,
    leverage: number
  ): Position {
    const position: Position = {
      token: tokenAddress,
      type: 'LONG',
      entry_mc: entryMC,
      entry_time: new Date(),
      leverage,
      target_mc: entryMC * 2.0,      // Take profit à 2x
      stop_loss_mc: entryMC * 0.95   // Stop loss temporaire (remplacé par stagnation)
    };

    this.positions.set(tokenAddress, position);
    return position;
  }

  /**
   * Ouvrir une position SHORT
   */
  openShort(
    tokenAddress: string,
    entryMC: number,
    leverage: number
  ): Position {
    const position: Position = {
      token: tokenAddress,
      type: 'SHORT',
      entry_mc: entryMC,
      entry_time: new Date(),
      leverage,
      target_mc: entryMC * 0.5,      // Take profit à -50%
      stop_loss_mc: entryMC * 1.10   // Stop loss à +10%
    };

    this.positions.set(tokenAddress, position);
    return position;
  }

  /**
   * Fermer une position
   */
  closePosition(tokenAddress: string): Position | null {
    const position = this.positions.get(tokenAddress);

    if (!position) {
      return null;
    }

    this.positions.delete(tokenAddress);
    return position;
  }

  /**
   * Obtenir une position active
   */
  getPosition(tokenAddress: string): Position | null {
    return this.positions.get(tokenAddress) || null;
  }

  /**
   * Vérifier si une position est ouverte
   */
  hasPosition(tokenAddress: string): boolean {
    return this.positions.has(tokenAddress);
  }

  /**
   * Calculer le PnL d'une position (en %)
   */
  calculatePnL(tokenAddress: string, currentMC: number): number | null {
    const position = this.positions.get(tokenAddress);

    if (!position) {
      return null;
    }

    let priceChange: number;

    if (position.type === 'LONG') {
      priceChange = (currentMC - position.entry_mc) / position.entry_mc;
    } else {
      // SHORT: profit quand le prix baisse
      priceChange = (position.entry_mc - currentMC) / position.entry_mc;
    }

    // Appliquer le levier
    return priceChange * position.leverage;
  }

  /**
   * Vérifier si le take profit est atteint
   */
  isTakeProfitReached(tokenAddress: string, currentMC: number): boolean {
    const position = this.positions.get(tokenAddress);

    if (!position) {
      return false;
    }

    if (position.type === 'LONG') {
      return currentMC >= position.target_mc;
    } else {
      return currentMC <= position.target_mc;
    }
  }

  /**
   * Vérifier si le stop loss est atteint
   */
  isStopLossReached(tokenAddress: string, currentMC: number): boolean {
    const position = this.positions.get(tokenAddress);

    if (!position) {
      return false;
    }

    if (position.type === 'LONG') {
      // Pour LONG, le stop loss est géré par la stagnation
      // Mais on vérifie quand même un stop loss hard à -5%
      return currentMC <= position.stop_loss_mc;
    } else {
      // Pour SHORT, stop loss si le prix remonte
      return currentMC >= position.stop_loss_mc;
    }
  }

  /**
   * Obtenir le temps écoulé depuis l'entrée (en minutes)
   */
  getTimeInPosition(tokenAddress: string): number | null {
    const position = this.positions.get(tokenAddress);

    if (!position) {
      return null;
    }

    const elapsed = Date.now() - position.entry_time.getTime();
    return elapsed / (60 * 1000);
  }

  /**
   * Obtenir toutes les positions actives
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Calculer le ROI pour toutes les positions
   */
  getTotalPnL(currentMCs: Map<string, number>): number {
    let totalPnL = 0;

    for (const [token, _position] of this.positions) {
      const currentMC = currentMCs.get(token);

      if (currentMC) {
        const pnl = this.calculatePnL(token, currentMC);
        if (pnl !== null) {
          totalPnL += pnl;
        }
      }
    }

    return totalPnL;
  }
}
