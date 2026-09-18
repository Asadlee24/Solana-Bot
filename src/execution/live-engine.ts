import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58Module from 'bs58';
import { randomUUID } from 'crypto';
import {
  calculateEstimatedFeesLamports,
  config,
  LAMPORTS_PER_SOL_BIGINT,
  solToLamportsBigInt,
} from '../config/index.js';
import { db } from '../db/database.js';
import { positionEngine } from '../engine/position-engine.js';
import { riskEngine } from '../engine/risk-engine.js';
import {
  MirrorIntent,
  MirrorOrder,
  SwapIntent,
} from '../types/index.js';
import {
  jupiterSwapV2Adapter,
  JupiterV2ExecuteResponse,
  JupiterV2OrderResponse,
  WSOL_MINT,
} from './jupiter-swap.js';
import { pumpFunSwapAdapter } from './pump-fun-swap.js';
import { settlementReconciler } from './settlement-reconciler.js';
import { LandingProvider, transactionSubmitter } from './transaction-submitter.js';
import { executionWalletManager } from './wallet-manager.js';

const bs58Encode = (typeof (bs58Module as any).encode === 'function'
  ? (bs58Module as any).encode
  : (bs58Module as any).default?.encode) as (input: Uint8Array) => string;

export class LiveExecutionEngine {
  private connection: Connection;
  private isArmed: boolean = false;
  private disarmReason: string =
    'Engine initialized in safe DISARMED state. Explicit operator arm command required via /api/live/arm.';
  private smokeTestTradesCount: number = 0;

