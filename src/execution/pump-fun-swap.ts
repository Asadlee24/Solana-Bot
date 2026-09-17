import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
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

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

// Pump.fun instruction discriminators (8-byte Anchor discriminators)
const BUY_DISCRIMINATOR = Buffer.from([0x69, 0x07, 0x9a, 0xe6, 0xb5, 0xe0, 0x24, 0xeb]);
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

export interface PumpFunBuildResult {
  transaction: VersionedTransaction;
  latestBlockhash: BlockhashWithExpiryBlockHeight;
  estimatedTokensRaw: string;
  maxSolCostLamports: bigint;
}

export class PumpFunSwapAdapter {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  /**
   * Derives bonding curve and associated bonding curve account
   */
  public getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM_ID
    );
  }

  /**
   * Builds and signs a direct Pump.fun BUY transaction
   */
  public async buildAndSignBuy(
    keypair: Keypair,
    mintAddress: string,
    solAmountLamports: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS,
    estimatedPriceSol: number = 0.00003
  ): Promise<PumpFunBuildResult> {
    const mint = new PublicKey(mintAddress);
    const user = keypair.publicKey;

    const [bondingCurve] = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    const userAta = getAssociatedTokenAddressSync(mint, user, false);

    // Estimate token amount from price
    const solSpent = Number(solAmountLamports) / 1e9;
    const tokensOutFloat = estimatedPriceSol > 0 ? solSpent / estimatedPriceSol : 100_000;
    const estimatedTokensRaw = BigInt(Math.floor(tokensOutFloat * 1e6));

    // Calculate maximum SOL cost with slippage
    const maxSolCostLamports = (solAmountLamports * BigInt(10000 + slippageBps)) / 10000n;

    // Encode Buy Instruction Data: discriminator (8) + amount (8) + max_sol_cost (8)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(estimatedTokensRaw, 8);
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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }),
      createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint),
      buyIx,
    ];

    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

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
      estimatedTokensRaw: estimatedTokensRaw.toString(),
      maxSolCostLamports,
    };
  }

  /**
   * Builds and signs a direct Pump.fun SELL transaction
   */
  public async buildAndSignSell(
    keypair: Keypair,
    mintAddress: string,
    tokenAmountRaw: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS,
    estimatedPriceSol: number = 0.00003
  ): Promise<PumpFunBuildResult> {
    const mint = new PublicKey(mintAddress);
    const user = keypair.publicKey;

    const [bondingCurve] = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
    const userAta = getAssociatedTokenAddressSync(mint, user, false);

    // Calculate minimum SOL output with slippage
    const tokensSoldFloat = Number(tokenAmountRaw) / 1e6;
    const expectedSolOutput = BigInt(Math.floor(tokensSoldFloat * estimatedPriceSol * 1e9));
    const minSolOutputLamports = (expectedSolOutput * BigInt(10000 - slippageBps)) / 10000n;

    // Encode Sell Instruction Data: discriminator (8) + amount (8) + min_sol_output (8)
    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmountRaw, 8);
    data.writeBigUInt64LE(minSolOutputLamports > 0n ? minSolOutputLamports : 1n, 16);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const sellIx = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys,
      data,
    });

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }),
      sellIx,
    ];

    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

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
      estimatedTokensRaw: tokenAmountRaw.toString(),
      maxSolCostLamports: minSolOutputLamports,
    };
  }
}

export const pumpFunSwapAdapter = new PumpFunSwapAdapter();
