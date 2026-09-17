import { describe, expect, it } from 'vitest';
import { paperEngine } from '../src/execution/paper-engine.js';
import { MirrorIntent, SwapIntent } from '../src/types/index.js';

describe('Paper Execution Engine', () => {
  const targetWallet = 'TargetWalletPaper11111111111111111111111111';
  const testMint = 'TokenMintPaper1111111111111111111111111111';

  it('executes realistic paper buy order with simulated slippage and fees', async () => {
    const targetIntent: SwapIntent = {
      targetSignature: 'sig_paper_test_1',
      slot: 300,
      targetWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: testMint,
      tokenMint: testMint,
      inputAmountRaw: '1000000000',
      outputAmountRaw: '100000000',
      estimatedPrice: 0.00001,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 0.98,
    };

    const mirrorIntent: MirrorIntent = {
      id: 'intent_paper_1',
      targetSignature: targetIntent.targetSignature,
      targetWallet,
      side: 'BUY',
      tokenMint: testMint,
      inputMint: targetIntent.inputMint,
      outputMint: testMint,
      requestedInAmountRaw: '100000000', // 0.1 SOL
      expectedOutAmountRaw: '0',
      riskDecision: 'APPROVED',
      createdAt: process.hrtime.bigint(),
    };

    const order = await paperEngine.executePaperTrade(targetIntent, mirrorIntent, {
      simulatedLeaderDelayMs: 150,
      priceImpactBps: 30, // 30 bps price impact
    });

    expect(order.status).toBe('FILLED');
    expect(order.mode).toBe('PAPER');
    expect(order.orderSignature).toBeDefined();
    expect(order.effectivePrice).toBeGreaterThan(targetIntent.estimatedPrice); // Price moved adversely
    expect(BigInt(order.outAmountRaw)).toBeGreaterThan(0n);
    expect(BigInt(order.minOutAmountRaw)).toBeLessThan(BigInt(order.outAmountRaw));
    expect(order.landedAt).toBeDefined();
    expect(order.landedAt! > order.submittedAt!).toBe(true);
  });
});
