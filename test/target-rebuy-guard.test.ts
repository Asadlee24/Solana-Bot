import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../src/engine/risk-engine.js';
import { FastTransactionDecoder } from '../src/parsers/fast-decoder.js';
import { SwapIntent, ParsedTransactionEnvelope } from '../src/types/index.js';

describe('Target Pre-Existing Token & Re-Buy Guard', () => {
  const targetWallet = 'TargetTrader1111111111111111111111111111111';
  const testMint = 'TokenMint1111111111111111111111111111111111';
  const WSOL = 'So11111111111111111111111111111111111111112';

  it('approves fresh target buys when target had 0 pre-existing tokens', () => {
    const riskEngine = new RiskEngine();
    const freshBuyIntent: SwapIntent = {
      targetSignature: 'sig_fresh_buy',
      slot: 300000000,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: WSOL,
      outputMint: testMint,
      tokenMint: testMint,
      inputAmountRaw: '100000000',
      outputAmountRaw: '5000000000',
      estimatedPrice: 0.00002,
      isTargetRebuy: false,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    const res = riskEngine.evaluateIntent(freshBuyIntent, 5_000_000_000n, 0n);
    expect(res.approved).toBe(true);
    expect(res.decision).toBe('APPROVED');
  });

  it('rejects target buys when target already held pre-existing tokens (isTargetRebuy = true)', () => {
    const riskEngine = new RiskEngine();
    const rebuyIntent: SwapIntent = {
      targetSignature: 'sig_rebuy_attempt',
      slot: 300000000,
      targetWallet,
      venue: 'RAYDIUM_AMM',
      side: 'BUY',
      inputMint: WSOL,
      outputMint: testMint,
      tokenMint: testMint,
      inputAmountRaw: '100000000',
      outputAmountRaw: '5000000000',
      estimatedPrice: 0.00002,
      isTargetRebuy: true,
      targetPreBalanceToken: '1500000000',
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      confidence: 1.0,
    };

    const res = riskEngine.evaluateIntent(rebuyIntent, 5_000_000_000n, 0n);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe('REJECTED_TARGET_ALREADY_HELD');
    expect(res.reason).toContain('Target trader already held pre-existing tokens');
  });

  it('always approves target SELL orders even if pre-balance existed (de-risking allowed)', () => {
    const riskEngine = new RiskEngine();
    const sellIntent: SwapIntent = {
      targetSignature: 'sig_target_sell',
      slot: 300000000,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'SELL',
      inputMint: testMint,
      outputMint: WSOL,
      tokenMint: testMint,
      inputAmountRaw: '5000000000',
      outputAmountRaw: '100000000',
      estimatedPrice: 0.00002,
      isTargetRebuy: false,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    const res = riskEngine.evaluateIntent(sellIntent, 5_000_000_000n, 0n);
    expect(res.approved).toBe(true);
    expect(res.decision).toBe('APPROVED');
  });

  it('strictly rejects 2nd and 3rd buys when target trader already bought the coin earlier (DCA prevention)', () => {
    const riskEngine = new RiskEngine();
    const tokenA = 'TokenMintA111111111111111111111111111111111';

    const buy1: SwapIntent = {
      targetSignature: 'sig_buy_1',
      slot: 300000001,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: WSOL,
      outputMint: tokenA,
      tokenMint: tokenA,
      inputAmountRaw: '100000000',
      outputAmountRaw: '5000000000',
      estimatedPrice: 0.00002,
      isTargetRebuy: false,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    // 1st buy: Fresh entry -> APPROVED
    const res1 = riskEngine.evaluateIntent(buy1, 5_000_000_000n, 0n);
    expect(res1.approved).toBe(true);
    expect(res1.decision).toBe('APPROVED');

    // System records that target trader has entered tokenA
    riskEngine.recordTargetEntry(targetWallet, tokenA, 'sig_buy_1');

    // 2nd buy attempt by target trader on same token: -> MUST BE REJECTED
    const buy2: SwapIntent = {
      ...buy1,
      targetSignature: 'sig_buy_2',
      slot: 300000005,
      timestampMs: Date.now(),
    };
    const res2 = riskEngine.evaluateIntent(buy2, 5_000_000_000n, 0n);
    expect(res2.approved).toBe(false);
    expect(res2.decision).toBe('REJECTED_TARGET_ALREADY_HELD');
    expect(res2.reason).toContain('Target trader already entered');

    // 3rd buy attempt by target trader on same token: -> MUST BE REJECTED
    const buy3: SwapIntent = {
      ...buy1,
      targetSignature: 'sig_buy_3',
      slot: 300000010,
      timestampMs: Date.now(),
    };
    const res3 = riskEngine.evaluateIntent(buy3, 5_000_000_000n, 0n);
    expect(res3.approved).toBe(false);
    expect(res3.decision).toBe('REJECTED_TARGET_ALREADY_HELD');

    // Target sells/exits tokenA: Entry is cleared
    riskEngine.clearTargetEntry(targetWallet, tokenA);

    // After selling out, a new fresh entry can be evaluated
    const freshReentry: SwapIntent = {
      ...buy1,
      targetSignature: 'sig_buy_new_cycle',
      slot: 300000100,
      timestampMs: Date.now(),
    };
    const resFresh = riskEngine.evaluateIntent(freshReentry, 5_000_000_000n, 0n);
    expect(resFresh.approved).toBe(true);
    expect(resFresh.decision).toBe('APPROVED');
  });

  it('FastTransactionDecoder accurately marks isTargetRebuy=true when target preTokenBalances > 0', () => {
    const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const bufData = Buffer.alloc(24);
    disc.copy(bufData, 0);
    bufData.writeBigUInt64LE(50_000_000_000_000n, 8);
    bufData.writeBigUInt64LE(1_500_000_000n, 16);

    const mockTx: ParsedTransactionEnvelope = {
      signature: 'sig_decoder_rebuy_test',
      slot: 300000000,
      observedAt: process.hrtime.bigint(),
      signers: [targetWallet],
      accountKeys: [targetWallet, testMint, WSOL, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      instructions: [
        {
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          accounts: ['Global', 'Fee', testMint, 'BondingCurve', 'Assoc', 'UserToken', targetWallet],
          data: bufData, // Pump.fun buy discriminator
        },
      ],
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000_000_000, 0, 0, 0],
        postBalances: [9_900_000_000, 0, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint: testMint,
            owner: targetWallet,
            uiTokenAmount: {
              amount: '50000000', // Pre-existing 50 tokens!
              decimals: 6,
              uiAmount: 50,
            },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: testMint,
            owner: targetWallet,
            uiTokenAmount: {
              amount: '150000000',
              decimals: 6,
              uiAmount: 150,
            },
          },
        ],
      },
    };

    const decoded = FastTransactionDecoder.decodeTransaction(mockTx, targetWallet);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe('BUY');
    expect(decoded?.tokenMint).toBe(testMint);
    expect(decoded?.isTargetRebuy).toBe(true);
    expect(decoded?.targetPreBalanceToken).toBe('50000000');
  });

  it('FastTransactionDecoder marks isTargetRebuy=false when target preTokenBalances is 0 (fresh entry)', () => {
    const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const bufData = Buffer.alloc(24);
    disc.copy(bufData, 0);
    bufData.writeBigUInt64LE(50_000_000_000_000n, 8);
    bufData.writeBigUInt64LE(1_500_000_000n, 16);

    const mockTx: ParsedTransactionEnvelope = {
      signature: 'sig_decoder_fresh_test',
      slot: 300000000,
      observedAt: process.hrtime.bigint(),
      signers: [targetWallet],
      accountKeys: [targetWallet, testMint, WSOL, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      instructions: [
        {
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          accounts: ['Global', 'Fee', testMint, 'BondingCurve', 'Assoc', 'UserToken', targetWallet],
          data: bufData, // Pump.fun buy discriminator
        },
      ],
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000_000_000, 0, 0, 0],
        postBalances: [9_900_000_000, 0, 0, 0],
        preTokenBalances: [], // 0 pre-existing tokens!
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: testMint,
            owner: targetWallet,
            uiTokenAmount: {
              amount: '100000000',
              decimals: 6,
              uiAmount: 100,
            },
          },
        ],
      },
    };

    const decoded = FastTransactionDecoder.decodeTransaction(mockTx, targetWallet);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe('BUY');
    expect(decoded?.tokenMint).toBe(testMint);
    expect(decoded?.isTargetRebuy).toBe(false);
  });
});
