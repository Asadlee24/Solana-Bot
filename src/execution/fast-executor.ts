import { Connection, PublicKey } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import {
  calculateEstimatedFeesLamports,
  config,
  solToLamportsBigInt,
} from '../config/index.js';
import { db } from '../db/database.js';
import { pendingOrderManager } from '../engine/pending-order-manager.js';
import { positionEngine } from '../engine/position-engine.js';
import { riskEngine } from '../engine/risk-engine.js';
import { telegramNotifier } from '../notifications/telegram.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';
import { capitalReservationLedger } from '../services/capital-reservation.js';
import { curveStateCache } from '../services/curve-state-cache.js';
import { latencyTracker } from '../telemetry/latency-tracker.js';
import {
  FastPathTimestamps,
  MirrorIntent,
  MirrorOrder,
  SwapIntent,
} from '../types/index.js';
import { fastPumpBuilder } from './fast-pump-builder.js';
import { FastSimulationPolicy } from './fast-simulation-policy.js';
import { settlementReconciler } from './settlement-reconciler.js';
import { transactionSubmitter } from './transaction-submitter.js';
import { executionWalletManager } from './wallet-manager.js';

export interface FastExecutionResult {
  order: MirrorOrder;
  fallbackNeeded: boolean;
  fallbackReason?: string;
}

export class FastExecutionService {
  private connection: Connection;

  constructor(connection?: Connection) {
    this.connection =
      connection ||
      new Connection(config.SOLANA_RPC_URL, {
        commitment: 'processed',
        confirmTransactionInitialTimeout: 20000,
      });
  }

