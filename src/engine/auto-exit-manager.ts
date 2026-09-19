import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { telegramNotifier } from '../notifications/telegram.js';
import { executionWalletManager } from '../execution/wallet-manager.js';

const PUMP_MILESTONES = [25, 50, 75, 100, 150, 200, 300, 500, 1000];
const DIP_MILESTONES = [-15, -25, -35, -50];
const PULLBACK_DROP_THRESHOLDS = [20, 35, 50];

export class AutoExitManager {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private inFlightExits: Set<string> = new Set();
  private signalManagerRef: any = null;
  private alertedMilestones: Map<string, Set<number>> = new Map();
  private alertedPullbacks: Map<string, Set<number>> = new Map();

  public start(signalManager: any): void {
    if (this.isRunning) return;
    this.signalManagerRef = signalManager;
    this.isRunning = true;

    console.info(
      `[AUTO-EXIT] Engine started | TP: ${config.AUTO_TP_ENABLED ? `+${config.AUTO_TP_GAIN_PCT}% (Sell ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}%)` : 'OFF'} | SL: ${config.AUTO_SL_ENABLED ? `-${config.AUTO_SL_LOSS_PCT}% (Sell 100%)` : 'OFF'} | Poll: ${config.AUTO_EXIT_POLL_INTERVAL_MS}ms`
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
            continue;
          }
        } catch {}
      }

      try {
        const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
        const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : 0;
        if (!currentPriceSol || pos.avgEntryPriceSol <= 0) continue;

        // Unrealized ROI in percent
        const pnlPct = ((currentPriceSol - pos.avgEntryPriceSol) / pos.avgEntryPriceSol) * 100;

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
        if (pnlPct > 0) {
          for (const m of PUMP_MILESTONES) {
            if (pnlPct >= m && !posAlerted.has(m)) {
              posAlerted.add(m);
              telegramNotifier.notifyPositionMilestone(
                pos,
                pnlPct,
                m,
                pos.peakPnlPct || pnlPct,
                currentPriceSol,
                meta || undefined
              );
              break;
            }
          }
        }

        // Negative Dip Milestones (-15%, -25%, -35%, -50%...)
        if (pnlPct < 0) {
          for (const m of DIP_MILESTONES) {
            if (pnlPct <= m && !posAlerted.has(m)) {
              posAlerted.add(m);
              telegramNotifier.notifyPositionMilestone(
                pos,
                pnlPct,
                m,
                pos.peakPnlPct || 0,
                currentPriceSol,
                meta || undefined
              );
              break;
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

        // 4. Check Take-Profit Trigger (+100% / 2x Moonbag)
        if (config.AUTO_TP_ENABLED && pnlPct >= config.AUTO_TP_GAIN_PCT && !pos.tp1Triggered) {
          await this.triggerTakeProfit(pos, pnlPct, meta || undefined);
          continue;
        }

        // 5. Check Stop-Loss Trigger (-50% Anti-Rug)
        if (config.AUTO_SL_ENABLED && pnlPct <= -config.AUTO_SL_LOSS_PCT) {
          await this.triggerStopLoss(pos, pnlPct, meta || undefined);
          continue;
        }
      } catch (err: any) {
        console.warn(`[AUTO-EXIT] Failed evaluating ${pos.tokenMint}:`, err.message || err);
      }
    }
  }

  private async triggerTakeProfit(pos: any, pnlPct: number, meta?: TokenMetadata): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🎯 [AUTO TAKE-PROFIT] ${pos.tokenMint} at +${pnlPct.toFixed(1)}% (Target: +${config.AUTO_TP_GAIN_PCT}%). Executing ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}% exit...`
    );

    try {
      const { order, position } = await this.signalManagerRef.executeManualExit(
        pos.id,
        config.AUTO_TP_SELL_FRACTION
      );

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

  private async triggerStopLoss(pos: any, pnlPct: number, meta?: TokenMetadata): Promise<void> {
    this.inFlightExits.add(pos.tokenMint);
    console.info(
      `🛡️ [AUTO STOP-LOSS] ${pos.tokenMint} at ${pnlPct.toFixed(1)}% (Floor: -${config.AUTO_SL_LOSS_PCT}%). Executing 100% emergency exit...`
    );

    try {
      const { order, position } = await this.signalManagerRef.executeManualExit(pos.id, 1.0);

      this.alertedMilestones.delete(pos.id);
      this.alertedPullbacks.delete(pos.id);
      telegramNotifier.notifyAutoStopLoss(order, position || pos, pnlPct, meta);
    } catch (err: any) {
      console.error(`❌ [AUTO SL ERROR] ${pos.tokenMint}:`, err.message || err);
    } finally {
      this.inFlightExits.delete(pos.tokenMint);
    }
  }
}

export const autoExitManager = new AutoExitManager();