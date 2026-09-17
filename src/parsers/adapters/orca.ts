import { SwapIntent } from '../../types/index.js';
import { WSOL_MINT } from './pumpfun.js';

export const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Orca Whirlpool swap discriminator: [248, 198, 158, 145, 225, 117, 135, 200]
export class OrcaAdapter {
  public static isOrcaProgram(programId: string): boolean {
    return programId === ORCA_WHIRLPOOL_PROGRAM_ID;
  }

  public static parseSwap(
    instruction: { programId: string; accounts: string[]; data: Buffer },
    targetWallet: string,
    signature: string,
    slot: number,
    observedAt: bigint
  ): SwapIntent | null {
    if (!this.isOrcaProgram(instruction.programId)) return null;

    let amount = 0n;
    let otherThreshold = 0n;
    let aToB = true;

    if (instruction.data.length >= 25) {
      amount = instruction.data.readBigUInt64LE(8);
      otherThreshold = instruction.data.readBigUInt64LE(16);
      aToB = instruction.data[24] === 1;
    }

    // Whirlpool accounts: [tokenProgram, tokenAuthority, whirlpool, tokenOwnerAccountA, tokenVaultA, tokenOwnerAccountB, tokenVaultB, ...]
    const tokenA = instruction.accounts[3] || 'TOKEN_A';
    const tokenB = instruction.accounts[5] || 'TOKEN_B';

    const inputMint = aToB ? tokenA : tokenB;
    const outputMint = aToB ? tokenB : tokenA;
    const isBuy = inputMint === WSOL_MINT;
    const tokenMint = isBuy ? outputMint : inputMint;

    return {
      targetSignature: signature,
      slot,
      targetWallet,
      venue: 'ORCA_WHIRLPOOL',
      side: isBuy ? 'BUY' : 'SELL',
      inputMint,
      outputMint,
      tokenMint,
      inputAmountRaw: amount.toString(),
      outputAmountRaw: otherThreshold.toString(),
      estimatedPrice: 0,
      observedAt,
      timestampMs: Date.now(),
      rawProgramId: instruction.programId,
      confidence: 0.88,
    };
  }
}
