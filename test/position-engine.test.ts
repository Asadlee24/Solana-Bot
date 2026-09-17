import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/database.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { SwapIntent, WatchedWallet } from '../src/types/index.js';

describe('Position Engine & Proportional Exit Logic', () => {
  const runId = randomUUID().substring(0, 8);
  const targetWallet = `TargetWallet_${runId}`;
  const testMint = `TokenMint_${runId}`;

  const walletConfig: WatchedWallet = {
    wallet: targetWallet,
    label: 'Test Target',
    enabled: true,
    buyMode: 'FIXED_SIZE',
    fixedBuyLamports: '100000000', // 0.1 SOL
    copyRatio: 0.05,
    maxBuyLamports: '1000000000',
    createdAt: Date.now(),
  };

  it('calculates fixed buy sizing correctly', () => {
    const buyIntent: SwapIntent = {
      targetSignature: 'sig_buy_1',
      slot: 100,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: testMint,
      tokenMint: testMint,
      inputAmountRaw: '5000000000', // Target spent 5 SOL
      outputAmountRaw: '1000000000',
      estimatedPrice: 0.000005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 0.98,
    };

    const mirror = positionEngine.prepareMirrorIntent(buyIntent, walletConfig, 'APPROVED');
    expect(mirror.requestedInAmountRaw).toBe('100000000'); // 0.1 SOL
    expect(mirror.side).toBe('BUY');
  });

  it('records buy fill and tracks position cost basis', () => {
    // Follower bought 20,000 tokens for 0.1 SOL (100_000_000 lamports)
    const pos = positionEngine.recordFill(
      targetWallet,
      testMint,
      'BUY',
      20_000_000_000n, // 20,000 tokens with 6 decimals
      100_000_000n,
      0.000005,
      'order_fill_sig_1'
    );

    expect(pos.state).toBe('OPEN');
    expect(pos.qtyRaw).toBe('20000000000');
    expect(pos.costBasisLamports).toBe('100000000');
  });

  it('proportional sell: 25% target exit results in exactly 25% follower exit', () => {
    // Target owned 1,000,000 tokens and sold 250,000 (25% exit)
    const sellIntent: SwapIntent = {
      targetSignature: 'sig_sell_1',
      slot: 105,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'SELL',
      inputMint: testMint,
      outputMint: 'So11111111111111111111111111111111111111112',
      tokenMint: testMint,
      inputAmountRaw: '250000000000', // 250,000 tokens
      outputAmountRaw: '1250000000',
      targetPreBalanceToken: '1000000000000', // 1,000,000 tokens pre-balance
      estimatedPrice: 0.000005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 0.98,
    };

    const mirror = positionEngine.prepareMirrorIntent(sellIntent, walletConfig, 'APPROVED');
    expect(mirror.side).toBe('SELL');
    expect(mirror.sellFraction).toBeCloseTo(0.25, 2);

    // Follower owned 20,000 tokens -> 25% of 20,000 is 5,000 tokens
    expect(mirror.requestedInAmountRaw).toBe('5000000000');
  });

  it('records partial sell fill and computes realized PnL', () => {
    // Sell 5,000 tokens for 0.03 SOL (profit vs 0.025 cost basis)
    const pos = positionEngine.recordFill(
      targetWallet,
      testMint,
      'SELL',
      5_000_000_000n,
      30_000_000n,
      0.000006,
      'order_fill_sig_2'
    );

    // Remaining: 15,000 tokens
    expect(pos.qtyRaw).toBe('15000000000');
    // Realized PnL: 30_000_000 - 25_000_000 = +5_000_000 lamports
    expect(pos.realizedPnlLamports).toBe('5000000');
    expect(pos.state).toBe('OPEN');
  });

  it('100% full exit marks position as CLOSED', () => {
    // Sell remaining 15,000 tokens
    const pos = positionEngine.recordFill(
      targetWallet,
      testMint,
      'SELL',
      15_000_000_000n,
      90_000_000n,
      0.000006,
      'order_fill_sig_3'
    );

    expect(pos.qtyRaw).toBe('0');
    expect(pos.state).toBe('CLOSED');
  });
});
