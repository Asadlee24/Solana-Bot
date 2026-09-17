import { SwapIntent, TradeSide } from '../../types/index.js';
import { WSOL_MINT } from './pumpfun.js';

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74bHT3TL5vTSQZMxj6EDom';
export const JUPITER_DCA_PROGRAM_ID = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23';

export class JupiterAdapter {
  public static isJupiterProgram(programId: string): boolean {
    return programId === JUPITER_V6_PROGRAM_ID || programId === JUPITER_DCA_PROGRAM_ID;
  }

  /**
   * Jupiter Aggregator route instructions often wrap lower-level swaps.
   * We parse the top-level route and extract the net economic in/out mints.
   */
  public static parseSwap(
    instruction: { programId: string; accounts: string[]; data: Buffer },
    innerInstructions: Array<{ programId: string; accounts: string[]; data: Buffer }>,
    targetWallet: string,
    signature: string,
    slot: number,
    observedAt: bigint
  ): SwapIntent | null {
    if (!this.isJupiterProgram(instruction.programId)) return null;

    // Jupiter route instruction discriminator is 8 bytes:
    // route: [229, 23, 203, 151, 122, 227, 169, 10]
    // sharedAccountsRoute: [193, 32, 155, 51, 65, 214, 156, 129]
    // exactOutRoute: [208, 51, 237, 19, 43, 239, 137, 15]

    let inAmount = 0n;
    let outAmount = 0n;
    if (instruction.data.length >= 24) {
      inAmount = instruction.data.readBigUInt64LE(8);
      outAmount = instruction.data.readBigUInt64LE(16);
    }

    // Jupiter accounts layout:
    // account[1] is token authority (target wallet)
    // account[2] is userSourceTokenAccount
    // account[3] is userDestinationTokenAccount
    // account[4] is destinationTokenMint
    // account[5] is sourceTokenMint (or vice-versa depending on exact route variant)

    const candidateMints = instruction.accounts.slice(2, 8);
    const hasWsol = candidateMints.includes(WSOL_MINT);
    const otherMint = candidateMints.find((a) => a !== WSOL_MINT) || 'UNKNOWN_MINT';

    const isBuy = instruction.accounts[2] === WSOL_MINT || hasWsol;
    const side: TradeSide = isBuy ? 'BUY' : 'SELL';
    const inputMint = isBuy ? WSOL_MINT : otherMint;
    const outputMint = isBuy ? otherMint : WSOL_MINT;

    return {
      targetSignature: signature,
      slot,
      targetWallet,
      venue: 'JUPITER',
      side,
      inputMint,
      outputMint,
      tokenMint: otherMint,
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
