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

  it('strictly rejects second buy for a token that was previously bought (Never-Rebuy Lifetime Guard)', () => {
    const uniqueToken = 'NeverRebuyMint1111111111111111111111111111';
    const buyIntent: SwapIntent = {
      ...validIntent,
      tokenMint: uniqueToken,
      outputMint: uniqueToken,
      timestampMs: Date.now(),
    };

    const bal = solToLamportsBigInt(1.0);

    // Initial check: First time buy is approved
    const firstCheck = engine.evaluateIntent(buyIntent, bal, 0n);
    expect(firstCheck.approved).toBe(true);
    expect(firstCheck.decision).toBe('APPROVED');

    // Simulate trade landing: recordBuy is called
    engine.recordBuy(uniqueToken);

    // Expire the cooldown timer by advancing simulated time / manual delete from cooldown map
    (engine as any).lastBuyTimestampByMint.delete(uniqueToken);
    expect(engine.getTokenCooldownRemainingSec(uniqueToken)).toBe(0);

    // Second buy attempt must be rejected by NEVER_REBUY rule even though 5m cooldown has expired!
    const secondCheck = engine.evaluateIntent(buyIntent, bal, 0n);
    expect(secondCheck.approved).toBe(false);
    expect(secondCheck.decision).toBe('REJECTED_NEVER_REBUY');
    expect(secondCheck.reason).toContain('Never-Rebuy');
  });

  it('Anti-FOMO Entry Ceiling Guard: rejects buy if target entry price is > first-seen price by more than tolerance', () => {
    const fomoToken = 'FomoToken1111111111111111111111111111111';
    const bal = solToLamportsBigInt(1.0);

    // 1. Target first enters at 0.00001 SOL
    const initialIntent: SwapIntent = {
      ...validIntent,
      tokenMint: fomoToken,
      outputMint: fomoToken,
      estimatedPrice: 0.00001,
      timestampMs: Date.now(),
    };

    const firstRes = engine.evaluateIntent(initialIntent, bal, 0n);
    expect(firstRes.approved).toBe(true);
    expect(engine.getFirstSeenPrice(fomoToken)).toBe(0.00001);

    // 2. Target buys again at 0.00005 SOL (5x pump / +40000 bps > 200 bps tolerance)
    const fomoIntent: SwapIntent = {
      ...validIntent,
      tokenMint: fomoToken,
      outputMint: fomoToken,
      estimatedPrice: 0.00005,
      timestampMs: Date.now(),
    };

    const fomoRes = engine.evaluateIntent(fomoIntent, bal, 0n);
    expect(fomoRes.approved).toBe(false);
    expect(fomoRes.decision).toBe('REJECTED_ENTRY_GAP');
    expect(fomoRes.reason).toContain('Anti-FOMO Guard ACTIVE');
    // Token should also be locked lifetime
    expect(engine.isTokenPermanentlyLocked(fomoToken)).toBe(true);
  });

  it('permanently locks token if previous mirror order failed due to entry gap', () => {
    const gapFailedToken = 'GapFailedMint1111111111111111111111111111';
    const bal = solToLamportsBigInt(1.0);

    // Save a failed mirror order with entry gap error in DB
    db.saveMirrorOrder({
      orderId: 'ord_gap_fail_test',
      intentId: 'intent_gap_fail_test',
      targetSignature: 'sig_target_fail_1',
      mode: 'LIVE',
      tokenMint: gapFailedToken,
      side: 'BUY',
      inAmountRaw: '10000000',
      outAmountRaw: '500000',
      minOutAmountRaw: '490000',
      effectivePrice: 0.00002,
      quotedAt: process.hrtime.bigint(),
      priorityFeeLamports: 50000n,
      tipLamports: 100000n,
      routeFeeLamports: 0n,
      status: 'FAILED',
      errorMessage: 'Entry price gap (+372.6 bps) exceeds tolerance (200 bps)',
    });

    // Token must be permanently locked
    expect(engine.isTokenPermanentlyLocked(gapFailedToken)).toBe(true);

    // Any new buy attempt for this token must be rejected by Lifetime Never-Rebuy
    const buyAttempt: SwapIntent = {
      ...validIntent,
      tokenMint: gapFailedToken,
      outputMint: gapFailedToken,
      timestampMs: Date.now(),
    };
    const res = engine.evaluateIntent(buyAttempt, bal, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_NEVER_REBUY');
  });

  it('evaluateQuote compares against first-seen baseline price when tokenMint is provided', () => {
    const baselineToken = 'BaselineToken111111111111111111111111111';
    engine.setFirstSeenPrice(baselineToken, 0.00001);

    // Target re-entry at 0.00005, quote at 0.000051 (+2% vs target, but +410% vs first-seen baseline!)
    const res = engine.evaluateQuote(0.00005, 0.000051, baselineToken);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_ENTRY_GAP');
    expect(res.reason).toContain('vs baseline');
  });
});
