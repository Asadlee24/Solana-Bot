import { DexVenue, ReconciledTrade, TradeSide } from '../types/index.js';

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
  };
}

export interface TransactionMetaInput {
  err: any | null;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalanceEntry[];
  postTokenBalances?: TokenBalanceEntry[];
  accountKeys: string[];
}

export class BalanceDeltaReconciler {
  /**
   * Reconcile on-chain execution truth for target wallet balance deltas
   */
  public static reconcile(
    signature: string,
    slot: number,
    targetWallet: string,
    meta: TransactionMetaInput,
    venue: DexVenue = 'UNKNOWN'
  ): ReconciledTrade {
    const reconciledAt = process.hrtime.bigint();

    // Check if on-chain transaction failed
    if (meta.err) {
      return {
        signature,
        slot,
        targetWallet,
        venue,
        side: 'BUY',
        tokenMint: 'UNKNOWN',
        netSolDeltaLamports: 0n,
        netTokenDeltaRaw: 0n,
        effectiveTargetPrice: 0,
        targetPreTokenBalanceRaw: 0n,
        targetPostTokenBalanceRaw: 0n,
        reconciledAt,
        status: 'FAILED',
      };
    }

    // 1. Reconcile SOL balance delta for target wallet
    const targetIdx = meta.accountKeys.findIndex((key) => key === targetWallet);
    let netSolDelta = 0n;

    if (targetIdx !== -1 && meta.preBalances[targetIdx] !== undefined && meta.postBalances[targetIdx] !== undefined) {
      const preSol = BigInt(meta.preBalances[targetIdx]);
      const postSol = BigInt(meta.postBalances[targetIdx]);
      netSolDelta = postSol - preSol;
      // If target was fee payer, adjust for transaction fee
      if (targetIdx === 0 && meta.fee) {
        // net change excluding the network fee
        netSolDelta = netSolDelta + BigInt(meta.fee);
      }
    }

    // 2. Reconcile Token balance deltas for target wallet
    const preTokens = meta.preTokenBalances || [];
    const postTokens = meta.postTokenBalances || [];

    // Filter token accounts belonging to target wallet
    const preTargetMap = new Map<string, bigint>();
    for (const b of preTokens) {
      if (b.owner === targetWallet || meta.accountKeys[b.accountIndex] === targetWallet) {
        preTargetMap.set(b.mint, BigInt(b.uiTokenAmount.amount || '0'));
      }
    }

    const postTargetMap = new Map<string, bigint>();
    for (const b of postTokens) {
      if (b.owner === targetWallet || meta.accountKeys[b.accountIndex] === targetWallet) {
        postTargetMap.set(b.mint, BigInt(b.uiTokenAmount.amount || '0'));
      }
    }

    // Find the token mint that had a significant non-zero balance change
    let primaryMint = 'UNKNOWN';
    let maxDelta = 0n;
    let preBal = 0n;
    let postBal = 0n;

    // Check all touched mints
    const allMints = new Set([...preTargetMap.keys(), ...postTargetMap.keys()]);
    for (const mint of allMints) {
      const pre = preTargetMap.get(mint) || 0n;
      const post = postTargetMap.get(mint) || 0n;
      const delta = post - pre;
      const absDelta = delta < 0n ? -delta : delta;
      if (absDelta > maxDelta) {
        maxDelta = absDelta;
        primaryMint = mint;
        preBal = pre;
        postBal = post;
      }
    }

    const netTokenDelta = postBal - preBal;

    // 3. Determine Side and Effective Price
    const isBuy = netTokenDelta > 0n || netSolDelta < 0n;
    const side: TradeSide = isBuy ? 'BUY' : 'SELL';

    let effectivePrice = 0;
    const absSol = netSolDelta < 0n ? -netSolDelta : netSolDelta;
    const absTokens = netTokenDelta < 0n ? -netTokenDelta : netTokenDelta;

    if (absTokens > 0n) {
      const solFloat = Number(absSol) / 1e9;
      const tokFloat = Number(absTokens) / 1e6; // Default to 6 decimals
      effectivePrice = tokFloat > 0 ? solFloat / tokFloat : 0;
    }

    // 4. Compute targetSoldFraction: f_sell = min(1, S_t / B_t)
    let targetSoldFraction: number | undefined = undefined;
    if (side === 'SELL' && preBal > 0n) {
      const soldTokens = preBal - postBal;
      const fraction = Number(soldTokens) / Number(preBal);
      targetSoldFraction = Math.min(1, Math.max(0, fraction));
    } else if (side === 'SELL' && preBal === 0n) {
      targetSoldFraction = 1.0;
    }

    return {
      signature,
      slot,
      targetWallet,
      venue,
      side,
      tokenMint: primaryMint,
      netSolDeltaLamports: netSolDelta,
      netTokenDeltaRaw: netTokenDelta,
      effectiveTargetPrice: effectivePrice,
      targetPreTokenBalanceRaw: preBal,
      targetPostTokenBalanceRaw: postBal,
      targetSoldFraction,
      reconciledAt,
      status: 'SUCCESS',
    };
  }
}
