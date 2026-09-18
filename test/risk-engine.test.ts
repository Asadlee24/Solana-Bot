import { describe, expect, it } from 'vitest';
import { config, solToLamportsBigInt } from '../src/config/index.js';
import { db } from '../src/db/database.js';
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

  it('rejects duplicate buy when order is already in-flight (Fast-Finger Guard)', () => {
    const uniqueMint = 'InFlightToken11111111111111111111111111111';
    const testIntent: SwapIntent = {
      ...validIntent,
      tokenMint: uniqueMint,
      outputMint: uniqueMint,
      timestampMs: Date.now(),
    };

    const bal = solToLamportsBigInt(1.0);
    // Before in-flight: approved
    expect(engine.evaluateIntent(testIntent, bal, 0n).approved).toBe(true);

    // Mark as in-flight
    engine.markInFlight(uniqueMint);
    const inFlightRes = engine.evaluateIntent(testIntent, bal, 0n);
    expect(inFlightRes.approved).toBe(false);
    expect(inFlightRes.decision).toBe('REJECTED_IN_FLIGHT');

    // Clear in-flight
    engine.clearInFlightBuy(uniqueMint);
    expect(engine.evaluateIntent(testIntent, bal, 0n).approved).toBe(true);
  });

  it('rejects duplicate buy when open position already exists (Single Entry Guard)', () => {
    const existingMint = 'OpenPosToken111111111111111111111111111111';
    const testIntent: SwapIntent = {
      ...validIntent,
      tokenMint: existingMint,
      outputMint: existingMint,
      timestampMs: Date.now(),
    };

    // Simulate open position in DB
    db.savePosition({
      id: 'test_pos_guard_1',
      targetWallet: validIntent.targetWallet,
      tokenMint: existingMint,
      qtyRaw: '1000000',
      costBasisLamports: '10000000',
      avgEntryPriceSol: 0.0001,
      realizedPnlLamports: '0',
      unrealizedPnlLamports: '0',
      state: 'OPEN',
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const bal = solToLamportsBigInt(1.0);
    const res = engine.evaluateIntent(testIntent, bal, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_DUPLICATE_POSITION');
    expect(res.reason).toContain('Single Entry Guard');

    // Sells for this token must ALWAYS be approved even when position is open
    const sellIntent: SwapIntent = {
      ...testIntent,
      side: 'SELL',
      inputMint: existingMint,
      outputMint: 'So11111111111111111111111111111111111111112',
    };
    const sellRes = engine.evaluateIntent(sellIntent, bal, 0n);
    expect(sellRes.approved).toBe(true);
    expect(sellRes.decision).toBe('APPROVED');
  });

  it('rejects buy when token is in cooldown window and allows re-entry after clearing', () => {
    const cooldownMint = 'CooldownToken11111111111111111111111111111';
    const testIntent: SwapIntent = {
      ...validIntent,
      tokenMint: cooldownMint,
      outputMint: cooldownMint,
      timestampMs: Date.now(),
    };

    const bal = solToLamportsBigInt(1.0);

    // Record buy -> triggers cooldown
    engine.recordBuy(cooldownMint);

    const res = engine.evaluateIntent(testIntent, bal, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_COOLDOWN');
    expect(engine.getTokenCooldownRemainingSec(cooldownMint)).toBeGreaterThan(0);

    // Clear cooldown -> allows buy
    engine.clearCooldown(cooldownMint);
    expect(engine.getTokenCooldownRemainingSec(cooldownMint)).toBe(0);
    const retestRes = engine.evaluateIntent(testIntent, bal, 0n);
    expect(retestRes.approved).toBe(true);
    expect(retestRes.decision).toBe('APPROVED');
  });
});
