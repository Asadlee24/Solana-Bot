import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58Module from 'bs58';
import { randomUUID } from 'crypto';
import { config, LAMPORTS_PER_SOL_BIGINT, solToLamportsBigInt } from '../config/index.js';
import { db } from '../db/database.js';
import { positionEngine } from '../engine/position-engine.js';
import {
  MirrorIntent,
  MirrorOrder,
  SwapIntent,
} from '../types/index.js';
import { jupiterSwapV2Adapter, WSOL_MINT } from './jupiter-swap.js';
import { pumpFunSwapAdapter } from './pump-fun-swap.js';
import { transactionSubmitter } from './transaction-submitter.js';
import { executionWalletManager } from './wallet-manager.js';

const bs58Encode = (typeof (bs58Module as any).encode === 'function'
  ? (bs58Module as any).encode
  : (bs58Module as any).default?.encode) as (input: Uint8Array) => string;

export class LiveExecutionEngine {
  private connection: Connection;
  private isArmed: boolean = false;
  private disarmReason: string = 'Engine initialized in safe DISARMED state. Explicit operator arm command required via /api/live/arm.';
  private smokeTestTradesCount: number = 0;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 20000,
    });
    // STRICT: Do NOT auto-arm on startup. Require explicit operator command.
  }

  /**
   * Fail-Closed Safety Check:
   * Requires EXECUTION_MODE=LIVE, valid LIVE_TRADING_ACK, valid keypair, and funded balance.
   */
  public async evaluateArmStatus(): Promise<{ armed: boolean; reason: string }> {
    if (config.EXECUTION_MODE !== 'LIVE') {
      this.isArmed = false;
      this.disarmReason = 'EXECUTION_MODE is set to PAPER. Live engine is disarmed.';
      return { armed: false, reason: this.disarmReason };
    }

    const requiredAck = 'I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK';
    if (config.LIVE_TRADING_ACK !== requiredAck) {
      this.isArmed = false;
      this.disarmReason = `Missing or invalid safety acknowledgement: LIVE_TRADING_ACK must equal "${requiredAck}"`;
      console.warn(`[LIVE ENGINE DISARMED] ${this.disarmReason}`);
      return { armed: false, reason: this.disarmReason };
    }

    if (!executionWalletManager.isReady()) {
      this.isArmed = false;
      this.disarmReason = 'FOLLOWER_PRIVATE_KEY is missing or failed cryptographic validation';
      console.warn(`[LIVE ENGINE DISARMED] ${this.disarmReason}`);
      return { armed: false, reason: this.disarmReason };
    }

    // Refresh balance and check reserve floor
    try {
      const balanceLamports = await executionWalletManager.refreshBalance();
      const minRequiredSol = config.MIN_SOL_RESERVE_SOL + config.FIXED_BUY_SOL;
      const minRequiredLamports = solToLamportsBigInt(minRequiredSol);

      if (balanceLamports < minRequiredLamports) {
        this.isArmed = false;
        this.disarmReason = `Insufficient hot wallet balance (${executionWalletManager.getCachedBalanceSol().toFixed(4)} SOL). Minimum required for live operation is ${minRequiredSol.toFixed(4)} SOL`;
        console.warn(`[LIVE ENGINE DISARMED] ${this.disarmReason}`);
        return { armed: false, reason: this.disarmReason };
      }
    } catch (err: any) {
      this.isArmed = false;
      this.disarmReason = `RPC balance check failed: ${err.message}`;
      return { armed: false, reason: this.disarmReason };
    }

    // Reset smoke test count upon manual operator re-arming
    this.smokeTestTradesCount = 0;
    this.isArmed = true;
    this.disarmReason = 'LIVE ARMED: All safety checks passed. Hot wallet ready.';
    console.info(`[LIVE ENGINE ARMED] Active signer: ${executionWalletManager.getPublicKeyBase58()}`);
    return { armed: true, reason: this.disarmReason };
  }

  public getStatus(): {
    isArmed: boolean;
    disarmReason: string;
    publicKey: string | null;
    smokeTestMode: boolean;
    smokeTestTradesCount: number;
  } {
    return {
      isArmed: this.isArmed,
      disarmReason: this.disarmReason,
      publicKey: executionWalletManager.getPublicKeyBase58(),
      smokeTestMode: config.MAINNET_SMOKE_TEST_MODE,
      smokeTestTradesCount: this.smokeTestTradesCount,
    };
  }

  /**
   * Emergency Operator Kill Switch
   */
  public kill(reason: string = 'Killed by operator via API/Dashboard'): void {
    this.isArmed = false;
    this.disarmReason = reason;
    console.warn(`[KILL SWITCH ACTIVATED] ${reason}`);
  }

  /**
   * Operator Re-arm Command
   */
  public async arm(): Promise<{ armed: boolean; reason: string }> {
    return await this.evaluateArmStatus();
  }

  /**
   * Executes a REAL on-chain trade on Solana mainnet.
   * STRICT ENFORCEMENT: Never fakes fills, never generates synthetic signatures.
   */
  public async executeLiveTrade(
    targetIntent: SwapIntent,
    mirrorIntent: MirrorIntent
  ): Promise<MirrorOrder> {
    const quotedAt = process.hrtime.bigint();
    const orderId = randomUUID();

    // 1. Fail Closed Guard
    if (!this.isArmed) {
      const msg = `Cannot execute live trade: LIVE execution is DISARMED (${this.disarmReason})`;
      console.error(`[LIVE ERROR] ${msg}`);
      throw new Error(msg);
    }

    // Smoke Test Guard: Only 1 trade permitted before auto-disarming
    if (config.MAINNET_SMOKE_TEST_MODE && this.smokeTestTradesCount >= 1) {
      this.isArmed = false;
      const msg = 'SMOKE TEST COMPLETE — REVIEW TRANSACTION. Second trade blocked to protect capital.';
      this.disarmReason = msg;
      throw new Error(msg);
    }

    const keypair = executionWalletManager.getKeypair();
    if (!keypair) {
      throw new Error('Follower keypair is unavailable');
    }

    const isBuy = mirrorIntent.side === 'BUY';
    const rawInAmount = mirrorIntent.requestedInAmountRaw;

    // 2. Pre-trade Balance & Reserve Floor Check
    if (isBuy) {
      const requestedLamports = BigInt(rawInAmount);
      const spendCheck = executionWalletManager.checkSpendable(
        requestedLamports,
        BigInt(config.PRIORITY_FEE_MICRO_LAMPORTS),
        BigInt(config.HELIUS_SENDER_TIP_LAMPORTS)
      );
      if (!spendCheck.allowed) {
        throw new Error(spendCheck.reason || 'INSUFFICIENT_BALANCE');
      }
    }

    // Build initial order record
    const order: MirrorOrder = {
      orderId,
      intentId: mirrorIntent.id,
      targetSignature: targetIntent.targetSignature,
      mode: 'LIVE',
      side: mirrorIntent.side,
      tokenMint: mirrorIntent.tokenMint,
      inAmountRaw: rawInAmount,
      outAmountRaw: '0',
      minOutAmountRaw: '0',
      effectivePrice: targetIntent.estimatedPrice,
      quotedAt,
      priorityFeeLamports: BigInt(config.PRIORITY_FEE_MICRO_LAMPORTS),
      tipLamports: BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
      routeFeeLamports: 5_000n,
      status: 'PENDING',
    };

    db.saveMirrorOrder(order);

    try {
      let signedTx: VersionedTransaction;
      let latestBlockhash: BlockhashWithExpiryBlockHeight;
      let expectedOutRaw = '0';
      let effectivePrice = targetIntent.estimatedPrice;

      // 3. Build Real Mainnet Transaction via Jupiter Swap API V2 / Pump.fun Adaptive Router
      if (isBuy) {
        const solLamports = BigInt(rawInAmount);

        // Check if token is Pump.fun (active curve or graduated)
        if (targetIntent.venue === 'PUMPFUN' && !targetIntent.tokenMint.endsWith('pump')) {
          const pumpResult = await pumpFunSwapAdapter.buildAndSignBuy(
            keypair,
            mirrorIntent.tokenMint,
            solLamports,
            config.MAX_SLIPPAGE_BPS
          );
          signedTx = pumpResult.transaction;
          latestBlockhash = pumpResult.latestBlockhash;
          expectedOutRaw = pumpResult.outAmountRaw;
          effectivePrice = pumpResult.effectivePriceSol;
        } else {
          // Standard / Graduated / Multi-venue swap via Jupiter Swap API V2
          const jupOrder = await jupiterSwapV2Adapter.createOrder(
            WSOL_MINT,
            mirrorIntent.tokenMint,
            rawInAmount,
            keypair.publicKey.toBase58(),
            config.MAX_SLIPPAGE_BPS
          );
          const signedResult = await jupiterSwapV2Adapter.signOrder(keypair, jupOrder);
          signedTx = signedResult.transaction;
          expectedOutRaw = signedResult.outAmountRaw;
          effectivePrice = signedResult.effectivePriceSol;
          latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
        }
      } else {
        // SELL Order
        const tokenAmountRaw = BigInt(rawInAmount);

        if (targetIntent.venue === 'PUMPFUN' && !targetIntent.tokenMint.endsWith('pump')) {
          const pumpResult = await pumpFunSwapAdapter.buildAndSignSell(
            keypair,
            mirrorIntent.tokenMint,
            tokenAmountRaw,
            config.MAX_SLIPPAGE_BPS
          );
          signedTx = pumpResult.transaction;
          latestBlockhash = pumpResult.latestBlockhash;
          expectedOutRaw = pumpResult.outAmountRaw;
          effectivePrice = pumpResult.effectivePriceSol;
        } else {
          const jupOrder = await jupiterSwapV2Adapter.createOrder(
            mirrorIntent.tokenMint,
            WSOL_MINT,
            rawInAmount,
            keypair.publicKey.toBase58(),
            config.MAX_SLIPPAGE_BPS
          );
          const signedResult = await jupiterSwapV2Adapter.signOrder(keypair, jupOrder);
          signedTx = signedResult.transaction;
          expectedOutRaw = signedResult.outAmountRaw;
          effectivePrice = signedResult.effectivePriceSol;
          latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
        }
      }

      order.signedAt = process.hrtime.bigint();
      order.outAmountRaw = expectedOutRaw;
      order.effectivePrice = effectivePrice;

      // Extract real transaction signature from the first signature slot
      const realTxSignature = bs58Encode(signedTx.signatures[0]);
      order.orderSignature = realTxSignature;
      order.submittedAt = process.hrtime.bigint();

      // 4. Low-Latency Submission with Preflight Simulation & Strict Confirmation Polling
      const receipt = await transactionSubmitter.submitAndConfirm(
        signedTx,
        latestBlockhash,
        realTxSignature
      );

      if (receipt.status === 'CONFIRMED' || receipt.status === 'PROCESSED') {
        order.status = 'FILLED';
        order.landedAt = receipt.confirmedAt || process.hrtime.bigint();
        db.saveMirrorOrder(order);

        // Reconcile and record in position engine
        if (isBuy) {
          positionEngine.recordFill(
            mirrorIntent.targetWallet,
            mirrorIntent.tokenMint,
            'BUY',
            BigInt(order.outAmountRaw || '0'),
            BigInt(order.inAmountRaw),
            effectivePrice,
            realTxSignature
          );
        } else {
          positionEngine.recordFill(
            mirrorIntent.targetWallet,
            mirrorIntent.tokenMint,
            'SELL',
            BigInt(order.inAmountRaw),
            BigInt(order.outAmountRaw || '0'),
            effectivePrice,
            realTxSignature
          );
        }

        // Refresh hot wallet balance in background
        executionWalletManager.refreshBalance().catch(() => {});

        // Smoke-Test Mode: Auto-Disarm immediately after 1 successful test trade!
        if (config.MAINNET_SMOKE_TEST_MODE) {
          this.smokeTestTradesCount++;
          this.kill('SMOKE TEST COMPLETE — REVIEW TRANSACTION');
          console.warn('🛡️ [SMOKE TEST COMPLETE] Auto-disarmed live execution hot wallet. Review transaction before re-arming.');
        }

        console.info(`[REAL LIVE EXECUTION FILLED] Signature: ${realTxSignature}`);
        return order;
      } else {
        order.status = receipt.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
        order.errorMessage = receipt.error || `Transaction failed with status: ${receipt.status}`;
        db.saveMirrorOrder(order);
        throw new Error(`Live transaction ${realTxSignature} failed: ${order.errorMessage}`);
      }
    } catch (err: any) {
      order.status = 'FAILED';
      order.errorMessage = err.message || String(err);
      db.saveMirrorOrder(order);
      throw err;
    }
  }
}

export const liveEngine = new LiveExecutionEngine();
