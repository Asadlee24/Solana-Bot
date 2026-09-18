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
  public async analyzeWallet(address: string, maxLimit = 40): Promise<TraderAnalysisResult> {
    const trimmed = address.trim();
    new PublicKey(trimmed); // Validate format

    let txs: any[] = [];
    if (config.HELIUS_API_KEY) {
      try {
        const url = `https://api.helius.xyz/v0/addresses/${trimmed}/transactions?api-key=${config.HELIUS_API_KEY}&limit=${maxLimit}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
   * Fallback using standard Solana RPC parsed transactions
   */
  private async fetchViaRpc(address: string, limit: number): Promise<any[]> {
    try {
      const pubkey = new PublicKey(address);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit }, 'confirmed');
      if (!sigs || sigs.length === 0) return [];

      const parsedList: any[] = [];
      for (const s of sigs) {
        if (s.err) continue; // Skip failed txs
        try {
          const parsed = await this.connection.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (!parsed) continue;

          // Normalize to Helius-like structure
          const preTokens = parsed.meta?.preTokenBalances || [];
          const postTokens = parsed.meta?.postTokenBalances || [];
          const tokenTransfers: any[] = [];

          // Compare token deltas
          for (const post of postTokens) {
            const pre = preTokens.find((p) => p.accountIndex === post.accountIndex);
            const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
            const postAmt = BigInt(post?.uiTokenAmount?.amount || '0');
            const delta = postAmt - preAmt;
            if (delta !== 0n && post.mint) {
              tokenTransfers.push({
                mint: post.mint,
                tokenAmount: Number(delta < 0n ? -delta : delta) / 10 ** (post.uiTokenAmount.decimals || 6),
                fromUserAccount: delta < 0n ? address : 'other',
                toUserAccount: delta > 0n ? address : 'other',
              });
            }
          }

          // Native SOL delta
          const accountKeys = parsed.transaction.message.accountKeys.map((k: any) =>
            typeof k === 'string' ? k : k.pubkey.toBase58()
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
            signature: s.signature,
            timestamp: parsed.blockTime || Math.floor(Date.now() / 1000),
            type: tokenTransfers.length > 0 ? 'SWAP' : 'UNKNOWN',
            source: 'RPC_PARSED',
            tokenTransfers,
            nativeTransfers,
          });
        } catch {
          // Skip on individual transaction failure
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
      const isKnownSwap =
        tx.type === 'SWAP' ||
        tx.source === 'PUMP_FUN' ||
        tx.source === 'RAYDIUM' ||
        tx.source === 'JUPITER' ||
        tx.source === 'ORCA';

      // Net SOL spent or received in this transaction
      let solDeltaLamports = 0;
      for (const n of nativeTransfers) {
        if (n.fromUserAccount === address) solDeltaLamports += n.amount; // Spent
        if (n.toUserAccount === address) solDeltaLamports -= n.amount; // Received
      }

      // A real DEX swap requires either a recognized swap venue/type OR counter-balancing SOL flow
      // Pure SPL transfers (airdrops/spam distribution) have 0 SOL exchange and are filtered
      const hasMeaningfulSolFlow = Math.abs(solDeltaLamports) > 50_000;
      const isRealSwap = isKnownSwap || (hasMeaningfulSolFlow && tokenTransfers.length > 0);

      if (!isRealSwap) {
        continue;
      }

      totalSwaps++;

      for (const t of tokenTransfers) {
        // Skip wrapped SOL mint
        if (t.mint === 'So11111111111111111111111111111111111111112') continue;
        const mint = t.mint;
        if (!mint) continue;

        if (!tradesByMint.has(mint)) {
          tradesByMint.set(mint, []);
        }

        const solAmtApprox = Math.abs(solDeltaLamports) / 1e9;

        if (t.toUserAccount === address) {
          // Trader received tokens = BUY
          tradesByMint.get(mint)!.push({
            side: 'BUY',
            solSpent: solAmtApprox,
            timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
          });
        } else if (t.fromUserAccount === address) {
          // Trader transferred out tokens = SELL
          tradesByMint.get(mint)!.push({
            side: 'SELL',
            solSpent: solAmtApprox,
            timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
          });
        }
      }
    }

    const recentTrades: CompletedTradeRound[] = [];
    let completedRounds = 0;
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

    // Classification of trading style
    let tradingStyle = 'Unknown';
    if (totalSwaps === 0) {
      tradingStyle = 'Non-Trading / Distribution Script';
    } else if (avgHoldSeconds > 0 && avgHoldSeconds < 30) {
      tradingStyle = '⚡ Hyper Sniper / Instant Dumper (<30s exits)';
    } else if (avgHoldSeconds >= 30 && avgHoldSeconds < 300) {
      tradingStyle = '🏎️ Fast Scalper (<5m holding)';
    } else if (avgHoldSeconds >= 300 && avgHoldSeconds < 3600) {
      tradingStyle = '🎯 Swing Trader (5m - 60m holding)';
    } else if (avgHoldSeconds >= 3600) {
      tradingStyle = '💎 Gem Holder / Investor (>1h holding)';
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
      verdictTitle = 'SCAM / SPAM BOT DETECTED';
      verdictBadge = '🚨 SCAM / SPAM BOT (0 DEX Swaps)';
      recommendation = 'DO NOT COPY! Wallet is an automated transfer/airdrop spam script. Zero real DEX swaps found.';
    } else if (avgHoldSeconds > 0 && avgHoldSeconds < 30) {
      verdict = 'HIGH_RISK_SNIPER';
      verdictTitle = 'HIGH RISK SNIPER / DUMPER';
      verdictBadge = '⚠️ HIGH RISK SNIPER (Dumps in seconds)';
      recommendation = `CAUTION! This trader dumps positions within ${avgHoldTimeFormatted}. If copied, network latency may cause you to exit at a loss.`;
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
