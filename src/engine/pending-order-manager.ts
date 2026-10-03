import { Connection } from '@solana/web3.js';
import { db } from '../db/database.js';
import { riskEngine } from './risk-engine.js';
import { positionEngine } from './position-engine.js';
import { capitalReservationLedger } from '../services/capital-reservation.js';
import { PendingOrderRecord, PendingOrderState, TradeSide } from '../types/index.js';

export class PendingOrderManager {
  private ordersByKey: Map<string, PendingOrderRecord> = new Map();

  constructor() {
    this.hydrateFromDb();
  }

  private hydrateFromDb(): void {
    const pending = db.getPendingOrders(true);
    for (const order of pending) {
      this.ordersByKey.set(order.idempotencyKey, order);
    }
  }

  public static generateIdempotencyKey(targetSignature: string, mint: string, side: string): string {
    return `${targetSignature}:${mint}:${side}`;
  }

  public hasOrder(idempotencyKey: string): boolean {
    if (this.ordersByKey.has(idempotencyKey)) return true;
    const existing = db.getPendingOrderByKey(idempotencyKey);
    return !!existing;
  }

  public getOrder(idempotencyKey: string): PendingOrderRecord | undefined {
    return this.ordersByKey.get(idempotencyKey) || db.getPendingOrderByKey(idempotencyKey) || undefined;
  }

