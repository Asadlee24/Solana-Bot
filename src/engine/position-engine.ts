import { randomUUID } from 'crypto';
import { config, solToLamportsBigInt } from '../config/index.js';
import { db } from '../db/database.js';
import {
  FollowerPosition,
  MirrorIntent,
  RiskDecision,
  SwapIntent,
  WatchedWallet,
} from '../types/index.js';

export class PositionEngine {
  /**
   * Determine exact mirror trade intent from target swap intent
   */
  public prepareMirrorIntent(
    targetIntent: SwapIntent,
    walletConfig: WatchedWallet,
    riskDecision: RiskDecision,
    riskReason?: string
  ): MirrorIntent {
    const intentId = randomUUID();
    const isBuy = targetIntent.side === 'BUY';

    let requestedInAmountRaw = '0';
    let sellFraction: number | undefined = undefined;

    if (isBuy) {
      // Sizing calculation for BUY
      requestedInAmountRaw = this.calculateBuySizeLamports(targetIntent, walletConfig).toString();
    } else {
      // Sizing calculation for SELL: Proportional exit
      const position = db.getPosition(targetIntent.targetWallet, targetIntent.tokenMint);
      if (position && position.state === 'OPEN' && BigInt(position.qtyRaw) > 0n) {
        // Compute target sell fraction: f_sell = min(1, S_t / B_t)
        const targetSoldRaw = BigInt(targetIntent.inputAmountRaw);
        const targetPreBalRaw = targetIntent.targetPreBalanceToken
          ? BigInt(targetIntent.targetPreBalanceToken)
          : targetSoldRaw; // fallback to 100% if pre-balance unknown

        const fraction =
          targetPreBalRaw > 0n ? Number(targetSoldRaw) / Number(targetPreBalRaw) : 1.0;
        sellFraction = Math.min(1.0, Math.max(0.0, fraction));

        const followerBalRaw = BigInt(position.qtyRaw);
        // S_m = round(f_sell * B_m)
        const followerSellRaw = BigInt(Math.floor(Number(followerBalRaw) * sellFraction));
        requestedInAmountRaw = followerSellRaw > 0n ? followerSellRaw.toString() : position.qtyRaw;
      } else {
        // Nothing to sell
        requestedInAmountRaw = '0';
        sellFraction = 1.0;
      }
    }

    const intent: MirrorIntent = {
      id: intentId,
      targetSignature: targetIntent.targetSignature,
      targetWallet: targetIntent.targetWallet,
      side: targetIntent.side,
      tokenMint: targetIntent.tokenMint,
      inputMint: targetIntent.inputMint,
      outputMint: targetIntent.outputMint,
      requestedInAmountRaw,
      expectedOutAmountRaw: '0',
      sellFraction,
      riskDecision,
      riskReason,
      createdAt: process.hrtime.bigint(),
    };

    // Save to database
    db.saveMirrorIntent(intent);

    return intent;
  }

  /**
   * Sizing calculation based on configured mode
   */
  private calculateBuySizeLamports(intent: SwapIntent, walletConfig: WatchedWallet): bigint {
    const fixedLamports = BigInt(walletConfig.fixedBuyLamports);
    const maxLamports = BigInt(walletConfig.maxBuyLamports);

    switch (walletConfig.buyMode) {
      case 'FIXED_SIZE':
        return fixedLamports < maxLamports ? fixedLamports : maxLamports;

      case 'TARGET_NOTIONAL_SCALAR': {
        const targetSpentLamports = BigInt(intent.inputAmountRaw);
        const scaled = BigInt(Math.floor(Number(targetSpentLamports) * walletConfig.copyRatio));
        return scaled < maxLamports ? scaled : maxLamports;
      }

      case 'CAPPED_PROPORTIONAL_HYBRID': {
        const targetSpentLamports = BigInt(intent.inputAmountRaw);
        const scaled = BigInt(Math.floor(Number(targetSpentLamports) * walletConfig.copyRatio));
        const chosen = scaled > fixedLamports ? scaled : fixedLamports;
        return chosen < maxLamports ? chosen : maxLamports;
      }

      default:
        return fixedLamports;
    }
  }

