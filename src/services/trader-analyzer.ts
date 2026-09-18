import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { tokenMetadataService } from './token-metadata.js';

export interface CompletedTradeRound {
  mint: string;
  holdSeconds: number;
  pnlSol: number;
  isWin: boolean;
}

export interface TraderAnalysisResult {
  wallet: string;
  totalTransactionsScanned: number;
  totalSwaps: number;
  completedRounds: number;
  openHolds: number;
  openInvestedSol: number;
  profitableRounds: number;
  losingRounds: number;
  winRatePct: number;
  netPnlSol: number;
  netPnlUsd: number;
  avgHoldSeconds: number;
  avgHoldTimeFormatted: string;
  tradingStyle: string;
  verdict: 'SAFE_TO_COPY' | 'HIGH_RISK_SNIPER' | 'UNPROFITABLE' | 'SPAM_BOT' | 'INACTIVE';
  verdictTitle: string;
  verdictBadge: string;
  recommendation: string;
  recentTrades: CompletedTradeRound[];
}

export class TraderAnalyzerService {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  }

  /**
   * Comprehensive On-Chain Trader Analysis
   * Scans last 40-50 transactions to calculate real Win Rate, PnL & Hold Time
   */
  public async analyzeWallet(address: string, maxLimit = 25): Promise<TraderAnalysisResult> {
    const trimmed = address.trim();
    new PublicKey(trimmed); // Validate format

    let txs: any[] = [];
    if (config.HELIUS_API_KEY) {
      try {
        const url = `https://api.helius.xyz/v0/addresses/${trimmed}/transactions?api-key=${config.HELIUS_API_KEY}&limit=${maxLimit}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (Array.isArray(data)) {
            txs = data;
          }
        }
      } catch (err: any) {
        console.warn(`[Trader Analyzer] Helius API fetch failed: ${err.message}. Using RPC fallback.`);
      }
    }

    // RPC Fallback if Helius returned no data
    if (txs.length === 0) {
      txs = await this.fetchViaRpc(trimmed, Math.min(maxLimit, 20));
    }

    return this.evaluateTransactions(trimmed, txs);
  }

  /**
   * Fallback using standard Solana RPC parsed transactions (batched)
   */
  private async fetchViaRpc(address: string, limit: number): Promise<any[]> {
    try {
      const pubkey = new PublicKey(address);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit }, 'confirmed');
      if (!sigs || sigs.length === 0) return [];

      const validSigs = sigs.filter((s) => !s.err).map((s) => s.signature);
      if (validSigs.length === 0) return [];

      // Modern Solana DEX swaps use version 1 (or 0)
      const parsedTransactions = await this.connection.getParsedTransactions(validSigs, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });

      const parsedList: any[] = [];
      for (let i = 0; i < parsedTransactions.length; i++) {
        const parsed = parsedTransactions[i];
        if (!parsed) continue;

        try {
          const sig = validSigs[i];
          const preTokens = parsed.meta?.preTokenBalances || [];
          const postTokens = parsed.meta?.postTokenBalances || [];
          const tokenTransfers: any[] = [];

          for (const post of postTokens) {
            const pre = preTokens.find((p) => p.accountIndex === post.accountIndex);
            const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
            const postAmt = BigInt(post?.uiTokenAmount?.amount || '0');
            const delta = postAmt - preAmt;
            if (delta !== 0n && post.mint) {
              const decimals = post.uiTokenAmount.decimals ?? 6;
              const isUserAccount = post.owner === address;
              tokenTransfers.push({
                mint: post.mint,
                tokenAmount: Number(delta < 0n ? -delta : delta) / 10 ** decimals,
                fromUserAccount: delta < 0n && isUserAccount ? address : 'other',
                toUserAccount: delta > 0n && isUserAccount ? address : 'other',
              });
            }
          }

          const accountKeys = parsed.transaction.message.accountKeys.map((k: any) =>
            typeof k === 'string' ? k : k.pubkey?.toBase58() || k.toBase58?.() || String(k)
          );
          const targetIdx = accountKeys.indexOf(address);
          const nativeTransfers: any[] = [];
          if (targetIdx !== -1 && parsed.meta) {
            const preSol = BigInt(parsed.meta.preBalances[targetIdx] || 0);
            const postSol = BigInt(parsed.meta.postBalances[targetIdx] || 0);
            const deltaSol = postSol - preSol;
            if (deltaSol !== 0n) {
              nativeTransfers.push({
                fromUserAccount: deltaSol < 0n ? address : 'other',
                toUserAccount: deltaSol > 0n ? address : 'other',
                amount: Number(deltaSol < 0n ? -deltaSol : deltaSol),
              });
            }
          }

          parsedList.push({
            signature: sig,
            timestamp: parsed.blockTime || Math.floor(Date.now() / 1000),
            type: tokenTransfers.length > 0 ? 'SWAP' : 'UNKNOWN',
            source: 'RPC_PARSED',
            tokenTransfers,
            nativeTransfers,
          });
        } catch {
          // Skip individual failed parse
        }
      }
      return parsedList;
    } catch (err: any) {
      console.warn(`[Trader Analyzer] RPC fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Compute Win Rate %, PnL, Hold Times and Safety Score from transaction list
   */
  private async evaluateTransactions(address: string, txs: any[]): Promise<TraderAnalysisResult> {
    const totalTransactionsScanned = txs.length;
    let totalSwaps = 0;
    const tradesByMint = new Map<string, Array<{ side: 'BUY' | 'SELL'; solSpent: number; timestamp: number }>>();

    for (const tx of txs) {
      const tokenTransfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];

      // 1. Calculate net SOL flow for the target address in this transaction
      let solSpentLamports = 0;
      let solReceivedLamports = 0;

      for (const n of nativeTransfers) {
        if (n.fromUserAccount === address) solSpentLamports += Number(n.amount || 0);
        if (n.toUserAccount === address) solReceivedLamports += Number(n.amount || 0);
      }

      // Check accountData for native balance changes if available
      const targetAcc = (tx.accountData || []).find((a: any) => a.account === address);
      if (targetAcc && targetAcc.nativeBalanceChange) {
        const chg = Number(targetAcc.nativeBalanceChange);
        if (chg < 0) {
          solSpentLamports = Math.max(solSpentLamports, -chg);
        } else if (chg > 0) {
          solReceivedLamports = Math.max(solReceivedLamports, chg);
        }
      }

      // 2. Identify token transfers specifically involving target address
      const buys: Array<{ mint: string; amount?: number }> = [];
      const sells: Array<{ mint: string; amount?: number }> = [];

      for (const t of tokenTransfers) {
        if (!t.mint || t.mint === 'So11111111111111111111111111111111111111112') continue;
        if (t.toUserAccount === address) {
          buys.push({ mint: t.mint, amount: t.tokenAmount });
        } else if (t.fromUserAccount === address) {
          sells.push({ mint: t.mint, amount: t.tokenAmount });
        }
      }

      // Check accountData tokenBalanceChanges for target address
      if (targetAcc && Array.isArray(targetAcc.tokenBalanceChanges)) {
        for (const chg of targetAcc.tokenBalanceChanges) {
          if (!chg.mint || chg.mint === 'So11111111111111111111111111111111111111112') continue;
          const rawAmt = BigInt(chg.rawTokenAmount?.tokenAmount || '0');
          const decimals = chg.rawTokenAmount?.decimals ?? 6;
          if (rawAmt > 0n && !buys.some((b) => b.mint === chg.mint)) {
            buys.push({ mint: chg.mint, amount: Number(rawAmt) / 10 ** decimals });
          } else if (rawAmt < 0n && !sells.some((s) => s.mint === chg.mint)) {
            sells.push({ mint: chg.mint, amount: Number(-rawAmt) / 10 ** decimals });
          }
        }
      }

      // A real DEX swap requires either a recognized swap venue or counter-balancing SOL exchange
      const isKnownSwap =
        tx.type === 'SWAP' ||
        tx.source === 'PUMP_FUN' ||
        tx.source === 'RAYDIUM' ||
        tx.source === 'JUPITER' ||
        tx.source === 'ORCA';
      const hasMeaningfulSolFlow = (solSpentLamports + solReceivedLamports) > 50_000;
      const isSwapTx = isKnownSwap || hasMeaningfulSolFlow;

      // A real swap FOR THIS WALLET requires actual token buy or sell activity within a DEX swap
      const hasTokenTrade = buys.length > 0 || sells.length > 0;
      if (!isSwapTx || !hasTokenTrade) {
        // Not a trade for this wallet (e.g. passive bundling account, token airdrop, or spam transfer)
        continue;
      }

      totalSwaps++;

      const timestamp = tx.timestamp || Math.floor(Date.now() / 1000);
      const approxSol = Math.abs(solSpentLamports - solReceivedLamports) / 1e9;

      for (const b of buys) {
        if (!tradesByMint.has(b.mint)) tradesByMint.set(b.mint, []);
        tradesByMint.get(b.mint)!.push({
          side: 'BUY',
          solSpent: approxSol > 0 ? approxSol : 0.05,
          timestamp,
        });
      }

      for (const s of sells) {
        if (!tradesByMint.has(s.mint)) tradesByMint.set(s.mint, []);
        tradesByMint.get(s.mint)!.push({
          side: 'SELL',
          solSpent: approxSol > 0 ? approxSol : 0.05,
          timestamp,
        });
      }
    }

    const recentTrades: CompletedTradeRound[] = [];
    let completedRounds = 0;
    let openHolds = 0;
    let openInvestedSol = 0;
    let profitableRounds = 0;
    let losingRounds = 0;
    let totalHoldSeconds = 0;
    let netPnlSol = 0;

    for (const [mint, records] of tradesByMint.entries()) {
      const buys = records.filter((r) => r.side === 'BUY');
      const sells = records.filter((r) => r.side === 'SELL');

      if (buys.length > 0 && sells.length > 0) {
        completedRounds++;
        const buyCost = buys.reduce((acc, b) => acc + b.solSpent, 0);
        const sellRevenue = sells.reduce((acc, s) => acc + s.solSpent, 0);
        const pnlSol = sellRevenue - buyCost;
        netPnlSol += pnlSol;

        const earliestBuy = Math.min(...buys.map((b) => b.timestamp));
        const latestSell = Math.max(...sells.map((s) => s.timestamp));
        const holdSec = Math.max(1, latestSell - earliestBuy);
        totalHoldSeconds += holdSec;

        const isWin = pnlSol > 0;
        if (isWin) {
          profitableRounds++;
        } else {
          losingRounds++;
        }

        recentTrades.push({
          mint,
          holdSeconds: holdSec,
          pnlSol,
          isWin,
        });
      } else if (buys.length > 0 && sells.length === 0) {
        openHolds++;
        const buyCost = buys.reduce((acc, b) => acc + b.solSpent, 0);
        openInvestedSol += buyCost;
      }
    }

    const winRatePct = completedRounds > 0 ? (profitableRounds / completedRounds) * 100 : 0;
    const avgHoldSeconds = completedRounds > 0 ? Math.round(totalHoldSeconds / completedRounds) : 0;

    // Format hold time string
    let avgHoldTimeFormatted = 'N/A';
    if (avgHoldSeconds > 0) {
      if (avgHoldSeconds < 60) {
        avgHoldTimeFormatted = `${avgHoldSeconds} seconds`;
      } else if (avgHoldSeconds < 3600) {
        avgHoldTimeFormatted = `${Math.round(avgHoldSeconds / 60)} minutes`;
      } else {
        avgHoldTimeFormatted = `${(avgHoldSeconds / 3600).toFixed(1)} hours`;
      }
    }

    // Classification of trading style (no < or > characters for safe HTML rendering)
    let tradingStyle = 'Unknown';
    if (totalSwaps === 0) {
      tradingStyle = 'Non-Trading / Bundler Script';
    } else if (avgHoldSeconds > 0 && avgHoldSeconds < 30) {
      tradingStyle = '⚡ Hyper Sniper (under 30s exits)';
    } else if (avgHoldSeconds >= 30 && avgHoldSeconds < 300) {
      tradingStyle = '🏎️ Fast Scalper (under 5m holding)';
    } else if (avgHoldSeconds >= 300 && avgHoldSeconds < 3600) {
      tradingStyle = '🎯 Swing Trader (5m - 60m holding)';
    } else if (avgHoldSeconds >= 3600) {
      tradingStyle = '💎 Gem Holder (over 1h holding)';
    } else if (openHolds > 0 && completedRounds === 0) {
      tradingStyle = '🛒 Token Accumulator (Holding positions)';
    } else {
      tradingStyle = 'DEX Trader';
    }

    // Real-time SOL USD conversion
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const netPnlUsd = netPnlSol * solPriceUsd;

    // Formulate Verdict and Actionable Recommendation
    let verdict: TraderAnalysisResult['verdict'] = 'INACTIVE';
    let verdictTitle = 'INSUFFICIENT DATA';
    let verdictBadge = '⚪ INSUFFICIENT DATA';
    let recommendation = 'Not enough completed trades in recent blocks to determine score.';

    if (totalTransactionsScanned === 0) {
      verdict = 'INACTIVE';
      verdictTitle = 'INACTIVE WALLET';
      verdictBadge = '⚪ INACTIVE WALLET (0 Transactions)';
      recommendation = 'Wallet has no recent transactions on-chain.';
    } else if (totalSwaps === 0) {
      verdict = 'SPAM_BOT';
      verdictTitle = 'NO DEX SWAPS DETECTED';
      verdictBadge = '🚨 NO DEX SWAPS DETECTED (SPAM BOT / PASSIVE)';
      recommendation = 'DO NOT COPY! Wallet does not execute DEX swaps. It only appears in bundling/spam transactions without trading.';
    } else if (completedRounds === 0 && openHolds > 0) {
      verdict = 'SAFE_TO_COPY';
      verdictTitle = 'ACTIVE BUYER (HOLDING TOKENS)';
      verdictBadge = '🟡 ACTIVE BUYER (Holding Tokens)';
      recommendation = `Trader bought ${openHolds} token(s) (${openInvestedSol.toFixed(2)} SOL deployed) with no sales yet in this window. Monitor in paper mode.`;
    } else if (avgHoldSeconds > 0 && avgHoldSeconds < 30) {
      verdict = 'HIGH_RISK_SNIPER';
      verdictTitle = 'HIGH RISK SNIPER / DUMPER';
      verdictBadge = '⚠️ HIGH RISK SNIPER (Dumps in seconds)';
      recommendation = `CAUTION! This trader dumps positions within ${avgHoldTimeFormatted}. Network latency may cause you to exit at a loss.`;
    } else if (winRatePct >= 60 && avgHoldSeconds >= 300) {
      verdict = 'SAFE_TO_COPY';
      verdictTitle = 'HIGH QUALITY TRADER — SAFE TO COPY';
      verdictBadge = '🌟 HIGH QUALITY TRADER — SAFE TO COPY';
      recommendation = `EXCELLENT! Win rate of ${winRatePct.toFixed(0)}% with a healthy ${avgHoldTimeFormatted} holding time. Ideal candidate for copy-trading!`;
    } else if (winRatePct >= 50 && netPnlSol >= 0) {
      verdict = 'SAFE_TO_COPY';
      verdictTitle = 'PROFITABLE TRADER — MODERATE RISK';
      verdictBadge = '🟢 PROFITABLE TRADER (Acceptable)';
      recommendation = `Good performance (${winRatePct.toFixed(0)}% win rate, +${netPnlSol.toFixed(2)} SOL). Recommended with standard sizing.`;
    } else if (completedRounds > 0 && winRatePct < 50) {
      verdict = 'UNPROFITABLE';
      verdictTitle = 'UNPROFITABLE TRADER — NOT RECOMMENDED';
      verdictBadge = '❌ UNPROFITABLE TRADER (Losing)';
      recommendation = `AVOID! Trader has a low win rate (${winRatePct.toFixed(0)}%) with ${netPnlSol.toFixed(2)} SOL net PnL. Copying this wallet is likely to lose money.`;
    } else {
      verdict = 'SAFE_TO_COPY';
      verdictTitle = 'ACTIVE TRADER';
      verdictBadge = '🟡 ACTIVE TRADER';
      recommendation = 'Active on-chain swaps detected. Monitor initial trades in paper mode before live execution.';
    }

    return {
      wallet: address,
      totalTransactionsScanned,
      totalSwaps,
      completedRounds,
      openHolds,
      openInvestedSol,
      profitableRounds,
      losingRounds,
      winRatePct,
      netPnlSol,
      netPnlUsd,
      avgHoldSeconds,
      avgHoldTimeFormatted,
      tradingStyle,
      verdict,
      verdictTitle,
      verdictBadge,
      recommendation,
      recentTrades,
    };
  }
}

export const traderAnalyzerService = new TraderAnalyzerService();