  /**
   * Fast Hot Path for Direct Pump.fun BUY
   */
  public async executeFastBuy(params: {
    targetIntent: SwapIntent;
    mirrorIntent: MirrorIntent;
    timestamps: FastPathTimestamps;
    targetEnvelope?: ParsedTransactionEnvelope;
  }): Promise<FastExecutionResult> {
    const { targetIntent, mirrorIntent, timestamps, targetEnvelope } = params;

    // 1. Eligibility Check: Venue must be PUMPFUN and side must be BUY
    if (targetIntent.venue !== 'PUMPFUN' || targetIntent.side !== 'BUY') {
      return {
        order: null as any,
        fallbackNeeded: true,
        fallbackReason: `Fast-Path only supports direct Pump.fun BUY (venue=${targetIntent.venue}, side=${targetIntent.side})`,
      };
    }

    const keypair = executionWalletManager.getKeypair();
    if (!keypair) {
      return {
        order: null as any,
        fallbackNeeded: true,
        fallbackReason: 'Execution keypair not available',
      };
    }

    const mint = targetIntent.tokenMint;
    const requestedLamports = BigInt(mirrorIntent.requestedInAmountRaw || '0');
    if (requestedLamports <= 0n) {
      throw new Error(`Invalid requestedLamports: ${requestedLamports}`);
    }

    // 2. Fee Calculation & Capital Reservation Check
    const feeCalculation = calculateEstimatedFeesLamports(
      BigInt(config.PRIORITY_FEE_MICRO_LAMPORTS),
      250_000n,
      BigInt(config.HELIUS_SENDER_TIP_LAMPORTS)
    );
    const minReserveFloor = solToLamportsBigInt(config.MIN_SOL_RESERVE_SOL);
    const totalReservationNeeded = requestedLamports + feeCalculation.totalEstimatedFeesLamports;

    // Check spendable balance: subtracts active pending reservations and MIN_SOL_RESERVE_SOL exactly once globally
    const currentCachedBalance = executionWalletManager.getCachedBalanceLamports();
    const spendable = capitalReservationLedger.calculateSpendableLamports(
      currentCachedBalance,
      minReserveFloor
    );

    if (spendable < totalReservationNeeded) {
      const msg = `Insufficient spendable balance after pending reservations (available: ${(Number(spendable) / 1e9).toFixed(4)} SOL, required: ${(Number(totalReservationNeeded) / 1e9).toFixed(4)} SOL)`;
      console.warn(`[FastExecution] ${msg}`);
      throw new Error(msg);
    }

    // 3. Strict Idempotency Registration & State Machine Initialization
    const idempotencyKey = `${targetIntent.targetSignature}:${mint}:BUY`;

    const regResult = pendingOrderManager.registerOrder({
      targetSignature: targetIntent.targetSignature,
      mint,
      side: 'BUY',
      amountLamports: requestedLamports,
      reservationLamports: totalReservationNeeded,
      recentBlockhash: '', // will update upon build
      targetWallet: targetIntent.targetWallet,
    });

    if (!regResult.success) {
      console.warn(`[FastExecution] Duplicate trade blocked: ${regResult.error}`);
      throw new Error(regResult.error);
    }

    timestamps.persistence_completed = process.hrtime.bigint();

    // 4. Bonding Curve State Verification
    const curveStateResult = await curveStateCache.getOrFetchCurveState(
      mint,
      targetEnvelope,
      this.connection
    );

    if (!curveStateResult.verified || !curveStateResult.state) {
      console.warn(`[FastExecution] Curve state could not be verified: ${curveStateResult.reason}. Safe fallback triggered.`);
      pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', {
        error: `Curve state unavailable: ${curveStateResult.reason}`,
      });
      return {
        order: null as any,
        fallbackNeeded: true,
        fallbackReason: `Curve state unavailable: ${curveStateResult.reason}`,
      };
    }

    timestamps.state_ready = process.hrtime.bigint();

    const maxSlippageBps = config.MAX_SLIPPAGE_BPS;

    // 5. Fast Transaction Build
    timestamps.build_started = process.hrtime.bigint();

    let buildResult;
    try {
      buildResult = await fastPumpBuilder.buildFastBuy(
        keypair,
        mint,
        requestedLamports,
        curveStateResult.state,
        maxSlippageBps
      );
    } catch (buildErr: any) {
      console.warn(`[FastExecution] Fast builder error: ${buildErr.message}. Falling back.`);
      pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', {
        error: buildErr.message,
      });
      return {
        order: null as any,
        fallbackNeeded: true,
        fallbackReason: buildErr.message,
      };
    }

    timestamps.tx_built = process.hrtime.bigint();
    timestamps.tx_signed = timestamps.tx_built; // Builder signs in-memory synchronously

    // Update pending order with follower signature
    pendingOrderManager.transitionState(idempotencyKey, 'PREPARED', {
      followerSignature: buildResult.signature,
    });

    // 6. Simulation Policy Evaluation
    const simPolicy = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: maxSlippageBps,
      curveStateVerified: curveStateResult.verified,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: buildResult.tokenProgramId.toBase58(),
    });

    if (simPolicy.shouldSimulate) {
      console.info(`[FastExecution] Simulation required (${simPolicy.reason}). Running preflight check...`);
      try {
        const sim = await this.connection.simulateTransaction(buildResult.transaction, {
          sigVerify: false,
          replaceRecentBlockhash: false,
        });
        if (sim.value.err) {
          const errLogs = sim.value.logs?.slice(-3).join('; ') || 'No logs';
          const errMsg = `Fast simulation failed: ${JSON.stringify(sim.value.err)} | ${errLogs}`;
          console.error(`[FastExecution] ${errMsg}`);
          pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', { error: errMsg });
          throw new Error(errMsg);
        }
      } catch (simErr: any) {
        pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', { error: simErr.message });
        throw simErr;
      }
    } else {
      console.info(`[FastExecution ⚡] Simulation safely bypassed: ${simPolicy.reason}`);
    }

    // 7. Fast Broadcast (Non-Blocking)
    pendingOrderManager.transitionState(idempotencyKey, 'SUBMITTING');
    timestamps.broadcast_started = process.hrtime.bigint();

    const broadcastResult = await transactionSubmitter.broadcastFast(
      buildResult.transaction,
      buildResult.signature
    );

    timestamps.broadcast_completed = process.hrtime.bigint();

    if (!broadcastResult.broadcastOk) {
      console.warn(
        `[FastExecution] Broadcast returned error (${broadcastResult.error}). Status is UNCERTAIN. Not blindly retrying.`
      );
      pendingOrderManager.transitionState(idempotencyKey, 'SUBMISSION_UNKNOWN', {
        error: broadcastResult.error,
      });
    } else {
      pendingOrderManager.transitionState(idempotencyKey, 'SUBMITTED');
    }

    const orderId = randomUUID();

    const order: MirrorOrder = {
      orderId,
      intentId: mirrorIntent.id,
      targetSignature: targetIntent.targetSignature,
      followerSignature: buildResult.signature,
      orderSignature: buildResult.signature,
      mode: config.EXECUTION_MODE,
      side: 'BUY',
      tokenMint: mint,
      inAmountRaw: requestedLamports.toString(),
      outAmountRaw: buildResult.outAmountRaw,
      minOutAmountRaw: buildResult.outAmountRaw,
      actualInAmountRaw: requestedLamports.toString(),
      actualOutAmountRaw: buildResult.outAmountRaw,
      effectivePrice: buildResult.effectivePriceSol,
      priorityFeeLamports: feeCalculation.estimatedPriorityFeeLamports,
      tipLamports: feeCalculation.senderTipLamports,
      routeFeeLamports: 0n,
      status: 'SUBMITTED',
      quotedAt: timestamps.build_started || process.hrtime.bigint(),
      submittedAt: timestamps.broadcast_completed || process.hrtime.bigint(),
      targetWallet: targetIntent.targetWallet,
    };

    // 8. Launch Asynchronous Background Reconciliation Worker
    this.reconcileAsync({
      orderId,
      idempotencyKey,
      signature: buildResult.signature,
      blockhash: buildResult.latestBlockhash.blockhash,
      lastValidBlockHeight: buildResult.latestBlockhash.lastValidBlockHeight,
      mint,
      requestedLamports,
      targetIntent,
      mirrorIntent,
      order,
      timestamps,
    });

    // 9. Hot path ends here immediately after broadcast!
    return {
      order,
      fallbackNeeded: false,
    };
  }

  /**
   * Background Asynchronous Reconciliation Worker:
   * Handles confirmation, settlement, position registration, telemetry, and notifications.
   */
  private async reconcileAsync(params: {
    orderId: string;
    idempotencyKey: string;
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
    mint: string;
    requestedLamports: bigint;
    targetIntent: SwapIntent;
    mirrorIntent: MirrorIntent;
    order: MirrorOrder;
    timestamps: FastPathTimestamps;
  }): Promise<void> {
    const {
      orderId,
      idempotencyKey,
      signature,
      blockhash,
      lastValidBlockHeight,
      mint,
      requestedLamports,
      targetIntent,
      order,
      timestamps,
    } = params;

    const submittedAt = timestamps.broadcast_completed || process.hrtime.bigint();

    try {
      const receipt = await transactionSubmitter.reconcileStatus(
        signature,
        { blockhash, lastValidBlockHeight },
        submittedAt,
        'HELIUS_SWQOS',
        30000
      );

      if (receipt.status === 'CONFIRMED') {
        timestamps.confirmed = process.hrtime.bigint();
        timestamps.landed = receipt.confirmedAt || timestamps.confirmed;

        order.status = 'FILLED';
        order.landedAt = timestamps.landed;

        // Reconcile on-chain balance & settlements
        try {
          const keypair = executionWalletManager.getKeypair();
          if (keypair) {
            await settlementReconciler.reconcileConfirmedTrade(
              signature,
              keypair.publicKey,
              mint,
              'BUY',
              requestedLamports,
              BigInt(order.outAmountRaw),
              order.effectivePrice
            );
          }
        } catch (settleErr) {
          console.warn('[FastExecution] Settlement reconciler warning:', settleErr);
        }

        // Register position in PositionEngine
        if (targetIntent.targetWallet) {
          positionEngine.recordFill(
            targetIntent.targetWallet,
            mint,
            'BUY',
            BigInt(order.outAmountRaw),
            requestedLamports,
            order.effectivePrice,
            signature,
            order.priorityFeeLamports + order.tipLamports
          );
        }

        // Definitive Resolution: mark confirmed in pendingOrderManager
        pendingOrderManager.resolveOrder(idempotencyKey, 'CONFIRMED');
        riskEngine.recordBuy(mint);
        riskEngine.recordSuccess();

        timestamps.settled = process.hrtime.bigint();

        // Async Telegram Notification
        const pos = db.getPosition(targetIntent.targetWallet, mint);
        telegramNotifier.notifyTradeFilled(order, pos || undefined);

        console.info(`[FastExecution ⚡] Order ${signature.slice(0, 8)}... CONFIRMED & SETTLED`);
      } else if (receipt.status === 'EXPIRED') {
        order.status = 'FAILED';
        order.error = receipt.error || 'Transaction expired on-chain';
        order.errorMessage = order.error;
        pendingOrderManager.resolveOrder(idempotencyKey, 'EXPIRED', {
          error: order.error,
        });
        riskEngine.recordError(order.error);
        console.warn(`[FastExecution] Order ${signature.slice(0, 8)}... EXPIRED`);
      } else {
        order.status = 'FAILED';
        order.error = receipt.error || 'Transaction failed on-chain';
        order.errorMessage = order.error;
        pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', {
          error: order.error,
        });
        riskEngine.recordError(order.error);
        console.warn(`[FastExecution] Order ${signature.slice(0, 8)}... FAILED: ${order.error}`);
      }
    } catch (reconcileErr: any) {
      order.status = 'FAILED';
      order.error = reconcileErr.message;
      order.errorMessage = reconcileErr.message;
      pendingOrderManager.resolveOrder(idempotencyKey, 'FAILED', {
        error: reconcileErr.message,
      });
      riskEngine.recordError(reconcileErr.message);
      console.error(`[FastExecution] Async reconciliation error:`, reconcileErr);
    } finally {
      // Record complete telemetry sample
      latencyTracker.recordFastPathTelemetry({
        targetSignature: targetIntent.targetSignature,
        followerSignature: signature,
        mint,
        timestamps,
      });
    }
  }
}

export const fastExecutionService = new FastExecutionService();