  /**
   * Update or create follower position on fill
   */
  public recordFill(
    targetWallet: string,
    tokenMint: string,
    side: 'BUY' | 'SELL',
    tokensTransactedRaw: bigint,
    solTransactedLamports: bigint,
    effectivePriceSol: number,
    orderSignature: string
  ): FollowerPosition {
    let position = db.getPosition(targetWallet, tokenMint);
    const now = Date.now();

    if (side === 'BUY') {
      if (!position) {
        // Open new position
        position = {
          id: randomUUID(),
          targetWallet,
          tokenMint,
          qtyRaw: tokensTransactedRaw.toString(),
          costBasisLamports: solTransactedLamports.toString(),
          avgEntryPriceSol: effectivePriceSol,
          realizedPnlLamports: '0',
          unrealizedPnlLamports: '0',
          state: 'OPEN',
          openedAt: now,
          updatedAt: now,
        };
      } else {
        // Add to existing position (weighted average price)
        const oldQty = BigInt(position.qtyRaw);
        const newQty = oldQty + tokensTransactedRaw;
        const oldCost = BigInt(position.costBasisLamports);
        const newCost = oldCost + solTransactedLamports;

        const oldTokensFloat = Number(oldQty) / 1e6;
        const newTokensFloat = Number(tokensTransactedRaw) / 1e6;
        const totalTokensFloat = Number(newQty) / 1e6;

        const weightedPrice =
          totalTokensFloat > 0
            ? (position.avgEntryPriceSol * oldTokensFloat + effectivePriceSol * newTokensFloat) /
              totalTokensFloat
            : effectivePriceSol;

        position.qtyRaw = newQty.toString();
        position.costBasisLamports = newCost.toString();
        position.avgEntryPriceSol = weightedPrice;
        position.state = 'OPEN';
        position.updatedAt = now;
      }

      db.savePosition(position);

      db.addPositionLot({
        id: randomUUID(),
        positionId: position.id,
        sourceSignature: orderSignature,
        side: 'BUY',
        qtyRaw: tokensTransactedRaw.toString(),
        costRaw: solTransactedLamports.toString(),
        price: effectivePriceSol,
        openedAt: now,
      });
    } else {
      // SELL: Proportional or full exit
      if (!position) {
        // No position found; create closed record
        position = {
          id: randomUUID(),
          targetWallet,
          tokenMint,
          qtyRaw: '0',
          costBasisLamports: '0',
          avgEntryPriceSol: effectivePriceSol,
          realizedPnlLamports: solTransactedLamports.toString(),
          unrealizedPnlLamports: '0',
          state: 'CLOSED',
          openedAt: now,
          updatedAt: now,
          closedAt: now,
        };
      } else {
        const currentQty = BigInt(position.qtyRaw);
        const sellQty = tokensTransactedRaw > currentQty ? currentQty : tokensTransactedRaw;
        const remainingQty = currentQty - sellQty;

        // Cost basis of the sold portion
        const costBasisSoldLamports =
          currentQty > 0n
            ? (BigInt(position.costBasisLamports) * sellQty) / currentQty
            : 0n;

        // Realized PnL = Sol received - Cost basis of sold tokens
        const pnlDeltaLamports = solTransactedLamports - costBasisSoldLamports;
        const currentRealizedPnl = BigInt(position.realizedPnlLamports);
        const newRealizedPnl = currentRealizedPnl + pnlDeltaLamports;

        const remainingCostBasis = BigInt(position.costBasisLamports) - costBasisSoldLamports;

        position.qtyRaw = remainingQty.toString();
        position.costBasisLamports = remainingCostBasis > 0n ? remainingCostBasis.toString() : '0';
        position.realizedPnlLamports = newRealizedPnl.toString();
        position.updatedAt = now;

        if (remainingQty === 0n) {
          position.state = 'CLOSED';
          position.closedAt = now;
        }
      }

      db.savePosition(position);

      db.addPositionLot({
        id: randomUUID(),
        positionId: position.id,
        sourceSignature: orderSignature,
        side: 'SELL',
        qtyRaw: tokensTransactedRaw.toString(),
        costRaw: solTransactedLamports.toString(),
        price: effectivePriceSol,
        openedAt: now,
      });
    }

    return position;
  }

  public getTotalOpenExposureLamports(): bigint {
    const openPositions = db.getOpenPositions();
    return openPositions.reduce(
      (acc, pos) => acc + BigInt(pos.costBasisLamports),
      0n
    );
  }
}

export const positionEngine = new PositionEngine();
