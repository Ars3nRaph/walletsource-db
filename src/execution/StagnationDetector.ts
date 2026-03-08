/**
 * StagnationDetector — Détection de stagnation et dump du MC
 *
 * Détecte:
 * 1. Peak atteint (MC monte significativement depuis entry)
 * 2. Dump (MC redescend après peak)
 * 3. Stagnation (pas de hausse après peak)
 *
 * Utilisé pour sortir des positions LONG au moment optimal (après montée, avant/pendant dump).
 */

interface Snapshot {
  timestamp: Date;
  mc: number;
}

export class StagnationDetector {
  private snapshots: Map<string, Snapshot[]> = new Map();
  private peakMC: Map<string, number> = new Map(); // Track peak MC atteint
  private entryMC: Map<string, number> = new Map(); // Track MC à l'entry
  private readonly PEAK_THRESHOLD_PCT = 0.10; // 10% hausse minimum pour considérer un peak
  private readonly DUMP_THRESHOLD_PCT = 0.15; // 15% baisse depuis peak = dump détecté
  private readonly STAGNATION_THRESHOLD_PCT = 0.05; // 5%
  private readonly STAGNATION_WINDOW_MS = 20 * 1000; // 20 secondes
  private readonly MAX_SNAPSHOTS = 3; // Garder 3 snapshots (30s avec polling 10s)

  /**
   * Enregistrer un nouveau snapshot
   */
  recordSnapshot(tokenAddress: string, mc: number): void {
    const snapshots = this.snapshots.get(tokenAddress) || [];

    // Premier snapshot = entry MC
    if (snapshots.length === 0) {
      this.entryMC.set(tokenAddress, mc);
      this.peakMC.set(tokenAddress, mc);
    }

    snapshots.push({
      timestamp: new Date(),
      mc
    });

    // Garder seulement les N derniers
    if (snapshots.length > this.MAX_SNAPSHOTS) {
      snapshots.shift();
    }

    this.snapshots.set(tokenAddress, snapshots);

    // Update peak MC si nouveau high
    const currentPeak = this.peakMC.get(tokenAddress) || mc;
    if (mc > currentPeak) {
      this.peakMC.set(tokenAddress, mc);
    }
  }

  /**
   * Vérifier si le token stagne APRÈS avoir atteint un peak
   * Retourne true si:
   * 1. Un peak a été atteint (MC monté de 10%+ depuis entry)
   * 2. Aucune hausse de 5%+ depuis 20 secondes
   */
  checkStagnation(tokenAddress: string): boolean {
    const snapshots = this.snapshots.get(tokenAddress);

    if (!snapshots || snapshots.length < 3) {
      return false; // Pas assez de données
    }

    // Vérifier qu'un peak significatif a été atteint
    const entryMC = this.entryMC.get(tokenAddress);
    const peakMC = this.peakMC.get(tokenAddress);

    if (!entryMC || !peakMC) {
      return false;
    }

    const peakGain = (peakMC - entryMC) / entryMC;

    // Pas de stagnation si aucun peak significatif atteint
    if (peakGain < this.PEAK_THRESHOLD_PCT) {
      return false; // MC n'a pas encore suffisamment monté
    }

    const currentSnapshot = snapshots[snapshots.length - 1];
    const oldSnapshot = snapshots[0]; // 20-30s avant

    const timeDiff = currentSnapshot.timestamp.getTime() - oldSnapshot.timestamp.getTime();

    // Si moins de 20s écoulées, pas encore de stagnation possible
    if (timeDiff < this.STAGNATION_WINDOW_MS) {
      return false;
    }

    // Calculer le changement de MC
    const mcChange = (currentSnapshot.mc - oldSnapshot.mc) / oldSnapshot.mc;

    // Stagnation = pas de hausse de 5%+ en 20s (APRÈS avoir vu un peak)
    return mcChange < this.STAGNATION_THRESHOLD_PCT;
  }

  /**
   * Détecter un dump (MC redescend après peak)
   * Retourne true si:
   * 1. Un peak a été atteint (MC monté de 10%+ depuis entry)
   * 2. MC actuel a baissé de 15%+ depuis le peak
   */
  checkDump(tokenAddress: string): boolean {
    const snapshots = this.snapshots.get(tokenAddress);
    const entryMC = this.entryMC.get(tokenAddress);
    const peakMC = this.peakMC.get(tokenAddress);

    if (!snapshots || snapshots.length < 2 || !entryMC || !peakMC) {
      return false;
    }

    // Vérifier qu'un peak significatif a été atteint
    const peakGain = (peakMC - entryMC) / entryMC;
    if (peakGain < this.PEAK_THRESHOLD_PCT) {
      return false; // Pas encore de peak significatif
    }

    const currentMC = snapshots[snapshots.length - 1].mc;
    const dumpFromPeak = (peakMC - currentMC) / peakMC;

    // Dump détecté si baisse de 15%+ depuis peak
    return dumpFromPeak >= this.DUMP_THRESHOLD_PCT;
  }

  /**
   * Vérifier si un peak a été atteint (MC monté de 10%+)
   */
  hasPeakBeenReached(tokenAddress: string): boolean {
    const entryMC = this.entryMC.get(tokenAddress);
    const peakMC = this.peakMC.get(tokenAddress);

    if (!entryMC || !peakMC) {
      return false;
    }

    const peakGain = (peakMC - entryMC) / entryMC;
    return peakGain >= this.PEAK_THRESHOLD_PCT;
  }

  /**
   * Obtenir le dernier changement de MC (pour debug)
   */
  getLastChange(tokenAddress: string): number | null {
    const snapshots = this.snapshots.get(tokenAddress);

    if (!snapshots || snapshots.length < 2) {
      return null;
    }

    const current = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];

    return (current.mc - previous.mc) / previous.mc;
  }

  /**
   * Obtenir stats pour debug
   */
  getStats(tokenAddress: string): { entryMC: number; peakMC: number; currentMC: number; peakGain: number; dumpFromPeak: number } | null {
    const snapshots = this.snapshots.get(tokenAddress);
    const entryMC = this.entryMC.get(tokenAddress);
    const peakMC = this.peakMC.get(tokenAddress);

    if (!snapshots || !entryMC || !peakMC || snapshots.length === 0) {
      return null;
    }

    const currentMC = snapshots[snapshots.length - 1].mc;
    const peakGain = (peakMC - entryMC) / entryMC;
    const dumpFromPeak = (peakMC - currentMC) / peakMC;

    return { entryMC, peakMC, currentMC, peakGain, dumpFromPeak };
  }

  /**
   * Nettoyer les snapshots d'un token (après sortie de position)
   */
  clear(tokenAddress: string): void {
    this.snapshots.delete(tokenAddress);
    this.peakMC.delete(tokenAddress);
    this.entryMC.delete(tokenAddress);
  }
}
