import { DexVenue, SwapIntent } from '../../types/index.js';
import { WSOL_MINT } from './pumpfun.js';

export const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export class RaydiumAdapter {
  public static isRaydiumProgram(programId: string): boolean {
    return (
      programId === RAYDIUM_AMM_V4 ||
      programId === RAYDIUM_CPMM ||
      programId === RAYDIUM_CLMM
    );
  }

  public static getVenue(programId: string): DexVenue {
    if (programId === RAYDIUM_CPMM) return 'RAYDIUM_CPMM';
    if (programId === RAYDIUM_CLMM) return 'RAYDIUM_CLMM';
    return 'RAYDIUM_AMM';
  }

  /**
   * Parse Raydium swap instruction
   * AMM v4 Swap: instruction discriminator byte 9
   * Accounts typical layout for AMM v4:
   * [tokenProgram, amm, ammAuthority, ammOpenOrders, ammTargetOrders, poolCoinTokenAccount, poolPcTokenAccount, ...]
   */
  public static parseSwap(
    instruction: { programId: string; accounts: string[]; data: Buffer },
    targetWallet: string,
    signature: string,
    slot: number,
    observedAt: bigint
  ): SwapIntent | null {
    if (!this.isRaydiumProgram(instruction.programId)) return null;

    const venue = this.getVenue(instruction.programId);
    let amountIn = 0n;
    let minOut = 0n;

    if (venue === 'RAYDIUM_AMM' && instruction.data.length >= 17) {
      // Byte 0 is instruction tag (9 = swapBaseIn, 11 = swapBaseOut)
      const tag = instruction.data[0];
      if (tag === 9 || tag === 11) {
        amountIn = instruction.data.readBigUInt64LE(1);
        minOut = instruction.data.readBigUInt64LE(9);
      }
    }

    // Determine candidate token accounts or mints from accounts
    const tokenMint = instruction.accounts[instruction.accounts.length - 1] || 'UNKNOWN_MINT';
    const isBuy = instruction.accounts.some((a) => a === WSOL_MINT);

    const inputMint = isBuy ? WSOL_MINT : tokenMint;
    const outputMint = isBuy ? tokenMint : WSOL_MINT;

    return {
      targetSignature: signature,
      slot,
      targetWallet,
      venue,
      side: isBuy ? 'BUY' : 'SELL',
      inputMint,
      outputMint,
      tokenMint,
      inputAmountRaw: amountIn.toString(),
      outputAmountRaw: minOut.toString(),
      estimatedPrice: 0,
      observedAt,
      timestampMs: Date.now(),
      rawProgramId: instruction.programId,
      confidence: 0.85,
    };
  }
}
