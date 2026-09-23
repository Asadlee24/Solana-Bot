import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { telegramNotifier } from '../notifications/telegram.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { mintDecimalsService } from '../services/mint-decimals.js';

const PUMP_MILESTONES = [25, 50, 75, 100, 150, 200, 300, 500, 1000];
const DIP_MILESTONES = [-15, -25, -35, -50];
const PULLBACK_DROP_THRESHOLDS = [20, 35, 50];
// Minimum gap between two milestone alerts for the same position (30 seconds)
const ALERT_COOLDOWN_MS = 30_000;

export class AutoExitManager {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private inFlightExits: Set<string> = new Set();
  private signalManagerRef: any = null;
  // In-memory cache; always backed by DB for restart-safety
  private alertedMilestones: Map<string, Set<number>> = new Map();
  private alertedPullbacks: Map<string, Set<number>> = new Map();
  private breakevenAlerted: Set<string> = new Set();
  private lastMilestoneAlertTime: Map<string, number> = new Map();
  private lastOnChainBalanceCheck: Map<string, number> = new Map();

  /** Load persisted milestone state from DB for a position (called once per position, lazily) */
  private loadMilestonesFromDb(posId: string): void {
    if (!this.alertedMilestones.has(posId)) {
      const persisted = db.getAlertedMilestones(posId);
      this.alertedMilestones.set(posId, persisted);
    }
    if (!this.breakevenAlerted.has(posId) && db.getBreakevenAlerted(posId)) {
      this.breakevenAlerted.add(posId);
    }
  }

  public start(signalManager: any): void {
    if (this.isRunning) return;
    this.signalManagerRef = signalManager;
    this.isRunning = true;

    console.info(
      `[AUTO-EXIT] Engine started | TP: ${config.AUTO_TP_ENABLED ? `+${config.AUTO_TP_GAIN_PCT}% (Sell ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}%)` : 'OFF'} | SL: ${config.AUTO_SL_ENABLED ? `-${config.AUTO_SL_LOSS_PCT}% (Sell 100%)` : 'OFF'} | Trailing & Zero-Loss: ${config.TRAILING_SL_ENABLED ? `ON (Lock @ +${config.BREAKEVEN_TRIGGER_PCT}% -> +${config.BREAKEVEN_LOCK_PCT}%, Trail -${config.TRAILING_SL_CUSHION_PCT}%)` : 'OFF'} | Poll: ${config.AUTO_EXIT_POLL_INTERVAL_MS}ms`
    );