  public isTokenLocked(mint: string): boolean {
    for (const order of this.ordersByKey.values()) {
      if (
        order.tokenMint === mint &&
        order.side === 'BUY' &&
        (order.state === 'PREPARED' ||
          order.state === 'SUBMITTING' ||
          order.state === 'SUBMITTED' ||
          order.state === 'SUBMISSION_UNKNOWN')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Registers a new pending order before broadcast.
   * Atomically asserts idempotency, locks token, and registers DB record.
   */
  public registerOrder(params: {
    targetSignature: string;
    followerSignature?: string;
    mint: string;
    side: TradeSide;
    amountLamports: bigint;
    reservationLamports: bigint;
    recentBlockhash: string;
    lastValidBlockHeight?: number;
    targetWallet?: string;
  }): { success: boolean; record?: PendingOrderRecord; error?: string } {
    const idempotencyKey = PendingOrderManager.generateIdempotencyKey(
      params.targetSignature,
      params.mint,
      params.side
    );

    if (this.hasOrder(idempotencyKey)) {
      return {
        success: false,
        error: `Duplicate order rejected by idempotency guard: ${idempotencyKey}`,
      };
    }

    const now = Date.now();
    const record: PendingOrderRecord = {
      idempotencyKey,
      targetSignature: params.targetSignature,
      followerSignature: params.followerSignature,
      tokenMint: params.mint,
      side: params.side,
      amountInLamports: params.amountLamports.toString(),
      reservedLamports: params.reservationLamports.toString(),
      recentBlockhash: params.recentBlockhash,
      lastValidBlockHeight: params.lastValidBlockHeight,
      state: 'PREPARED',
      createdAt: now,
      updatedAt: now,
      targetWallet: params.targetWallet,
    };

    // 1. Lock token mint in risk engine
    if (params.side === 'BUY') {
      riskEngine.markInFlight(params.mint);
    }

    // 2. Reserve capital in ledger
    capitalReservationLedger.reserveSimple(
      idempotencyKey,
      params.mint,
      params.reservationLamports,
      params.targetWallet
    );

    // 3. Persist to DB before broadcast
    db.savePendingOrder(record);
    this.ordersByKey.set(idempotencyKey, record);

    return { success: true, record };
  }

  /**
   * Transition order state (e.g. PREPARED -> SUBMITTING -> SUBMITTED)
   */
  public transitionState(
    idempotencyKey: string,
    state: PendingOrderState,
    extra?: { followerSignature?: string; error?: string }
  ): void {
    const order = this.getOrder(idempotencyKey);
    if (!order) return;

    order.state = state;
    order.updatedAt = Date.now();
    if (extra?.followerSignature) {
      order.followerSignature = extra.followerSignature;
    }
    if (extra?.error) {
      order.errorMessage = extra.error;
    }

    this.ordersByKey.set(idempotencyKey, order);
    db.updatePendingOrderState(idempotencyKey, state, extra?.error, extra?.followerSignature);
  }

  /**
   * Resolves order definitively (CONFIRMED, FAILED, or EXPIRED).
   * Safely releases in-flight lock and capital reservation.
   */
  public resolveOrder(
    idempotencyKey: string,
    state: 'CONFIRMED' | 'FAILED' | 'EXPIRED',
    extra?: { error?: string }
  ): void {
    const order = this.getOrder(idempotencyKey);
    if (!order) return;

    this.transitionState(idempotencyKey, state, extra);

    // Release capital reservation
    capitalReservationLedger.release(idempotencyKey);

    // Release in-flight token lock
    if (order.side === 'BUY') {
      riskEngine.clearInFlightBuy(order.tokenMint);
    }

    // Cleanup memory map once resolved
    this.ordersByKey.delete(idempotencyKey);
    console.info(`[PendingOrderManager] Resolved order ${idempotencyKey} as ${state}`);
  }

  /**
   * Startup Crash Recovery Routine:
   * Scans unresolved orders, inspects on-chain status, and reconciles state.
   */
  public async recover(connection: Connection): Promise<{
    recoveredCount: number;
    confirmedCount: number;
    failedCount: number;
    retainedCount: number;
  }> {
    const unresolved = db.getPendingOrders(true);

    let confirmedCount = 0;
    let failedCount = 0;
    let retainedCount = 0;

    if (unresolved.length === 0) {
      console.info('[CrashRecovery] No unresolved pending orders found. Working state clean.');
      return { recoveredCount: 0, confirmedCount: 0, failedCount: 0, retainedCount: 0 };
    }

    console.warn(`[CrashRecovery] Found ${unresolved.length} unresolved orders. Reconciling...`);

    let currentBlockHeight = 0;
    try {
      currentBlockHeight = await connection.getBlockHeight('processed');
    } catch {}

    for (const order of unresolved) {
      // Re-hydrate memory and restore capital reservation and token locks while recovering
      this.ordersByKey.set(order.idempotencyKey, order);
      if (order.side === 'BUY') {
        riskEngine.markInFlight(order.tokenMint);
      }
      capitalReservationLedger.reserveSimple(
        order.idempotencyKey,
        order.tokenMint,
        BigInt(order.reservedLamports || order.amountInLamports || '0'),
        order.targetWallet
      );

      if (!order.followerSignature) {
        // Crashed before follower signature was produced
        console.warn(`[CrashRecovery] Order ${order.idempotencyKey} had no follower signature. Marking FAILED.`);
        this.resolveOrder(order.idempotencyKey, 'FAILED', {
          error: 'Process crashed before broadcast was confirmed',
        });
        failedCount++;
        continue;
      }

      // Check on-chain signature status
      try {
        const statuses = await connection.getSignatureStatuses([order.followerSignature], {
          searchTransactionHistory: true,
        });
        const st = statuses.value?.[0];

        if (st) {
          if (st.err) {
            console.warn(`[CrashRecovery] Signature ${order.followerSignature} failed on-chain: ${JSON.stringify(st.err)}`);
            this.resolveOrder(order.idempotencyKey, 'FAILED', {
              error: `Transaction failed on-chain: ${JSON.stringify(st.err)}`,
            });
            failedCount++;
            continue;
          }

          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
            console.info(`[CrashRecovery] Signature ${order.followerSignature} was CONFIRMED on-chain.`);
            this.resolveOrder(order.idempotencyKey, 'CONFIRMED');
            confirmedCount++;
            continue;
          }
        }

        // If block height is past lastValidBlockHeight, mark expired
        if (
          order.lastValidBlockHeight &&
          currentBlockHeight > 0 &&
          currentBlockHeight > order.lastValidBlockHeight
        ) {
          console.warn(`[CrashRecovery] Signature ${order.followerSignature} expired (height ${currentBlockHeight} > ${order.lastValidBlockHeight}).`);
          this.resolveOrder(order.idempotencyKey, 'EXPIRED', {
            error: `Blockhash expired (current height: ${currentBlockHeight})`,
          });
          failedCount++;
          continue;
        }

        // Order is still in flight: retain lock and keep polling in background
        retainedCount++;
        console.info(`[CrashRecovery] Order ${order.idempotencyKey} is still in flight. Retaining lock and reservation.`);
        this.pollInFlightOrder(connection, order);
      } catch (err: any) {
        console.error(`[CrashRecovery] Error inspecting signature ${order.followerSignature}:`, err);
        retainedCount++;
      }
    }

    return {
      recoveredCount: unresolved.length,
      confirmedCount,
      failedCount,
      retainedCount,
    };
  }

  private pollInFlightOrder(connection: Connection, order: PendingOrderRecord): void {
    if (!order.followerSignature) return;
    const sig = order.followerSignature;
    const maxPollMs = 30000;
    const startTime = Date.now();

    const interval = setInterval(async () => {
      if (Date.now() - startTime > maxPollMs) {
        clearInterval(interval);
        this.resolveOrder(order.idempotencyKey, 'EXPIRED', {
          error: 'Background reconciliation timed out after crash recovery',
        });
        return;
      }

      try {
        const statuses = await connection.getSignatureStatuses([sig]);
        const st = statuses.value?.[0];
        if (st) {
          if (st.err) {
            clearInterval(interval);
            this.resolveOrder(order.idempotencyKey, 'FAILED', {
              error: `Transaction failed: ${JSON.stringify(st.err)}`,
            });
            return;
          }
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
            clearInterval(interval);
            this.resolveOrder(order.idempotencyKey, 'CONFIRMED');
            return;
          }
        }
      } catch {}
    }, 2000);
  }
}

export const pendingOrderManager = new PendingOrderManager();
