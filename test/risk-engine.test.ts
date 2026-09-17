import { describe, expect, it } from 'vitest';
import { config, solToLamportsBigInt } from '../src/config/index.js';
import { RiskEngine } from '../src/engine/risk-engine.js';
import { SwapIntent } from '../src/types/index.js';

describe('Risk Engine & Circuit Breakers', () => {
  const engine = new RiskEngine();

  const validIntent: SwapIntent = {
    targetSignature: 'sig_risk_1',
    slot: 200,
    targetWallet: 'Wallet111111111111111111111111111111111111111',
    venue: 'PUMPFUN',
    side: 'BUY',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'Mint1111111111111111111111111111111111111111',
    tokenMint: 'Mint1111111111111111111111111111111111111111',
    inputAmountRaw: '100000000',
    outputAmountRaw: '500000',
    estimatedPrice: 0.00001,
    observedAt: process.hrtime.bigint(),
    timestampMs: Date.now(),
    rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    confidence: 0.95,
  };

  it('approves standard buy when balance and exposure are sufficient', () => {
    const sufficientBal = solToLamportsBigInt(config.FIXED_BUY_SOL + config.MIN_SOL_RESERVE_SOL + 0.05);
    const res = engine.evaluateIntent(
      validIntent,
      sufficientBal,
      5_000_000n
    );
    expect(res.approved).toBe(true);
    expect(res.decision).toBe('APPROVED');
  });

  it('rejects stale signal when signal age exceeds limit', () => {
    const staleIntent: SwapIntent = {
      ...validIntent,
      timestampMs: Date.now() - 3000, // 3000ms old (> 1500ms limit)
    };

    const res = engine.evaluateIntent(staleIntent, 50_000_000n, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_STALE');
  });

  it('rejects buy when wallet balance would breach minimum fee reserve', () => {
    const res = engine.evaluateIntent(
      validIntent,
      25_000_000n, // 0.025 SOL balance (buying 0.01 SOL leaves 0.015 < 0.02 SOL reserve)
      0n
    );
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_SOL_RESERVE');
  });

  it('post-quote: rejects trade when entry gap exceeds maximum bps tolerance', () => {
    const targetPrice = 0.00001;
    // Quote is 3.5% higher = +350 bps (> 200 bps limit)
    const badQuotePrice = 0.00001035;

    const res = engine.evaluateQuote(targetPrice, badQuotePrice);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_ENTRY_GAP');
  });

  it('trips circuit breaker after consecutive errors', () => {
    for (let i = 0; i < 5; i++) {
      engine.recordError('Simulated RPC failure');
    }
    expect(engine.isTripped()).toBe(true);

    const res = engine.evaluateIntent(validIntent, 5_000_000_000n, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_CIRCUIT_BREAKER');

    // Reset breaker
    engine.resetCircuitBreaker();
    expect(engine.isTripped()).toBe(false);
  });
});
