import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  BlockhashWithExpiryBlockHeight,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config/index.js';
import { blockhashService } from './blockhash-service.js';
import {
  OnChainBondingCurveState,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_RECIPIENT,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  pumpFunSwapAdapter,
} from './pump-fun-swap.js';
import { transactionSubmitter } from './transaction-submitter.js';

const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

export interface FastBuyBuildResult {
  transaction: VersionedTransaction;
  signature: string;
  latestBlockhash: BlockhashWithExpiryBlockHeight;
  outAmountRaw: string;
  effectivePriceSol: number;
  expectedOutRaw: bigint;
  maxSolCostLamports: bigint;
  tokenProgramId: PublicKey;
}

export class FastPumpBuilder {
  private static instance: FastPumpBuilder;

  // Memoized PDA and ATA caches to eliminate redundant crypto hashing on the hot path
  private pdaCache: Map<string, { bondingCurve: PublicKey; associatedBondingCurve: PublicKey }> = new Map();
  private userAtaCache: Map<string, PublicKey> = new Map();

  public static getInstance(): FastPumpBuilder {
    if (!FastPumpBuilder.instance) {
      FastPumpBuilder.instance = new FastPumpBuilder();
    }
    return FastPumpBuilder.instance;
  }

  /**
   * Fast in-memory build & synchronous sign for direct Pump.fun BUY
   */
  public async buildFastBuy(
    keypair: Keypair,
    mintAddress: string,
    solAmountLamports: bigint,
    curveState: OnChainBondingCurveState,
    slippageBps: number = config.MAX_SLIPPAGE_BPS,
    tokenProgramOverride?: PublicKey
  ): Promise<FastBuyBuildResult> {
    const mint = new PublicKey(mintAddress);
    const user = keypair.publicKey;

    // 1. Dynamic Token Program detection
    const tokenProgramId =
      tokenProgramOverride ||
      (curveState.pairAsset === 'USDC' ? TOKEN_PROGRAM_ID : TOKEN_PROGRAM_ID);

    // 2. Compute exact executable quote with verified slippage bounds
    const quote = pumpFunSwapAdapter.calculateQuote(
      curveState,
      'BUY',
      solAmountLamports,
      slippageBps
    );

    // 3. Resolve accounts with PDA memoization
    let pdaEntry = this.pdaCache.get(mintAddress);
    if (!pdaEntry) {
      const [bondingCurve] = pumpFunSwapAdapter.getBondingCurvePDA(mint);
      const associatedBondingCurve = getAssociatedTokenAddressSync(
        mint,
        bondingCurve,
        true,
        tokenProgramId
      );
      pdaEntry = { bondingCurve, associatedBondingCurve };
      this.pdaCache.set(mintAddress, pdaEntry);
    }

    const userAtaKey = `${user.toBase58()}:${mintAddress}`;
    let userAta = this.userAtaCache.get(userAtaKey);
    if (!userAta) {
      userAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgramId);
      this.userAtaCache.set(userAtaKey, userAta);
    }

    // 4. Max SOL cost bound with slippage
    const maxSolCostLamports =
      (solAmountLamports * BigInt(10000 + slippageBps)) / 10000n;

    // 5. Construct Buy Instruction Data (8-byte discriminator + 8-byte amount + 8-byte max_sol_cost)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(quote.expectedOutRaw, 8);
    data.writeBigUInt64LE(maxSolCostLamports, 16);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: pdaEntry.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: pdaEntry.associatedBondingCurve, isSigner: false, isWritable: true },
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

    // 6. Assemble instructions
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

    // 7. Instant cached blockhash
    const latestBlockhash = await blockhashService.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([keypair]);

    // Extract signature from signed transaction
    const signature = bs58Encode(tx.signatures[0]);

    return {
      transaction: tx,
      signature,
      latestBlockhash,
      outAmountRaw: quote.expectedOutRaw.toString(),
      effectivePriceSol: quote.effectivePriceSol,
      expectedOutRaw: quote.expectedOutRaw,
      maxSolCostLamports,
      tokenProgramId,
    };
  }
}

import bs58Module from 'bs58';
const bs58Encode = (
  typeof (bs58Module as any).encode === 'function'
    ? (bs58Module as any).encode
    : (bs58Module as any).default?.encode
) as (input: Uint8Array) => string;

export const fastPumpBuilder = FastPumpBuilder.getInstance();
