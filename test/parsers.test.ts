import { describe, expect, it } from 'vitest';
import { JupiterAdapter } from '../src/parsers/adapters/jupiter.js';
import { PumpFunAdapter, PUMPFUN_PROGRAM_ID, WSOL_MINT } from '../src/parsers/adapters/pumpfun.js';
import { RaydiumAdapter, RAYDIUM_AMM_V4 } from '../src/parsers/adapters/raydium.js';
import { FastTransactionDecoder, ParsedTransactionEnvelope, TOKEN_PROGRAM_ID } from '../src/parsers/fast-decoder.js';

describe('DEX Adapters & Fast Parser', () => {
  const targetWallet = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
  const testMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  it('correctly decodes Pump.fun Buy instruction and calculates bonding curve price', () => {
    // Buy instruction data: 8 bytes discriminator + u64 amount + u64 max_sol_cost
    const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    // 50,000,000 tokens (50_000_000 * 10^6)
    data.writeBigUInt64LE(50_000_000_000_000n, 8);
    // 1.5 SOL max cost (1_500_000_000 lamports)
    data.writeBigUInt64LE(1_500_000_000n, 16);

    const decoded = PumpFunAdapter.decodeInstructionData(data);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe('BUY');
    expect(decoded?.tokenAmountRaw).toBe(50_000_000_000_000n);
    expect(decoded?.solAmountRaw).toBe(1_500_000_000n);

    // Test bonding curve spot price formula: P = virtualSol / virtualTokens
    const price = PumpFunAdapter.computeBondingCurvePrice(30_000_000_000n, 1_073_000_000_000_000n);
    expect(price).toBeGreaterThan(0);
  });

  it('correctly decodes Pump.fun Sell instruction', () => {
    const disc = Buffer.from([51, 230, 133, 166, 197, 185, 239, 130]);
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    // Sell 10,000,000 tokens
    data.writeBigUInt64LE(10_000_000_000_000n, 8);
    // Min 0.3 SOL output
    data.writeBigUInt64LE(300_000_000n, 16);

    const decoded = PumpFunAdapter.decodeInstructionData(data);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe('SELL');
    expect(decoded?.tokenAmountRaw).toBe(10_000_000_000_000n);
    expect(decoded?.solAmountRaw).toBe(300_000_000n);
  });

  it('correctly decodes Raydium AMM swap instruction', () => {
    const data = Buffer.alloc(17);
    data[0] = 9; // swapBaseIn
    data.writeBigUInt64LE(1_000_000_000n, 1); // 1 SOL in
    data.writeBigUInt64LE(5_000_000_000n, 9); // min out

    const accounts = [
      'TokenProgram1111111111111111111111111111111',
      'AmmPool111111111111111111111111111111111111',
      WSOL_MINT,
      testMint,
    ];

    const intent = RaydiumAdapter.parseSwap(
      { programId: RAYDIUM_AMM_V4, accounts, data },
      targetWallet,
      'test_sig_raydium',
      123456,
      process.hrtime.bigint()
    );

    expect(intent).not.toBeNull();
    expect(intent?.venue).toBe('RAYDIUM_AMM');
    expect(intent?.side).toBe('BUY');
    expect(intent?.inputAmountRaw).toBe('1000000000');
  });

  it('anti-bait: filters out plain token transfers and does not classify as a buy/sell', () => {
    const transferData = Buffer.alloc(9);
    transferData[0] = 3; // SPL Token Transfer tag
    transferData.writeBigUInt64LE(1_000_000n, 1);

    const envelope: ParsedTransactionEnvelope = {
      signature: 'transfer_sig_123',
      slot: 12345,
      signers: [targetWallet],
      accountKeys: [targetWallet, 'SomeDestTokenAccount', TOKEN_PROGRAM_ID],
      instructions: [
        {
          programId: TOKEN_PROGRAM_ID,
          accounts: ['Source', 'SomeDestTokenAccount', targetWallet],
          data: transferData,
        },
      ],
      observedAt: process.hrtime.bigint(),
    };

    const intent = FastTransactionDecoder.decodeTransaction(envelope, targetWallet);
    expect(intent?.isTransferNoise).toBe(true);
  });
});
