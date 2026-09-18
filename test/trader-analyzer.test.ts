import { describe, expect, it } from 'vitest';
import { TraderAnalyzerService } from '../src/services/trader-analyzer.js';

describe('TraderAnalyzerService Unit Tests', () => {
  const analyzer = new TraderAnalyzerService();

  it('correctly flags an airdrop/spam script with 0 DEX swaps', async () => {
    // Simulated transactions of an airdrop script (pure SPL transfers, no DEX swap events)
    const mockSpamTxs = [
      {
        signature: 'spam_tx_1',
        type: 'TRANSFER',
        source: 'TOKEN_PROGRAM',
        timestamp: 1700000000,
        tokenTransfers: [
          { mint: 'SpamTokenMint', tokenAmount: 1000, fromUserAccount: 'SpammerWallet', toUserAccount: 'Victim1' },
        ],
        nativeTransfers: [],
      },
      {
        signature: 'spam_tx_2',
        type: 'TRANSFER',
        source: 'TOKEN_PROGRAM',
        timestamp: 1700000005,
        tokenTransfers: [
          { mint: 'SpamTokenMint', tokenAmount: 1000, fromUserAccount: 'SpammerWallet', toUserAccount: 'Victim2' },
        ],
        nativeTransfers: [],
      },
    ];

    // Call private evaluateTransactions via any cast
    const result = await (analyzer as any).evaluateTransactions('SpammerWallet', mockSpamTxs);

    expect(result.totalTransactionsScanned).toBe(2);
    expect(result.totalSwaps).toBe(0);
    expect(result.verdict).toBe('SPAM_BOT');
    expect(result.verdictBadge).toContain('SPAM BOT');
    expect(result.recommendation).toContain('DO NOT COPY');
  });

  it('correctly detects a hyper-sniper / instant dumper with < 30s holding time', async () => {
    const sniperWallet = 'SniperWallet123';
    const mockSniperTxs = [
      // Buy token X at t=100 for 1 SOL
      {
        signature: 'buy_tx',
        type: 'SWAP',
        source: 'PUMP_FUN',
        timestamp: 1700000100,
        tokenTransfers: [
          { mint: 'PumpToken1', tokenAmount: 10000, fromUserAccount: 'BondingCurve', toUserAccount: sniperWallet },
        ],
        nativeTransfers: [
          { fromUserAccount: sniperWallet, toUserAccount: 'BondingCurve', amount: 1_000_000_000 },
        ],
      },
      // Sell token X at t=105 (5 seconds later) for 0.95 SOL
      {
        signature: 'sell_tx',
        type: 'SWAP',
        source: 'PUMP_FUN',
        timestamp: 1700000105,
        tokenTransfers: [
          { mint: 'PumpToken1', tokenAmount: 10000, fromUserAccount: sniperWallet, toUserAccount: 'BondingCurve' },
        ],
        nativeTransfers: [
          { fromUserAccount: 'BondingCurve', toUserAccount: sniperWallet, amount: 950_000_000 },
        ],
      },
    ];

    const result = await (analyzer as any).evaluateTransactions(sniperWallet, mockSniperTxs);

    expect(result.totalSwaps).toBe(2);
    expect(result.completedRounds).toBe(1);
    expect(result.avgHoldSeconds).toBe(5);
    expect(result.verdict).toBe('HIGH_RISK_SNIPER');
    expect(result.tradingStyle).toContain('Hyper Sniper');
    expect(result.recommendation).toContain('CAUTION');
  });

  it('correctly calculates high win-rate swing trader performance', async () => {
    const swingTrader = 'SwingTrader123';
    const mockSwingTxs = [
      // Round 1: Win on TokenA (Hold 15 mins, Profit +1.5 SOL)
      {
        signature: 'buy_a',
        type: 'SWAP',
        source: 'RAYDIUM',
        timestamp: 1700000000,
        tokenTransfers: [{ mint: 'TokenA', tokenAmount: 5000, fromUserAccount: 'Pool', toUserAccount: swingTrader }],
        nativeTransfers: [{ fromUserAccount: swingTrader, toUserAccount: 'Pool', amount: 1_000_000_000 }], // 1 SOL spent
      },
      {
        signature: 'sell_a',
        type: 'SWAP',
        source: 'RAYDIUM',
        timestamp: 1700000900, // 900s = 15m
        tokenTransfers: [{ mint: 'TokenA', tokenAmount: 5000, fromUserAccount: swingTrader, toUserAccount: 'Pool' }],
        nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: swingTrader, amount: 2_500_000_000 }], // 2.5 SOL received (+1.5 SOL profit)
      },
      // Round 2: Win on TokenB (Hold 20 mins, Profit +0.8 SOL)
      {
        signature: 'buy_b',
        type: 'SWAP',
        source: 'RAYDIUM',
        timestamp: 1700001000,
        tokenTransfers: [{ mint: 'TokenB', tokenAmount: 2000, fromUserAccount: 'Pool', toUserAccount: swingTrader }],
        nativeTransfers: [{ fromUserAccount: swingTrader, toUserAccount: 'Pool', amount: 1_000_000_000 }],
      },
      {
        signature: 'sell_b',
        type: 'SWAP',
        source: 'RAYDIUM',
        timestamp: 1700002200, // 1200s = 20m
        tokenTransfers: [{ mint: 'TokenB', tokenAmount: 2000, fromUserAccount: swingTrader, toUserAccount: 'Pool' }],
        nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: swingTrader, amount: 1_800_000_000 }],
      },
    ];

    const result = await (analyzer as any).evaluateTransactions(swingTrader, mockSwingTxs);

    expect(result.completedRounds).toBe(2);
    expect(result.profitableRounds).toBe(2);
    expect(result.losingRounds).toBe(0);
    expect(result.winRatePct).toBe(100);
    expect(result.netPnlSol).toBeCloseTo(2.3, 1);
    expect(result.avgHoldSeconds).toBeGreaterThan(600);
    expect(result.tradingStyle).toContain('Swing Trader');
    expect(result.verdict).toBe('SAFE_TO_COPY');
    expect(result.verdictBadge).toContain('SAFE TO COPY');
  });
});
