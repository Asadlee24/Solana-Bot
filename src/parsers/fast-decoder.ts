import { SwapIntent } from '../types/index.js';
import { JupiterAdapter } from './adapters/jupiter.js';
import { OrcaAdapter } from './adapters/orca.js';
import { PumpFunAdapter } from './adapters/pumpfun.js';
import { PumpSwapAdapter } from './adapters/pumpswap.js';
import { RaydiumAdapter } from './adapters/raydium.js';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface RawInstruction {
  programId: string;
  accounts: string[];
  data: Buffer;
}

export interface ParsedTransactionEnvelope {
  signature: string;
  slot: number;
  signers: string[];
  accountKeys: string[];
  instructions: RawInstruction[];
  innerInstructions?: Array<{
    index: number;
    instructions: RawInstruction[];
  }>;
  observedAt: bigint; // Monotonic hrtime
}

export class FastTransactionDecoder {
  /**
   * Fast path decoder for candidate swap intent
   */
  public static decodeTransaction(
    tx: ParsedTransactionEnvelope,
    targetWallet: string
  ): SwapIntent | null {
    // 1. Anti-bait check: Is target wallet actually a signer/authority in this transaction?
    const isSigner = tx.signers.includes(targetWallet);
    const isInAccounts = tx.accountKeys.includes(targetWallet);

    if (!isInAccounts) {
      return null;
    }

    // 2. Filter pure SPL transfers (Anti-bait: receiving a transfer != buy; sending != sell)
    if (this.isPureTransfer(tx.instructions, targetWallet)) {
      return {
        targetSignature: tx.signature,
        slot: tx.slot,
        targetWallet,
        venue: 'UNKNOWN',
        side: 'BUY',
        inputMint: '',
        outputMint: '',
        tokenMint: '',
        inputAmountRaw: '0',
        outputAmountRaw: '0',
        estimatedPrice: 0,
        observedAt: tx.observedAt,
        timestampMs: Date.now(),
        rawProgramId: tx.instructions[0]?.programId || '',
        confidence: 0,
        isTransferNoise: true,
      };
    }

    // Collect all inner instructions flattened
    const innerList: RawInstruction[] = [];
    if (tx.innerInstructions) {
      for (const group of tx.innerInstructions) {
        innerList.push(...group.instructions);
      }
    }

    // 3. Scan top-level instructions first (Priority: Pump.fun > PumpSwap > Raydium > Jupiter > Orca)
    for (const ix of tx.instructions) {
      // Pump.fun
      if (PumpFunAdapter.isPumpFunProgram(ix.programId)) {
        const intent = PumpFunAdapter.parseSwap(
          ix,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }

      // PumpSwap
      if (PumpSwapAdapter.isPumpSwapProgram(ix.programId)) {
        const intent = PumpSwapAdapter.parseSwap(
          ix,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }

      // Raydium
      if (RaydiumAdapter.isRaydiumProgram(ix.programId)) {
        const intent = RaydiumAdapter.parseSwap(
          ix,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }

      // Jupiter
      if (JupiterAdapter.isJupiterProgram(ix.programId)) {
        const intent = JupiterAdapter.parseSwap(
          ix,
          innerList,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }

      // Orca Whirlpool
      if (OrcaAdapter.isOrcaProgram(ix.programId)) {
        const intent = OrcaAdapter.parseSwap(
          ix,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }
    }

    // 4. If not found in top-level, check inner instructions (e.g. CPI routed through bot contracts)
    for (const innerIx of innerList) {
      if (PumpFunAdapter.isPumpFunProgram(innerIx.programId)) {
        const intent = PumpFunAdapter.parseSwap(
          innerIx,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }
      if (RaydiumAdapter.isRaydiumProgram(innerIx.programId)) {
        const intent = RaydiumAdapter.parseSwap(
          innerIx,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return intent;
      }
    }

    return null;
  }

  /**
   * Identifies if instructions are merely simple SOL or token transfers
   */
  private static isPureTransfer(instructions: RawInstruction[], targetWallet: string): boolean {
    if (instructions.length === 0) return false;

    return instructions.every((ix) => {
      // System Program transfer
      if (ix.programId === SYSTEM_PROGRAM_ID) return true;
      // SPL Token transfer (tag 3) or transferChecked (tag 12)
      if (
        (ix.programId === TOKEN_PROGRAM_ID || ix.programId === TOKEN_2022_PROGRAM_ID) &&
        ix.data.length > 0
      ) {
        const tag = ix.data[0];
        if (tag === 3 || tag === 12) return true;
      }
      return false;
    });
  }
}
