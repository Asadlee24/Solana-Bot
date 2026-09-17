import { DexVenue, SwapIntent, TradeSide } from '../../types/index.js';
import { WSOL_MINT } from './pumpfun.js';

export const PUMPSWAP_PROGRAM_ID = 'BSfD6SHZigAfDWSzqZ5QW8ZrNxMT5Dn2hgRZDTQDoojG';

export class PumpSwapAdapter {
  public static isPumpSwapProgram(programId: string): boolean {
    return programId === PUMPSWAP_PROGRAM_ID;
  }

  public static parseSwap(
    instruction: { programId: string; accounts: string[]; data: Buffer },
    targetWallet: string,
    signature: string,
    slot: number,
    observedAt: bigint
  ): SwapIntent | null {
    if (!this.isPumpSwapProgram(instruction.programId)) return null;

    // PumpSwap AMM format: unpack amounts if present
    let inAmount = 0n;
    let outAmount = 0n;
    if (instruction.data.length >= 17) {
      inAmount = instruction.data.readBigUInt64LE(1);
      outAmount = instruction.data.readBigUInt64LE(9);
    }

    const tokenMint = instruction.accounts[2] || 'UNKNOWN_MINT';
    const isBuy = instruction.accounts[0] === WSOL_MINT || instruction.accounts[1] === WSOL_MINT;

    return {
      targetSignature: signature,
      slot,
      targetWallet,
      venue: 'PUMPSWAP',
      side: isBuy ? 'BUY' : 'SELL',
      inputMint: isBuy ? WSOL_MINT : tokenMint,
      outputMint: isBuy ? tokenMint : WSOL_MINT,
      tokenMint,
      inputAmountRaw: inAmount.toString(),
      outputAmountRaw: outAmount.toString(),
      estimatedPrice: 0,
      observedAt,
      timestampMs: Date.now(),
      rawProgramId: instruction.programId,
      confidence: 0.90,
    };
  }
}
