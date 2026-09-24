import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  BlockhashWithExpiryBlockHeight,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config/index.js';
import {
  jupiterSwapV2Adapter,
  JupiterV2OrderResponse,
  WSOL_MINT,
} from './jupiter-swap.js';
import { transactionSubmitter } from './transaction-submitter.js';
import { blockhashService } from './blockhash-service.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pump.fun instruction discriminators (8-byte Anchor discriminators)
// global:buy = sha256("global:buy")[0..8] = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]
// global:sell = sha256("global:sell")[0..8] = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

export interface OnChainBondingCurveState {
  isInitialized: boolean;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean; // True = Graduated to PumpSwap / Raydium
  pairAsset: 'SOL' | 'USDC';
}

export interface ExecutableCurveQuote {
  inAmountRaw: bigint;
  expectedOutRaw: bigint;
  minOutRaw: bigint;
  effectivePriceSol: number;
  isGraduated: boolean;
  pairAsset: 'SOL' | 'USDC';
}

export interface PumpFunBuildResult {
  transaction: VersionedTransaction;
  latestBlockhash: BlockhashWithExpiryBlockHeight;
  outAmountRaw: string;
  effectivePriceSol: number;
  routedViaJupiter: boolean;
  jupiterOrder?: JupiterV2OrderResponse;
}

