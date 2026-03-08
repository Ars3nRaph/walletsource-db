/**
 * PeakDurationDetector — Détection de la durée du peak
 *
 * Mesure combien de temps un token reste proche de son peak avant de dumper.
 * Utilisé pour optimiser les entrées SHORT.
 */

interface PeakInfo {
  peak_mc: number;
  peak_time: Date;
  dump_started: boolean;
  dump_start_time: Date | null;
}

export class PeakDurationDetector {
  private peaks: Map<string, PeakInfo> = new Map();
  private readonly PEAK_THRESHOLD_PCT = 0.95; // 95% du peak = encore au peak
  private readonly DUMP_THRESHOLD_PCT = 0.05; // 5% de baisse = dump commence

  /**
   * Enregistrer un snapshot et détecter le peak
   */
  recordSnapshot(tokenAddress: string, mc: number): void {
    const peakInfo = this.peaks.get(tokenAddress);

    if (!peakInfo) {
      // Premier snapshot, initialiser
      this.peaks.set(tokenAddress, {
        peak_mc: mc,
        peak_time: new Date(),
        dump_started: false,
        dump_start_time: null
      });
      return;
    }

    // Nouveau peak atteint
    if (mc > peakInfo.peak_mc) {
      peakInfo.peak_mc = mc;
      peakInfo.peak_time = new Date();
      peakInfo.dump_started = false;
      peakInfo.dump_start_time = null;
    }
    // Dump détecté (baisse de 5%+ depuis peak)
    else if (!peakInfo.dump_started && mc < peakInfo.peak_mc * (1 - this.DUMP_THRESHOLD_PCT)) {
      peakInfo.dump_started = true;
      peakInfo.dump_start_time = new Date();
    }
  }

  /**
   * Vérifier si le token est encore au peak
   */
  isAtPeak(tokenAddress: string, currentMC: number): boolean {
    const peakInfo = this.peaks.get(tokenAddress);

    if (!peakInfo) {
      return false;
    }

    return currentMC >= peakInfo.peak_mc * this.PEAK_THRESHOLD_PCT;
  }

  /**
   * Vérifier si le dump a commencé
   */
  hasDumpStarted(tokenAddress: string): boolean {
    const peakInfo = this.peaks.get(tokenAddress);
    return peakInfo?.dump_started || false;
  }

  /**
   * Obtenir la durée du peak (en minutes)
   * Retourne null si le dump n'a pas encore commencé
   */
  getPeakDuration(tokenAddress: string): number | null {
    const peakInfo = this.peaks.get(tokenAddress);

    if (!peakInfo || !peakInfo.dump_started || !peakInfo.dump_start_time) {
      return null;
    }

    const duration = peakInfo.dump_start_time.getTime() - peakInfo.peak_time.getTime();
    return duration / (60 * 1000); // Convertir en minutes
  }

  /**
   * Obtenir le peak MC
   */
  getPeakMC(tokenAddress: string): number | null {
    return this.peaks.get(tokenAddress)?.peak_mc || null;
  }

  /**
   * Obtenir le temps écoulé depuis le peak (en minutes)
   */
  getTimeSincePeak(tokenAddress: string): number | null {
    const peakInfo = this.peaks.get(tokenAddress);

    if (!peakInfo) {
      return null;
    }

    const elapsed = Date.now() - peakInfo.peak_time.getTime();
    return elapsed / (60 * 1000);
  }

  /**
   * Nettoyer les données d'un token
   */
  clear(tokenAddress: string): void {
    this.peaks.delete(tokenAddress);
  }
}