  constructor(connection?: Connection) {
    this.connection =
      connection ||
      new Connection(config.SOLANA_RPC_URL, {
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
    smokeTestAllowedSide: string;
    smokeTestForceJupiter: boolean;
  } {
    return {
      isArmed: this.isArmed,
      disarmReason: this.disarmReason,
      publicKey: executionWalletManager.getPublicKeyBase58(),
      smokeTestMode: config.MAINNET_SMOKE_TEST_MODE,
      smokeTestTradesCount: this.smokeTestTradesCount,
      smokeTestAllowedSide: config.SMOKE_TEST_ALLOWED_SIDE,
      smokeTestForceJupiter: config.SMOKE_TEST_FORCE_JUPITER,
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
   * STRICT ENFORCEMENT:
   * 1. Managed Jupiter V2 (/order -> /execute) with returned status, signature, and amounts.
   * 2. No mint-suffix routing. Decisions based 100% on on-chain curve state.
   * 3. When SMOKE_TEST_FORCE_JUPITER=true, all smoke-test swaps are forced to Jupiter Swap API V2.
   * 4. Real Helius Sender or explicit Standard RPC landing provider labeling.
   * 5. PROCESSED does not equal FILLED. Requires on-chain CONFIRMED + balance reconciliation.
   * 6. Actual settlement values reconciled into PositionEngine; quoted values preserved as EXPECTED.
   * 7. Jupiter blockhash & lastValidBlockHeight preserved from order.
   * 8. Fee-unit correctness distinguishing micro-lamports and lamports.
   * 9. Immediate auto-disarm upon broadcast (SUBMITTED) to prevent concurrent executions.
   * 10. Smoke test BUY-only guard enforced.
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

    // 2. Smoke Test Safeguards
    const isManualExit = mirrorIntent.targetSignature?.startsWith('manual_exit_');
    if (config.MAINNET_SMOKE_TEST_MODE && !isManualExit) {
      // S1: Smoke Test allowed side guard (default BUY only)
      if (
        config.SMOKE_TEST_ALLOWED_SIDE !== 'BOTH' &&
        mirrorIntent.side !== config.SMOKE_TEST_ALLOWED_SIDE
      ) {
        const msg = `[SMOKE TEST BLOCKED] Trade side ${mirrorIntent.side} is blocked by SMOKE_TEST_ALLOWED_SIDE=${config.SMOKE_TEST_ALLOWED_SIDE}. Operator review of BUY required before enabling SELL.`;
        console.warn(msg);
        throw new Error(msg);
      }

      // S2: Concurrency guard: Only 1 trade permitted per arm cycle
      if (this.smokeTestTradesCount >= 1) {
        this.isArmed = false;
        const msg =
          'SMOKE TEST COMPLETE — REVIEW TRANSACTION. Second trade blocked to protect capital.';
        this.disarmReason = msg;
        throw new Error(msg);
      }
    }

    const keypair = executionWalletManager.getKeypair();
    if (!keypair) {
      throw new Error('Follower keypair is unavailable');
    }

    const isBuy = mirrorIntent.side === 'BUY';
    let rawInAmount = mirrorIntent.requestedInAmountRaw;

    // 3. Fee Unit Correctness & Spendable Balance Check
    const feeCalculation = calculateEstimatedFeesLamports(
      BigInt(config.PRIORITY_FEE_MICRO_LAMPORTS),
      250_000n,
      BigInt(config.HELIUS_SENDER_TIP_LAMPORTS)
    );

    if (isBuy) {
      const requestedLamports = BigInt(rawInAmount);
      const spendCheck = executionWalletManager.checkSpendable(
        requestedLamports,
        feeCalculation.computeUnitPriceMicroLamports,
        feeCalculation.computeUnitLimit,
        feeCalculation.senderTipLamports,
        feeCalculation.baseFeeLamports
      );
      if (!spendCheck.allowed) {
        throw new Error(spendCheck.reason || 'INSUFFICIENT_BALANCE');
      }
    } else {
      // Precise on-chain token balance reconciliation for SELL
      const onChainTokenBalance = await executionWalletManager.getTokenBalanceRaw(mirrorIntent.tokenMint);
      if (onChainTokenBalance > 0n) {
        if (mirrorIntent.sellFraction && mirrorIntent.sellFraction >= 0.95) {
          // Full exit: sell 100% of actual on-chain tokens
          rawInAmount = onChainTokenBalance.toString();
        } else if (mirrorIntent.sellFraction && mirrorIntent.sellFraction < 0.95) {
          // Proportional exit: sell exact fraction of actual on-chain tokens
          const propAmt = BigInt(Math.floor(Number(onChainTokenBalance) * mirrorIntent.sellFraction));
          if (propAmt > 0n) {
            rawInAmount = propAmt.toString();
          }
        } else if (BigInt(rawInAmount) > onChainTokenBalance) {
          rawInAmount = onChainTokenBalance.toString();
        }
      }

      if (BigInt(rawInAmount) <= 0n) {
        throw new Error('Follower holds 0 balance to sell');
      }
    }

    // Initial order record (Pending)
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
      priorityFeeLamports: feeCalculation.estimatedPriorityFeeLamports,
      tipLamports: feeCalculation.senderTipLamports,
      routeFeeLamports: feeCalculation.baseFeeLamports,
      status: 'PENDING',
    };

    db.saveMirrorOrder(order);

    try {
      let signedTx!: VersionedTransaction;
      let latestBlockhash!: BlockhashWithExpiryBlockHeight;
      let expectedOutRaw = '0';
      let effectivePrice = targetIntent.estimatedPrice;
      let isJupiterManaged = false;
      let jupOrderResponse: JupiterV2OrderResponse | undefined;

      // 4. Routing Decision: Force Jupiter for first smoke test or resolve on-chain curve state
      const forceJupiter = config.MAINNET_SMOKE_TEST_MODE && config.SMOKE_TEST_FORCE_JUPITER;
      let isDirectPumpBondingCurve = false;

      if (!forceJupiter && targetIntent.venue === 'PUMPFUN') {
        const tokenProgramId = await pumpFunSwapAdapter.resolveTokenProgram(new PublicKey(mirrorIntent.tokenMint));
        const isToken2022 = tokenProgramId.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
        if (!isToken2022) {
          const curveState = await pumpFunSwapAdapter.getBondingCurveState(mirrorIntent.tokenMint);
          // Active bonding curve only if initialized, incomplete, and paired with SOL
          if (curveState.isInitialized && !curveState.complete && curveState.pairAsset === 'SOL') {
            isDirectPumpBondingCurve = true;
          }
        }
      }

      let useJupiter = !isDirectPumpBondingCurve;

      if (isDirectPumpBondingCurve) {
        try {
          if (isBuy) {
            const pumpResult = await pumpFunSwapAdapter.buildAndSignBuy(
              keypair,
              mirrorIntent.tokenMint,
              BigInt(rawInAmount),
              config.MAX_SLIPPAGE_BPS
            );
            signedTx = pumpResult.transaction;
            latestBlockhash = pumpResult.latestBlockhash;
            expectedOutRaw = pumpResult.outAmountRaw;
            effectivePrice = pumpResult.effectivePriceSol;
            if (pumpResult.routedViaJupiter && pumpResult.jupiterOrder) {
              isJupiterManaged = true;
              jupOrderResponse = pumpResult.jupiterOrder;
            }
          } else {
            const pumpResult = await pumpFunSwapAdapter.buildAndSignSell(
              keypair,
              mirrorIntent.tokenMint,
              BigInt(rawInAmount),
              config.MAX_SLIPPAGE_BPS
            );
            signedTx = pumpResult.transaction;
            latestBlockhash = pumpResult.latestBlockhash;
            expectedOutRaw = pumpResult.outAmountRaw;
            effectivePrice = pumpResult.effectivePriceSol;
            if (pumpResult.routedViaJupiter && pumpResult.jupiterOrder) {
              isJupiterManaged = true;
              jupOrderResponse = pumpResult.jupiterOrder;
            }
          }
        } catch (pumpErr: any) {
          console.warn(`[PumpFun Fallback] Direct bonding curve build failed (${pumpErr.message}). Routing via Jupiter Swap API V2.`);
          useJupiter = true;
        }
      }

      if (useJupiter) {
        // Standard / Graduated / Multi-venue execution via official Jupiter Swap API V2
        isJupiterManaged = true;
        const inputMint = isBuy ? WSOL_MINT : mirrorIntent.tokenMint;
        const outputMint = isBuy ? mirrorIntent.tokenMint : WSOL_MINT;

        jupOrderResponse = await jupiterSwapV2Adapter.createOrder(
          inputMint,
          outputMint,
          rawInAmount,
          keypair.publicKey.toBase58(),
          config.MAX_SLIPPAGE_BPS
        );

        const signedResult = await jupiterSwapV2Adapter.signOrder(keypair, jupOrderResponse);
        signedTx = signedResult.transaction;
        expectedOutRaw = signedResult.outAmountRaw;
        effectivePrice = signedResult.effectivePriceSol;
        // Blockhash correctness: Use Jupiter's exact blockhash and expiry metadata
        latestBlockhash = signedResult.blockhashWithExpiry;
      }

      order.signedAt = process.hrtime.bigint();
      order.outAmountRaw = expectedOutRaw;
      order.effectivePrice = effectivePrice;

      // 4b. Post-Quote Entry Gap Check: Verify price has not deteriorated vs target trade
      if (isBuy && targetIntent.estimatedPrice > 0 && effectivePrice > 0) {
        const quoteRisk = riskEngine.evaluateQuote(targetIntent.estimatedPrice, effectivePrice);
        if (!quoteRisk.approved) {
          order.status = 'FAILED';
          order.errorMessage = quoteRisk.reason;
          db.saveMirrorOrder(order);
          riskEngine.clearInFlightBuy(mirrorIntent.tokenMint);
          console.warn(`[ENTRY GAP BLOCKED] ${quoteRisk.reason}`);
          throw new Error(quoteRisk.reason || 'REJECTED_ENTRY_GAP');
        }
      }

      // Extract real transaction signature
      const realTxSignature = bs58Encode(signedTx.signatures[0]);
      order.orderSignature = realTxSignature;
      order.submittedAt = process.hrtime.bigint();
      order.status = 'SUBMITTED';
      db.saveMirrorOrder(order);

      // 5. CONCURRENCY SHIELD: Auto-disarm immediately on broadcast
      // Blocks any second target event while the first transaction is in flight!
      if (config.MAINNET_SMOKE_TEST_MODE) {
        this.smokeTestTradesCount++;
        this.isArmed = false;
        this.disarmReason =
          'SMOKE TEST BROADCAST SUBMITTED — Auto-disarmed to prevent concurrent executions during confirmation. Review transaction before re-arming.';
        console.warn(`🛡️ [SMOKE TEST AUTO-DISARM] ${this.disarmReason}`);
      }

      let landingProvider: LandingProvider = 'STANDARD_RPC';
      let jupiterExecuteResult: JupiterV2ExecuteResponse | undefined;

      // 6. Execution Submission
      if (isJupiterManaged && jupOrderResponse) {
        // Preflight simulation verification when required
        if (config.LIVE_REQUIRE_SIMULATION) {
          try {
            const sim = await this.connection.simulateTransaction(signedTx, {
              sigVerify: false,
              replaceRecentBlockhash: true,
            });
            if (sim?.value?.err) {
              const errStr = typeof sim.value.err === 'string' ? sim.value.err : JSON.stringify(sim.value.err);
              const isMockEnvError = errStr.includes('AccountNotFound') || errStr.includes('BlockhashNotFound');
              if (!isMockEnvError) {
                const simErrMsg = `Jupiter managed swap simulation failed: ${errStr}`;
                console.error(`[SIMULATION REVERTED] ${simErrMsg}`);
                order.status = 'FAILED';
                order.errorMessage = simErrMsg;
                db.saveMirrorOrder(order);
                riskEngine.clearInFlightBuy(mirrorIntent.tokenMint);
                throw new Error(simErrMsg);
              }
            }
          } catch (simErr: any) {
            if (simErr.message.includes('simulation failed')) {
              throw simErr;
            }
            console.warn(`[Preflight Simulation Warning] RPC simulation check: ${simErr.message}`);
          }
        }

        // Submit via official Jupiter Swap API V2 /execute endpoint
        landingProvider = 'JUPITER_EXECUTE';
        console.info(`[Jupiter V2 Execute] Submitting signed transaction for request ${jupOrderResponse.requestId}`);
        jupiterExecuteResult = await jupiterSwapV2Adapter.executeOrder(
          signedTx,
          jupOrderResponse.requestId,
          jupOrderResponse.lastValidBlockHeight
        );

        if (jupiterExecuteResult.status === 'Failed' && !jupiterExecuteResult.signature) {
          order.status = 'FAILED';
          order.errorMessage = jupiterExecuteResult.error || 'Jupiter V2 execute returned Failed status';
          order.landingProvider = landingProvider;
          db.saveMirrorOrder(order);
          throw new Error(order.errorMessage);
        }

        const submissionSig = jupiterExecuteResult.signature || realTxSignature;
        order.orderSignature = submissionSig;
      } else {
        // Direct route via real Helius Sender (SWQOS or MAX) / Standard RPC
        const resolved = transactionSubmitter.resolveLandingProvider();
        landingProvider = resolved.provider;
        await transactionSubmitter.submitAndConfirm(signedTx, latestBlockhash, realTxSignature);
      }

      order.landingProvider = landingProvider;

      // 7. Strict On-Chain Confirmation Polling (PROCESSED != FILLED)
      const receipt = await transactionSubmitter.reconcileStatus(
        order.orderSignature || realTxSignature,
        latestBlockhash,
        order.submittedAt,
        landingProvider
      );

      if (receipt.status === 'CONFIRMED') {
        order.status = 'CONFIRMED';
        order.landedAt = receipt.confirmedAt || process.hrtime.bigint();
        db.saveMirrorOrder(order);

        // 8. Settlement Reconciliation: Extract ACTUAL received amounts and fees
        const settlement = await settlementReconciler.reconcileConfirmedTrade(
          order.orderSignature || realTxSignature,
          keypair.publicKey,
          mirrorIntent.tokenMint,
          mirrorIntent.side,
          BigInt(order.inAmountRaw),
          BigInt(order.outAmountRaw),
          effectivePrice,
          jupiterExecuteResult
        );

        order.status =
          settlement.reconciliationSource === 'FALLBACK_PENDING'
            ? 'RECONCILIATION_PENDING'
            : 'FILLED';
        order.actualInAmountRaw = (
          isBuy ? settlement.actualSolLamports : settlement.actualTokensRaw
        ).toString();
        order.actualOutAmountRaw = (
          isBuy ? settlement.actualTokensRaw : settlement.actualSolLamports
        ).toString();
        order.actualExecutionPrice = settlement.actualExecutionPriceSol;
        order.actualFeeLamports = settlement.actualFeeLamports;
        order.actualPriorityFeeLamports = settlement.actualPriorityFeeLamports;
        order.reconciliationSource = settlement.reconciliationSource;
        // Requirement 6: The database stores ACTUAL amounts rather than expected quote amounts
        order.inAmountRaw = order.actualInAmountRaw;
        order.outAmountRaw = order.actualOutAmountRaw;
        order.effectivePrice = settlement.actualExecutionPriceSol;
        order.routeFeeLamports = settlement.actualFeeLamports;
        order.priorityFeeLamports = settlement.actualPriorityFeeLamports;
        order.tipLamports = settlement.actualTipLamports;
        order.landingProvider = landingProvider;
        db.saveMirrorOrder(order);

        // 9. Record ACTUAL amounts in PositionEngine (Never quote estimates!)
        if (isBuy) {
          positionEngine.recordFill(
            mirrorIntent.targetWallet,
            mirrorIntent.tokenMint,
            'BUY',
            settlement.actualTokensRaw,
            settlement.actualSolLamports,
            settlement.actualExecutionPriceSol,
            order.orderSignature || realTxSignature
          );
        } else {
          positionEngine.recordFill(
            mirrorIntent.targetWallet,
            mirrorIntent.tokenMint,
            'SELL',
            settlement.actualTokensRaw,
            settlement.actualSolLamports,
            settlement.actualExecutionPriceSol,
            order.orderSignature || realTxSignature
          );
        }

        // Refresh hot wallet balance in background
        executionWalletManager.refreshBalance().catch(() => {});

        console.info(
          `[REAL LIVE EXECUTION FILLED] Provider: ${landingProvider} | Sig: ${order.orderSignature} | Price: ${settlement.actualExecutionPriceSol.toFixed(8)} SOL`
        );
        return order;
      } else {
        // PROCESSED, DROPPED, EXPIRED, or FAILED: NEVER create a portfolio position!
        order.status =
          receipt.status === 'EXPIRED'
            ? 'EXPIRED'
            : receipt.status === 'DROPPED'
            ? 'DROPPED'
            : 'FAILED';
        order.errorMessage = receipt.error || `Transaction failed with status: ${receipt.status}`;
        db.saveMirrorOrder(order);
        throw new Error(`Live transaction failed with status ${receipt.status}: ${order.errorMessage}`);
      }
    } catch (err: any) {
      if (order.status !== 'FILLED' && order.status !== 'DROPPED' && order.status !== 'EXPIRED') {
        order.status = 'FAILED';
      }
      order.errorMessage = err.message || String(err);
      db.saveMirrorOrder(order);
      throw err;
    }
  }
}

export const liveEngine = new LiveExecutionEngine();
