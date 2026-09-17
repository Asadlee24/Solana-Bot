import { randomUUID } from 'crypto';
import { db } from '../db/database.js';
import { positionEngine } from '../engine/position-engine.js';
import {
  FollowerPosition,
  MirrorIntent,
  MirrorOrder,
  SwapIntent,
} from '../types/index.js';

export interface PaperExecutionParams {
  simulatedLeaderDelayMs?: number; // Leader inclusion latency (100 - 300 ms)
  simulatedPriorityFeeLamports?: bigint;
  simulatedTipLamports?: bigint;
  priceImpactBps?: number;
}

export class PaperExecutionEngine {
  /**
   * Execute high-fidelity paper trade simulating realistic AMM fill
   */
  public async executePaperTrade(
    targetIntent: SwapIntent,
    mirrorIntent: MirrorIntent,
    params: PaperExecutionParams = {}
  ): Promise<MirrorOrder> {
    const quotedAt = process.hrtime.bigint();
    const orderId = randomUUID();

    const leaderDelayMs = params.simulatedLeaderDelayMs ?? Math.floor(120 + Math.random() * 80); // 120-200ms
    const priorityFee = params.simulatedPriorityFeeLamports ?? 100_000n; // 0.0001 SOL
    const tip = params.simulatedTipLamports ?? 100_000n; // 0.0001 SOL
    const routeFee = 5_000n; // Base signature fee 5000 lamports

    const isBuy = mirrorIntent.side === 'BUY';
    const targetPrice = targetIntent.estimatedPrice;

    // Simulate realistic obtainable price:
    // Follower arrives slightly later than target.
    // Target's trade + followers moved the curve!
    // We add realistic slippage and price impact (e.g. 15-50 bps for small orders, more for illiquid)
    const baseImpactBps = params.priceImpactBps ?? (isBuy ? 25 + Math.random() * 30 : -(25 + Math.random() * 30));
    const effectiveMultiplier = 1 + baseImpactBps / 10000;
    const effectivePrice = targetPrice > 0 ? targetPrice * effectiveMultiplier : 0.00001;

    let inAmountRaw = mirrorIntent.requestedInAmountRaw;
    let outAmountRaw = '0';
    let minOutRaw = '0';

    if (isBuy) {
      // In amount is SOL lamports
      const solSpentLamports = BigInt(inAmountRaw);
      const solFloat = Number(solSpentLamports) / 1e9;
      const tokensOutFloat = effectivePrice > 0 ? solFloat / effectivePrice : 0;
      const tokensOutRaw = BigInt(Math.floor(tokensOutFloat * 1e6));
      outAmountRaw = tokensOutRaw.toString();
      // Slippage tolerance 1% minOut
      minOutRaw = BigInt(Math.floor(Number(tokensOutRaw) * 0.99)).toString();
    } else {
      // In amount is Token units
      const tokensSoldRaw = BigInt(inAmountRaw);
      const tokensFloat = Number(tokensSoldRaw) / 1e6;
      const solOutFloat = tokensFloat * effectivePrice;
      const solOutLamports = BigInt(Math.floor(solOutFloat * 1e9));
      outAmountRaw = solOutLamports.toString();
      minOutRaw = BigInt(Math.floor(Number(solOutLamports) * 0.99)).toString();
    }

    const signedAt = quotedAt + 500_000n; // ~0.5ms signing delay
    const submittedAt = signedAt + 2_000_000n; // ~2ms network submission
    const landedAt = submittedAt + BigInt(leaderDelayMs) * 1_000_000n;

    const paperSignature = `sim_${orderId.substring(0, 16)}`;

    const order: MirrorOrder = {
      orderId,
      intentId: mirrorIntent.id,
      targetSignature: targetIntent.targetSignature,
      mode: 'PAPER',
      side: mirrorIntent.side,
      tokenMint: mirrorIntent.tokenMint,
      inAmountRaw,
      outAmountRaw,
      minOutAmountRaw: minOutRaw,
      effectivePrice,
      quotedAt,
      signedAt,
      submittedAt,
      landedAt,
      orderSignature: paperSignature,
      priorityFeeLamports: priorityFee,
      tipLamports: tip,
      routeFeeLamports: routeFee,
      status: 'FILLED',
    };

    // Save order in database
    db.saveMirrorOrder(order);

    // Update Follower Position
    if (isBuy) {
      positionEngine.recordFill(
        mirrorIntent.targetWallet,
        mirrorIntent.tokenMint,
        'BUY',
        BigInt(outAmountRaw),
        BigInt(inAmountRaw),
        effectivePrice,
        paperSignature
      );
    } else {
      positionEngine.recordFill(
        mirrorIntent.targetWallet,
        mirrorIntent.tokenMint,
        'SELL',
        BigInt(inAmountRaw),
        BigInt(outAmountRaw),
        effectivePrice,
        paperSignature
      );
    }

    return order;
  }
}

export const paperEngine = new PaperExecutionEngine();
