import { DexVenue, SwapIntent, TradeSide } from '../../types/index.js';

export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// 8-byte Anchor discriminators for Pump.fun
// buy: [102, 6, 61, 18, 1, 218, 235, 234] = 0x66063d1201daebea
// sell: [51, 230, 133, 166, 197, 185, 239, 130] = 0x33e685a6c5b9ef82
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 166, 197, 185, 239, 130]);

export interface PumpFunInstructionData {
  side: TradeSide;
  tokenAmountRaw: bigint;
  solAmountRaw: bigint;
}

export class PumpFunAdapter {
  public static isPumpFunProgram(programId: string): boolean {
    return programId === PUMPFUN_PROGRAM_ID;
  }

  /**
   * Fast instruction decoder for Pump.fun buy/sell
   */
  public static decodeInstructionData(data: Buffer): PumpFunInstructionData | null {
    if (data.length < 24) return null;

    const disc = data.subarray(0, 8);
    if (disc.equals(BUY_DISCRIMINATOR)) {
      // buy(amount: u64, max_sol_cost: u64)
      const tokenAmount = data.readBigUInt64LE(8);
      const maxSolCost = data.readBigUInt64LE(16);
      return {
        side: 'BUY',
        tokenAmountRaw: tokenAmount,
        solAmountRaw: maxSolCost,
      };
    } else if (disc.equals(SELL_DISCRIMINATOR)) {
      // sell(amount: u64, min_sol_output: u64)
      const tokenAmount = data.readBigUInt64LE(8);
      const minSolOutput = data.readBigUInt64LE(16);
      return {
        side: 'SELL',
        tokenAmountRaw: tokenAmount,
        solAmountRaw: minSolOutput,
      };
    }

    return null;
  }

  /**
   * Parse a Pump.fun swap from instruction accounts and data
   * Account layout for Pump.fun buy:
   * 0: Global
   * 1: Fee recipient
   * 2: Mint
   * 3: Bonding Curve
   * 4: Associated Bonding Curve
   * 5: Associated User Token
   * 6: User (Target wallet / Signer)
   * 7: System Program
   * 8: Token Program
   * 9: Rent
   */
  public static parseSwap(
    instruction: { programId: string; accounts: string[]; data: Buffer },
    targetWallet: string,
    signature: string,
    slot: number,
    observedAt: bigint
  ): SwapIntent | null {
    if (!this.isPumpFunProgram(instruction.programId)) return null;

    const decoded = this.decodeInstructionData(instruction.data);
    if (!decoded) return null;

    const mint = instruction.accounts[2];
    if (!mint) return null;

    const isBuy = decoded.side === 'BUY';
    const inputMint = isBuy ? WSOL_MINT : mint;
    const outputMint = isBuy ? mint : WSOL_MINT;
    const inputAmountRaw = isBuy ? decoded.solAmountRaw.toString() : decoded.tokenAmountRaw.toString();
    const outputAmountRaw = isBuy ? decoded.tokenAmountRaw.toString() : decoded.solAmountRaw.toString();

    // Compute estimated price: SOL / Token
    const solAmt = Number(decoded.solAmountRaw) / 1e9;
    const tokenAmt = Number(decoded.tokenAmountRaw) / 1e6; // Pump.fun tokens use 6 decimals
    const estimatedPrice = tokenAmt > 0 ? solAmt / tokenAmt : 0;

    return {
      targetSignature: signature,
      slot,
      targetWallet,
      venue: 'PUMPFUN',
      side: decoded.side,
      inputMint,
      outputMint,
      tokenMint: mint,
      inputAmountRaw,
      outputAmountRaw,
      estimatedPrice,
      observedAt,
      timestampMs: Date.now(),
      rawProgramId: instruction.programId,
      confidence: 0.98,
    };
  }

  /**
   * Bonding Curve Spot Price: P = virtualSol / virtualTokens
   */
  public static computeBondingCurvePrice(
    virtualSolReservesLamports: bigint,
    virtualTokenReservesRaw: bigint
  ): number {
    if (virtualTokenReservesRaw === 0n) return 0;
    const sol = Number(virtualSolReservesLamports) / 1e9;
    const tokens = Number(virtualTokenReservesRaw) / 1e6;
    return tokens > 0 ? sol / tokens : 0;
  }
}
