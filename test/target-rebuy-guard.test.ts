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
