import { SwapIntent, DexVenue } from '../types/index.js';
import { JupiterAdapter } from './adapters/jupiter.js';
import { OrcaAdapter } from './adapters/orca.js';
import { PumpFunAdapter, WSOL_MINT } from './adapters/pumpfun.js';
import { PumpSwapAdapter } from './adapters/pumpswap.js';
import { RaydiumAdapter } from './adapters/raydium.js';
import { BalanceDeltaReconciler } from './reconciler.js';

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
  meta?: {
    err: any | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: any[];
    postTokenBalances?: any[];
  };
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
    // 1. Anti-bait check: Target wallet MUST be an active signer in this transaction.
    // If target wallet is NOT a signer, this is an airdrop, unsolicited transfer, or third-party token send.
    // Real intentional buys on Solana strictly require target wallet's signature to authorize spending capital.
    const isSigner = tx.signers.includes(targetWallet);
    const isInAccounts = tx.accountKeys.includes(targetWallet);

    if (!isSigner || !isInAccounts) {
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
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
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
      }
      if (RaydiumAdapter.isRaydiumProgram(innerIx.programId)) {
        const intent = RaydiumAdapter.parseSwap(
          innerIx,
          targetWallet,
          tx.signature,
          tx.slot,
          tx.observedAt
        );
        if (intent) return this.enrichIntent(intent, tx, targetWallet);
      }
    }

    // 5. Ultimate Fallback: Balance Delta Ground Truth Reconciliation
    // (Handles all custom bot contracts, Trojan, Photon, Bloom, GMGN, and new Pump.fun buy_exact_quote_in)
    if (tx.meta && !tx.meta.err) {
      const reconciled = BalanceDeltaReconciler.reconcile(
        tx.signature,
        tx.slot,
        targetWallet,
        {
          err: tx.meta.err,
          fee: tx.meta.fee,
          preBalances: tx.meta.preBalances,
          postBalances: tx.meta.postBalances,
          preTokenBalances: tx.meta.preTokenBalances,
          postTokenBalances: tx.meta.postTokenBalances,
          accountKeys: tx.accountKeys,
        }
      );

      if (reconciled.status === 'SUCCESS' && reconciled.tokenMint && reconciled.tokenMint !== 'UNKNOWN') {
        const isBuy = reconciled.side === 'BUY';
        const inputMint = isBuy ? WSOL_MINT : reconciled.tokenMint;
        const outputMint = isBuy ? reconciled.tokenMint : WSOL_MINT;
        const absSol = reconciled.netSolDeltaLamports < 0n ? -reconciled.netSolDeltaLamports : reconciled.netSolDeltaLamports;
        const absTok = reconciled.netTokenDeltaRaw < 0n ? -reconciled.netTokenDeltaRaw : reconciled.netTokenDeltaRaw;

        const hasPump = tx.accountKeys.some((k) => k === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        const hasRayAmm = tx.accountKeys.some((k) => k === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        const hasRayCpmm = tx.accountKeys.some((k) => k === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
        const hasJup = tx.accountKeys.some((k) => k.startsWith('JUP') || k === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
        let detectedVenue: DexVenue = 'JUPITER';
        if (hasPump) {
          detectedVenue = 'PUMPFUN';
        } else if (hasRayCpmm) {
          detectedVenue = 'RAYDIUM_CPMM';
        } else if (hasRayAmm) {
          detectedVenue = 'RAYDIUM_AMM';
        } else if (hasJup) {
          detectedVenue = 'JUPITER';
        }

        return {
          targetSignature: tx.signature,
          slot: tx.slot,
          targetWallet,
          venue: detectedVenue,
          side: reconciled.side,
          inputMint,
          outputMint,
          tokenMint: reconciled.tokenMint,
          inputAmountRaw: isBuy ? absSol.toString() : absTok.toString(),
          outputAmountRaw: isBuy ? absTok.toString() : absSol.toString(),
          estimatedPrice: reconciled.effectiveTargetPrice,
          observedAt: tx.observedAt,
          timestampMs: Date.now(),
          rawProgramId: 'BALANCE_DELTA_FALLBACK',
          confidence: 0.99,
          sellFraction: reconciled.targetSoldFraction,
        };
      }
    }

    return null;
  }

  /**
   * Enriches decoded swap intents with ground-truth pre/post token balance deltas for proportional exit
   */
  private static enrichIntent(
    intent: SwapIntent,
    tx: ParsedTransactionEnvelope,
    targetWallet: string
  ): SwapIntent {
    if (intent.side === 'SELL' && tx.meta && !tx.meta.err) {
      try {
        const reconciled = BalanceDeltaReconciler.reconcile(
          tx.signature,
          tx.slot,
          targetWallet,
          {
            err: tx.meta.err,
            fee: tx.meta.fee,
            preBalances: tx.meta.preBalances,
            postBalances: tx.meta.postBalances,
            preTokenBalances: tx.meta.preTokenBalances,
            postTokenBalances: tx.meta.postTokenBalances,
            accountKeys: tx.accountKeys,
          }
        );
        if (
          reconciled &&
          reconciled.targetSoldFraction !== undefined &&
          !isNaN(reconciled.targetSoldFraction) &&
          reconciled.targetSoldFraction > 0
        ) {
          intent.sellFraction = reconciled.targetSoldFraction;
          intent.targetPreBalanceToken = reconciled.targetPreTokenBalanceRaw.toString();
        }
      } catch {
        // Fallback safely if balance delta extraction fails
      }
    }
    return intent;
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