export class PumpFunSwapAdapter {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  /**
   * Derives bonding curve PDA for any token mint
   */
  public getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM_ID
    );
  }

  /**
   * Reads real on-chain bonding curve state and graduation status from Solana mainnet.
   * STRICT: Detects if token graduated or if paired with USDC.
   */
  public async getBondingCurveState(mintAddress: string): Promise<OnChainBondingCurveState> {
    const mint = new PublicKey(mintAddress);
    const [bondingCurve] = this.getBondingCurvePDA(mint);

    try {
      const accInfo = await this.connection.getAccountInfo(bondingCurve, 'confirmed');
      if (!accInfo || accInfo.data.length < 49) {
        // Curve does not exist or has migrated away
        return {
          isInitialized: false,
          virtualTokenReserves: 0n,
          virtualSolReserves: 0n,
          realTokenReserves: 0n,
          realSolReserves: 0n,
          tokenTotalSupply: 0n,
          complete: true, // Treat as graduated
          pairAsset: 'SOL',
        };
      }

      const data = accInfo.data;
      const virtualTokenReserves = data.readBigUInt64LE(8);
      const virtualSolReserves = data.readBigUInt64LE(16);
      const realTokenReserves = data.readBigUInt64LE(24);
      const realSolReserves = data.readBigUInt64LE(32);
      const tokenTotalSupply = data.readBigUInt64LE(40);
      const complete = data.readUInt8(48) === 1;

      // Check quote_mint if present (Pump.fun USDC pairs support)
      let pairAsset: 'SOL' | 'USDC' = 'SOL';
      if (data.length >= 81) {
        const quoteMintBytes = data.subarray(49, 81);
        const quoteMint = new PublicKey(quoteMintBytes);
        if (quoteMint.toBase58() === USDC_MINT) {
          pairAsset = 'USDC';
        }
      }

      return {
        isInitialized: true,
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
        pairAsset,
      };
    } catch (err: any) {
      console.warn(`[PumpFun] Failed to read bonding curve state for ${mintAddress}: ${err.message}`);
      return {
        isInitialized: false,
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 0n,
        complete: true,
        pairAsset: 'SOL',
      };
    }
  }

  /**
   * NOTE: Direct Pump bonding-curve AMM quote calculation.
   * Current official Pump.fun bonding-curve documentation states the current total bonding-curve trading fee is 1.25%
   * (0.3% creator fee + 0.95% protocol fee).
   * Direct Pump execution is DISABLED when SMOKE_TEST_FORCE_JUPITER=true.
   * This calculation must NOT be claimed as current for live execution without dynamic protocol fee retrieval.
   */
  public calculateQuote(
    state: OnChainBondingCurveState,
    side: 'BUY' | 'SELL',
    inAmountRaw: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS
  ): ExecutableCurveQuote {
    if (state.complete || !state.isInitialized) {
      return {
        inAmountRaw,
        expectedOutRaw: 0n,
        minOutRaw: 0n,
        effectivePriceSol: 0,
        isGraduated: true,
        pairAsset: state.pairAsset,
      };
    }

    const vTokens = state.virtualTokenReserves;
    const vSol = state.virtualSolReserves;

    if (vTokens <= 0n || vSol <= 0n) {
      return {
        inAmountRaw,
        expectedOutRaw: 0n,
        minOutRaw: 0n,
        effectivePriceSol: 0,
        isGraduated: true,
        pairAsset: state.pairAsset,
      };
    }

    if (side === 'BUY') {
      const netSolIn = (inAmountRaw * 9875n) / 10000n; // 1.25% bonding curve trading fee
      const expectedOutTokens = (vTokens * netSolIn) / (vSol + netSolIn);
      const minOutTokens = (expectedOutTokens * BigInt(10000 - slippageBps)) / 10000n;

      const solSpentFloat = Number(inAmountRaw) / 1e9;
      const tokensOutFloat = Number(expectedOutTokens) / 1e6;
      const effectivePriceSol = tokensOutFloat > 0 ? solSpentFloat / tokensOutFloat : 0;

      return {
        inAmountRaw,
        expectedOutRaw: expectedOutTokens,
        minOutRaw: minOutTokens > 0n ? minOutTokens : 1n,
        effectivePriceSol,
        isGraduated: false,
        pairAsset: state.pairAsset,
      };
    } else {
      const tokensIn = inAmountRaw;
      const expectedSol = (vSol * tokensIn) / (vTokens + tokensIn);
      const netSolOut = (expectedSol * 9875n) / 10000n; // 1.25% bonding curve trading fee
      const minSolOut = (netSolOut * BigInt(10000 - slippageBps)) / 10000n;

      const tokensSoldFloat = Number(tokensIn) / 1e6;
      const solOutFloat = Number(netSolOut) / 1e9;
      const effectivePriceSol = tokensSoldFloat > 0 ? solOutFloat / tokensSoldFloat : 0;

      return {
        inAmountRaw,
        expectedOutRaw: netSolOut,
        minOutRaw: minSolOut > 0n ? minSolOut : 1n,
        effectivePriceSol,
        isGraduated: false,
        pairAsset: state.pairAsset,
      };
    }
  }

  public async resolveTokenProgram(mint: PublicKey): Promise<PublicKey> {
    try {
      const info = await this.connection.getAccountInfo(mint);
      if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return TOKEN_2022_PROGRAM_ID;
      }
    } catch {}
    return TOKEN_PROGRAM_ID;
  }

  /**
   * Intelligently executes BUY:
   * - When SMOKE_TEST_FORCE_JUPITER=true (or if graduated / USDC-paired): routes via Jupiter Swap API V2.
   * - Direct bonding curve execution is disabled during the smoke test.
   */
  public async buildAndSignBuy(
    keypair: Keypair,
    mintAddress: string,
    solAmountLamports: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS,
    existingCurveState?: OnChainBondingCurveState,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<PumpFunBuildResult> {
    const curveState = existingCurveState || await this.getBondingCurveState(mintAddress);

    // If Jupiter is forced during smoke test, or token graduated, or paired with USDC, route via Jupiter Swap API V2
    if (
      (config.MAINNET_SMOKE_TEST_MODE && config.SMOKE_TEST_FORCE_JUPITER) ||
      curveState.complete ||
      !curveState.isInitialized ||
      curveState.pairAsset === 'USDC'
    ) {
      console.info(`[PumpFun Routing] Token ${mintAddress} routed buy via Jupiter Swap API V2 (forceJupiter=${config.SMOKE_TEST_FORCE_JUPITER}, complete=${curveState.complete}).`);
      const order = await jupiterSwapV2Adapter.createOrder(
        WSOL_MINT,
        mintAddress,
        solAmountLamports.toString(),
        keypair.publicKey.toBase58(),
        slippageBps
      );
      const signedResult = await jupiterSwapV2Adapter.signOrder(keypair, order);

      return {
        transaction: signedResult.transaction,
        latestBlockhash: signedResult.blockhashWithExpiry,
        outAmountRaw: signedResult.outAmountRaw,
        effectivePriceSol: signedResult.effectivePriceSol,
        routedViaJupiter: true,
        jupiterOrder: order,
      };
    }

    // Active curve: Compute exact executable quote from real on-chain reserves
    const quote = this.calculateQuote(curveState, 'BUY', solAmountLamports, slippageBps);

    const mint = new PublicKey(mintAddress);
    const user = keypair.publicKey;
    const [bondingCurve] = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgramId);
    const userAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgramId);

    // Max SOL cost with slippage
    const maxSolCostLamports = (solAmountLamports * BigInt(10000 + slippageBps)) / 10000n;

    // Encode Buy Instruction Data
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(quote.expectedOutRaw, 8);
    data.writeBigUInt64LE(maxSolCostLamports, 16);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const buyIx = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys,
      data,
    });

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }),
      createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint, tokenProgramId),
      buyIx,
    ];

    if (config.HELIUS_SENDER_TIP_LAMPORTS > 0) {
      instructions.push(
        transactionSubmitter.createTipInstruction(user, BigInt(config.HELIUS_SENDER_TIP_LAMPORTS))
      );
    }

    const latestBlockhash = await blockhashService.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([keypair]);

    return {
      transaction,
      latestBlockhash,
      outAmountRaw: quote.expectedOutRaw.toString(),
      effectivePriceSol: quote.effectivePriceSol,
      routedViaJupiter: false,
    };
  }

  /**
   * Intelligently executes SELL:
   * - If bonding curve is active: builds direct verified on-chain curve transaction.
   * - If graduated: routes through Jupiter Swap API V2 / PumpSwap.
   */
  public async buildAndSignSell(
    keypair: Keypair,
    mintAddress: string,
    tokenAmountRaw: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS,
    existingCurveState?: OnChainBondingCurveState,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<PumpFunBuildResult> {
    const curveState = existingCurveState || await this.getBondingCurveState(mintAddress);

    if (
      (config.MAINNET_SMOKE_TEST_MODE && config.SMOKE_TEST_FORCE_JUPITER) ||
      curveState.complete ||
      !curveState.isInitialized ||
      curveState.pairAsset === 'USDC'
    ) {
      console.info(`[PumpFun Routing] Token ${mintAddress} routed sell via Jupiter Swap API V2 (forceJupiter=${config.SMOKE_TEST_FORCE_JUPITER}, complete=${curveState.complete}).`);
      const order = await jupiterSwapV2Adapter.createOrder(
        mintAddress,
        WSOL_MINT,
        tokenAmountRaw.toString(),
        keypair.publicKey.toBase58(),
        slippageBps
      );
      const signedResult = await jupiterSwapV2Adapter.signOrder(keypair, order);

      return {
        transaction: signedResult.transaction,
        latestBlockhash: signedResult.blockhashWithExpiry,
        outAmountRaw: signedResult.outAmountRaw,
        effectivePriceSol: signedResult.effectivePriceSol,
        routedViaJupiter: true,
        jupiterOrder: order,
      };
    }

    // Active curve quote
    const quote = this.calculateQuote(curveState, 'SELL', tokenAmountRaw, slippageBps);

    const mint = new PublicKey(mintAddress);
    const user = keypair.publicKey;
    const [bondingCurve] = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgramId);
    const userAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgramId);

    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmountRaw, 8);
    data.writeBigUInt64LE(quote.minOutRaw, 16);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const sellIx = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys,
      data,
    });

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }),
      sellIx,
    ];

    if (config.HELIUS_SENDER_TIP_LAMPORTS > 0) {
      instructions.push(
        transactionSubmitter.createTipInstruction(user, BigInt(config.HELIUS_SENDER_TIP_LAMPORTS))
      );
    }

    const latestBlockhash = await blockhashService.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([keypair]);

    return {
      transaction,
      latestBlockhash,
      outAmountRaw: quote.expectedOutRaw.toString(),
      effectivePriceSol: quote.effectivePriceSol,
      routedViaJupiter: false,
    };
  }
}

export const pumpFunSwapAdapter = new PumpFunSwapAdapter();