    this.scheduleNextTick();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.info('[AUTO-EXIT] Engine stopped.');
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.checkOpenPositions();
      } catch (err: any) {
        console.warn('[AUTO-EXIT Error]:', err.message || err);
      } finally {
        this.scheduleNextTick();
      }
    }, config.AUTO_EXIT_POLL_INTERVAL_MS);
  }

  /**
   * High-frequency price evaluation for all held positions
   */
  public async checkOpenPositions(): Promise<void> {
    if (!this.signalManagerRef) return;

    const openPositions = db.getOpenPositions().filter((p) => {
      const mint = p.tokenMint || '';
      const isNotDummy =
        !mint.toLowerCase().includes('tokenmint') &&
        !mint.toLowerCase().includes('paper1111') &&
        !mint.toLowerCase().includes('test');
      return p.state === 'OPEN' && isNotDummy && BigInt(p.qtyRaw) > 0n;
    });

    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      if (this.inFlightExits.has(pos.tokenMint)) {
        continue;
      }

      if (config.EXECUTION_MODE === 'LIVE') {
        const now = Date.now();
        const lastCheck = this.lastOnChainBalanceCheck.get(pos.tokenMint) || 0;
        if (now - lastCheck > 30000) {
          this.lastOnChainBalanceCheck.set(pos.tokenMint, now);
          try {
            const onChainBal = await executionWalletManager.getTokenBalanceRaw(pos.tokenMint);
            if (onChainBal <= 0n) {
              pos.state = 'CLOSED';
              pos.qtyRaw = '0';
              pos.closedAt = Date.now();
              pos.updatedAt = Date.now();
              db.savePosition(pos);
              this.alertedMilestones.delete(pos.id);
              this.alertedPullbacks.delete(pos.id);
              this.breakevenAlerted.delete(pos.id);
              this.lastMilestoneAlertTime.delete(pos.id);
              continue;
            }
          } catch {}
        }
      }

      try {
        const decimals = await mintDecimalsService.getDecimals(pos.tokenMint);
        const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);

        // --- Lazy-load persisted milestone state from DB (restart-safe) ---
        this.loadMilestonesFromDb(pos.id);

        let currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : 0;
        if (pos.avgEntryPriceSol <= 0 && BigInt(pos.costBasisLamports || '0') > 0n && BigInt(pos.qtyRaw) > 0n) {
          pos.avgEntryPriceSol = (Number(pos.costBasisLamports) / 1e9) / (Number(pos.qtyRaw) / (10 ** decimals));
        }
        if (!currentPriceSol || pos.avgEntryPriceSol <= 0) continue;

        // Unrealized ROI in percent
        let pnlPct = ((currentPriceSol - pos.avgEntryPriceSol) / pos.avgEntryPriceSol) * 100;

        // REALITY CHECK: If nominal PnL looks profitable (>= +15%), verify against actual Jupiter executable sell quote!
        // This stops illiquid dust pools (e.g. $96 Meteora pools) or API glitches from faking pump alerts and false exits.
        if (pnlPct >= 15 && BigInt(pos.qtyRaw) > 0n) {
          const exec = await tokenMetadataService.getExecutableSellPriceSol(pos.tokenMint, pos.qtyRaw, decimals);
          if (exec && exec.priceSol > 0) {
            const execPnlPct = ((exec.priceSol - pos.avgEntryPriceSol) / pos.avgEntryPriceSol) * 100;
            // If DexScreener says >= +20% but real Jupiter sell gives less than +5% (or negative):
            if (pnlPct >= 20 && execPnlPct < pnlPct - 15) {
              console.warn(
                `[PRICE REALITY CHECK] Discrepancy detected for ${pos.tokenMint}: Pool claims +${pnlPct.toFixed(1)}%, but Jupiter real executable sell is only ${execPnlPct >= 0 ? '+' : ''}${execPnlPct.toFixed(1)}%. Overriding with real executable price.`
              );
              currentPriceSol = exec.priceSol;
              pnlPct = execPnlPct;
              if (meta) {
                meta.priceSol = exec.priceSol;
                meta.priceUsd = exec.priceSol * (await tokenMetadataService.getSolPriceUsd());
              }
            }
          }
        }

        // 1. Update Peak High Watermark
        const currentPeak = Math.max(pos.peakPnlPct || 0, pnlPct);
        if (currentPeak > (pos.peakPnlPct || 0)) {
          pos.peakPnlPct = currentPeak;
          db.updatePositionPeak(pos.id, currentPeak);
        }

        // 2. Real-Time Milestone Alerts
        if (!this.alertedMilestones.has(pos.id)) {
          this.alertedMilestones.set(pos.id, new Set());
        }
        const posAlerted = this.alertedMilestones.get(pos.id)!;

        // Positive Pump Milestones (+25%, +50%, +75%, +100%, +150%...)
        // Rate-limited: max 1 milestone alert per position per ALERT_COOLDOWN_MS (30s)
        const now = Date.now();
        const lastAlert = this.lastMilestoneAlertTime.get(pos.id) || 0;
        const milestoneOnCooldown = (now - lastAlert) < ALERT_COOLDOWN_MS;

        if (pnlPct > 0 && !milestoneOnCooldown) {
          for (const m of PUMP_MILESTONES) {
            if (pnlPct >= m && !posAlerted.has(m)) {
              posAlerted.add(m);
              db.saveAlertedMilestones(pos.id, posAlerted); // persist to DB
              this.lastMilestoneAlertTime.set(pos.id, now);
              telegramNotifier.notifyPositionMilestone(
                pos,
                pnlPct,
                m,
                pos.peakPnlPct || pnlPct,
                currentPriceSol,
                meta || undefined
              );
              break; // ONE alert per cycle
            }
          }
        }

        // Negative Dip Milestones (-15%, -25%, -35%, -50%...)
        // Rate-limited: same 30s cooldown as pump milestones
        if (pnlPct < 0 && !milestoneOnCooldown) {
          for (const m of DIP_MILESTONES) {
            if (pnlPct <= m && !posAlerted.has(m)) {
              posAlerted.add(m);
              db.saveAlertedMilestones(pos.id, posAlerted); // persist to DB
              this.lastMilestoneAlertTime.set(pos.id, now);
              telegramNotifier.notifyPositionMilestone(
                pos,
                pnlPct,
                m,
                pos.peakPnlPct || 0,
                currentPriceSol,
                meta || undefined
              );
              break; // ONE alert per cycle
            }
          }
        }

        // 3. Pullback From Peak Alert (if peak reached >= 30% and fell >= 20% from high)
        if ((pos.peakPnlPct || 0) >= 30) {
          const dropFromPeak = (pos.peakPnlPct || 0) - pnlPct;
          if (!this.alertedPullbacks.has(pos.id)) {
            this.alertedPullbacks.set(pos.id, new Set());
          }
          const pullbacksAlerted = this.alertedPullbacks.get(pos.id)!;

          for (const threshold of PULLBACK_DROP_THRESHOLDS) {
            if (dropFromPeak >= threshold && !pullbacksAlerted.has(threshold)) {
              pullbacksAlerted.add(threshold);
              telegramNotifier.notifyPositionPullback(
                pos,
                pnlPct,
                dropFromPeak,
                pos.peakPnlPct || 0,
                currentPriceSol,
                meta || undefined
              );
              break;
            }
          }
        }

        // 4. Calculate Dynamic Stop-Loss Floor & Zero-Loss Guarantee
        let effectiveSlFloor = -config.AUTO_SL_LOSS_PCT; // Base anti-rug floor (e.g. -30%)
        let isBreakevenActive = false;
        let isTrailingActive = false;

        if (config.TRAILING_SL_ENABLED) {
          // Zero-Loss Guarantee: If coin peak has crossed Breakeven Trigger (default: +20%)
          if (currentPeak >= config.BREAKEVEN_TRIGGER_PCT) {
            effectiveSlFloor = Math.max(effectiveSlFloor, config.BREAKEVEN_LOCK_PCT);
            isBreakevenActive = true;

            // One-time alert that Zero-Loss Guarantee is active
            if (!this.breakevenAlerted.has(pos.id)) {
              this.breakevenAlerted.add(pos.id);
              db.saveBreakevenAlerted(pos.id, true); // persist to DB
              telegramNotifier.notifyBreakevenLocked(
                pos,
                pnlPct,
                currentPeak,
                meta || undefined
              );
            }
          }

          // Dynamic Trailing Ratchet: When peak >= +30%, ratchet SL floor behind the peak
          if (currentPeak >= 30) {
            const dynamicFloor = currentPeak - config.TRAILING_SL_CUSHION_PCT;
            if (dynamicFloor > effectiveSlFloor) {
              effectiveSlFloor = dynamicFloor;
              isTrailingActive = true;
            }
          }
        }

        // 5. Check Take-Profit Trigger (+100% / 2x Moonbag)
        if (config.AUTO_TP_ENABLED && pnlPct >= config.AUTO_TP_GAIN_PCT && !pos.tp1Triggered) {
          await this.triggerTakeProfit(pos, pnlPct, meta || undefined);
          continue;
        }

        // 6. Check Stop-Loss / Trailing SL / Breakeven Exit Trigger
        if (config.AUTO_SL_ENABLED && pnlPct <= effectiveSlFloor) {
          if (isTrailingActive && effectiveSlFloor > config.BREAKEVEN_LOCK_PCT) {
            await this.triggerTrailingStopLoss(pos, pnlPct, effectiveSlFloor, currentPeak, meta || undefined);
          } else if (isBreakevenActive && effectiveSlFloor >= config.BREAKEVEN_LOCK_PCT) {
            await this.triggerBreakevenExit(pos, pnlPct, currentPeak, meta || undefined);
          } else {
            await this.triggerStopLoss(pos, pnlPct, meta || undefined);
          }
          continue;
        }
      } catch (err: any) {
        console.warn(`[AUTO-EXIT] Failed evaluating ${pos.tokenMint}:`, err.message || err);
      }
    }
  }

  /**
   * Retry wrapper for executeManualExit — survives transient 429 / network errors.
   * Tries up to maxAttempts times with increasing delay before giving up.
   */
  private async executeExitWithRetry(
    posId: string,
    fraction: number,
    isAuto: boolean,
    maxAttempts: number = 3
  ): Promise<{ order: any; position: any }> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.signalManagerRef.executeManualExit(posId, fraction, isAuto);
      } catch (err: any) {
        lastErr = err;
        const is429 = err.message?.includes('429') || err.message?.includes('Too many requests');
        if (attempt < maxAttempts) {
          const waitMs = is429 ? attempt * 5000 : attempt * 2000; // 429 → 5s, 10s; other → 2s, 4s
          console.warn(
            `[AUTO-EXIT] Exit attempt ${attempt}/${maxAttempts} failed${is429 ? ' (429 rate limit)' : ''}: ${err.message?.slice(0, 80)}. Retrying in ${waitMs / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    throw lastErr;
  }

  private async triggerTakeProfit(pos: any, pnlPct: number, meta?: TokenMetadata): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🎯 [AUTO TAKE-PROFIT] ${pos.tokenMint} at +${pnlPct.toFixed(1)}% (Target: +${config.AUTO_TP_GAIN_PCT}%). Executing ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}% exit...`
    );

    try {
      const { order, position } = await this.executeExitWithRetry(pos.id, config.AUTO_TP_SELL_FRACTION, true);

      db.markPositionTpTriggered(pos.id, pnlPct);
      this.alertedMilestones.delete(pos.id);
      this.alertedPullbacks.delete(pos.id);
      telegramNotifier.notifyAutoTakeProfit(order, position || pos, pnlPct, meta);
    } catch (err: any) {
      console.error(`❌ [AUTO TP ERROR] ${pos.tokenMint}:`, err.message || err);
    } finally {
      this.inFlightExits.delete(pos.tokenMint);
    }
  }

  private async triggerBreakevenExit(
    pos: any,
    pnlPct: number,
    peakPct: number,
    meta?: TokenMetadata
  ): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🛡️ [ZERO-LOSS BREAKEVEN EXIT] ${pos.tokenMint} at ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (Peak was +${peakPct.toFixed(1)}%). Executing 100% exit...`
    );

    try {
      const { order, position } = await this.executeExitWithRetry(pos.id, 1.0, true);

      this.alertedMilestones.delete(pos.id);
      this.alertedPullbacks.delete(pos.id);
      this.breakevenAlerted.delete(pos.id);
      telegramNotifier.notifyBreakevenExit(order, position || pos, pnlPct, peakPct, meta);
    } catch (err: any) {
      console.error(`❌ [ZERO-LOSS EXIT ERROR] ${pos.tokenMint}:`, err.message || err);
    } finally {
      this.inFlightExits.delete(pos.tokenMint);
    }
  }

  private async triggerTrailingStopLoss(
    pos: any,
    pnlPct: number,
    floorPct: number,
    peakPct: number,
    meta?: TokenMetadata
  ): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🎯 [TRAILING STOP-LOSS EXIT] ${pos.tokenMint} at +${pnlPct.toFixed(1)}% (Floor: +${floorPct.toFixed(1)}%, Peak: +${peakPct.toFixed(1)}%). Executing 100% exit to lock profit...`
    );

    try {
      const { order, position } = await this.executeExitWithRetry(pos.id, 1.0, true);

      this.alertedMilestones.delete(pos.id);
      this.alertedPullbacks.delete(pos.id);
      this.breakevenAlerted.delete(pos.id);
      telegramNotifier.notifyTrailingStopLoss(order, position || pos, pnlPct, floorPct, peakPct, meta);
    } catch (err: any) {
      console.error(`❌ [TRAILING SL ERROR] ${pos.tokenMint}:`, err.message || err);
    } finally {
      this.inFlightExits.delete(pos.tokenMint);
    }
  }

  private async triggerStopLoss(pos: any, pnlPct: number, meta?: TokenMetadata): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🛡️ [AUTO STOP-LOSS] ${pos.tokenMint} at ${pnlPct.toFixed(1)}% (Floor: -${config.AUTO_SL_LOSS_PCT}%). Executing 100% emergency exit...`
    );

    try {
      const { order, position } = await this.executeExitWithRetry(pos.id, 1.0, true);

      this.alertedMilestones.delete(pos.id);
      this.alertedPullbacks.delete(pos.id);
      this.breakevenAlerted.delete(pos.id);
      telegramNotifier.notifyAutoStopLoss(order, position || pos, pnlPct, meta);
    } catch (err: any) {
      console.error(`❌ [AUTO SL ERROR] ${pos.tokenMint}:`, err.message || err);
    } finally {
      this.inFlightExits.delete(pos.tokenMint);
    }
  }
}

export const autoExitManager = new AutoExitManager();