import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { signalManager } from '../src/streams/signal-manager.js';
import { fastExecutionService } from '../src/execution/fast-executor.js';
import { pendingOrderManager, PendingOrderManager } from '../src/engine/pending-order-manager.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import { telegramNotifier } from '../src/notifications/telegram.js';
import { db } from '../src/db/database.js';
import { capitalReservationLedger } from '../src/services/capital-reservation.js';
import { transactionSubmitter } from '../src/execution/transaction-submitter.js';
import { executionWalletManager } from '../src/execution/wallet-manager.js';
import { settlementReconciler } from '../src/execution/settlement-reconciler.js';
import { config } from '../src/config/index.js';
import { liveEngine } from '../src/execution/live-engine.js';
import { FastTransactionDecoder, ParsedTransactionEnvelope } from '../src/parsers/fast-decoder.js';
import { MirrorOrder, SwapIntent } from '../src/types/index.js';

describe('Fast-Path Reconciliation & Notification Safety Regression Suite', () => {
  const mockKeypair = Keypair.generate();
  const mockWallet = mockKeypair.publicKey.toBase58();

  beforeEach(() => {
    vi.restoreAllMocks();
    (config as any).EXECUTION_MODE = 'LIVE';
    (config as any).FAST_COPY_MODE = true;

    vi.spyOn(executionWalletManager, 'getKeypair').mockReturnValue(mockKeypair);
    vi.spyOn(executionWalletManager, 'isBalanceAvailable').mockReturnValue(true);
    vi.spyOn(executionWalletManager, 'getCachedBalanceLamports').mockReturnValue(1_000_000_000n);

    vi.spyOn(liveEngine, 'getStatus').mockReturnValue({
      isArmed: true,
      disarmReason: '',
      publicKey: mockWallet,
      smokeTestMode: false,
      smokeTestTradesCount: 0,
      smokeTestAllowedSide: 'BUY',
    });

    db.upsertWatchedWallet({
      wallet: mockWallet,
      label: 'Target 1',
      enabled: true,
      buyMode: 'FIXED',
      fixedBuyLamports: '50000000',
      copyRatio: 1.0,
      maxBuyLamports: '50000000',
    });
    signalManager.refreshWallets();
  });

  afterEach(() => {
    (config as any).EXECUTION_MODE = 'PAPER';
    vi.restoreAllMocks();
  });

  it('1. SUBMITTED fast-path order never emits BUY FILLED in signalManager', async () => {
    const notifyFilledSpy = vi.spyOn(telegramNotifier, 'notifyTradeFilled').mockResolvedValue();
    const notifySubmittedSpy = vi.spyOn(telegramNotifier, 'notifyTradeSubmitted').mockResolvedValue();

    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_sub_${Date.now()}`;
    const folSig = `fol_sig_${Date.now()}`;

    const mockOrder: MirrorOrder = {
      orderId: 'order_test_submitted',
      targetSignature: targetSig,
      orderSignature: folSig,
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      inAmountRaw: '50000000',
      outAmountRaw: '1000000',
      effectivePrice: 0.00005,
      mode: 'LIVE',
      status: 'SUBMITTED',
      quotedAt: process.hrtime.bigint(),
      submittedAt: process.hrtime.bigint(),
      priorityFeeLamports: 10000n,
      tipLamports: 200000n,
      targetWallet: mockWallet,
    };

    // Fast buy returns order in SUBMITTED state
    vi.spyOn(fastExecutionService, 'executeFastBuy').mockResolvedValue({
      order: mockOrder,
      fallbackNeeded: false,
    });

    const tx: ParsedTransactionEnvelope = {
      signature: targetSig,
      slot: 1000,
      instructions: [],
      accountKeys: [mockWallet, mint],
      signers: [mockWallet],
      observedAt: process.hrtime.bigint(),
    };

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 1000,
      targetWallet: mockWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '50000000',
      outputAmountRaw: '1000000',
      estimatedPrice: 0.00005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    vi.spyOn(FastTransactionDecoder, 'decodeTransaction').mockReturnValue(targetIntent);
    vi.spyOn(riskEngine, 'evaluateIntent').mockReturnValue({ approved: true, decision: 'APPROVED' });

    await signalManager.handleIncomingTransaction(tx);

    // CRITICAL PROOFS:
    // notifyTradeFilled was NEVER called while status is SUBMITTED
    expect(notifyFilledSpy).toHaveBeenCalledTimes(0);
    // notifyTradeSubmitted was called exactly once
    expect(notifySubmittedSpy).toHaveBeenCalledTimes(1);
  });

  it('2. SUBMITTED fast-path order never records successful buy in riskEngine', async () => {
    const recordBuySpy = vi.spyOn(riskEngine, 'recordBuy');
    const recordSuccessSpy = vi.spyOn(riskEngine, 'recordSuccess');

    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_risk_${Date.now()}`;

    const mockOrder: MirrorOrder = {
      orderId: 'order_test_risk',
      targetSignature: targetSig,
      orderSignature: `fol_sig_${Date.now()}`,
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      inAmountRaw: '50000000',
      outAmountRaw: '1000000',
      effectivePrice: 0.00005,
      mode: 'LIVE',
      status: 'SUBMITTED',
      quotedAt: process.hrtime.bigint(),
      submittedAt: process.hrtime.bigint(),
      priorityFeeLamports: 10000n,
      tipLamports: 200000n,
      targetWallet: mockWallet,
    };

    vi.spyOn(fastExecutionService, 'executeFastBuy').mockResolvedValue({
      order: mockOrder,
      fallbackNeeded: false,
    });
    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 1000,
      targetWallet: mockWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '50000000',
      outputAmountRaw: '1000000',
      estimatedPrice: 0.00005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    vi.spyOn(FastTransactionDecoder, 'decodeTransaction').mockReturnValue(targetIntent);
    vi.spyOn(riskEngine, 'evaluateIntent').mockReturnValue({ approved: true, decision: 'APPROVED' });
    vi.spyOn(telegramNotifier, 'notifyTradeSubmitted').mockResolvedValue();

    const tx: ParsedTransactionEnvelope = {
      signature: targetSig,
      slot: 1000,
      instructions: [],
      accountKeys: [mockWallet, mint],
      signers: [mockWallet],
      observedAt: process.hrtime.bigint(),
    };

    await signalManager.handleIncomingTransaction(tx);

    // CRITICAL PROOFS:
    // recordBuy was NOT called
    expect(recordBuySpy).toHaveBeenCalledTimes(0);
    // recordSuccess was NOT called
    expect(recordSuccessSpy).toHaveBeenCalledTimes(0);
    // Token was NOT permanently locked in riskEngine
    expect(riskEngine.isTokenPermanentlyLocked(mint)).toBe(false);
  });

  it('3. FAILED on-chain order never creates position and releases capital reservation', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_fail_${Date.now()}`;
    const folSig = `fol_fail_${Date.now()}`;
    const idKey = PendingOrderManager.generateIdempotencyKey(targetSig, mint, 'BUY');

    pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 50_000_000n,
      reservationLamports: 50_210_000n,
      recentBlockhash: 'mock_bh',
      followerSignature: folSig,
    });

    const notifyFilledSpy = vi.spyOn(telegramNotifier, 'notifyTradeFilled').mockResolvedValue();
    const notifyFailedSpy = vi.spyOn(telegramNotifier, 'notifyTradeFailed').mockResolvedValue();
    const recordFillSpy = vi.spyOn(positionEngine, 'recordFill');

    // Simulate on-chain reconcile returning FAILED with InstructionError
    vi.spyOn(transactionSubmitter, 'reconcileStatus').mockResolvedValue({
      signature: folSig,
      status: 'FAILED',
      provider: 'HELIUS_SWQOS',
      submittedAt: process.hrtime.bigint(),
      error: '{"InstructionError":[2,"IncorrectProgramId"]}',
    });

    const mockOrder: MirrorOrder = {
      orderId: 'order_failed',
      targetSignature: targetSig,
      orderSignature: folSig,
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      inAmountRaw: '50000000',
      outAmountRaw: '1000000',
      effectivePrice: 0.00005,
      mode: 'LIVE',
      status: 'SUBMITTED',
      quotedAt: process.hrtime.bigint(),
      submittedAt: process.hrtime.bigint(),
      priorityFeeLamports: 10000n,
      tipLamports: 200000n,
      targetWallet: mockWallet,
    };

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 1000,
      targetWallet: mockWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '50000000',
      outputAmountRaw: '1000000',
      estimatedPrice: 0.00005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    // Invoke reconcileAsync directly
    await (fastExecutionService as any).reconcileAsync({
      orderId: mockOrder.orderId,
      idempotencyKey: idKey,
      signature: folSig,
      blockhash: 'mock_bh',
      lastValidBlockHeight: 1000,
      mint,
      requestedLamports: 50_000_000n,
      targetIntent,
      mirrorIntent: {} as any,
      order: mockOrder,
      timestamps: { broadcast_completed: process.hrtime.bigint() },
    });

    // CRITICAL PROOFS:
    // No position recorded
    expect(recordFillSpy).toHaveBeenCalledTimes(0);
    expect(db.getPosition(mockWallet, mint)).toBeNull();
    // notifyTradeFilled was NEVER called
    expect(notifyFilledSpy).toHaveBeenCalledTimes(0);
    // notifyTradeFailed was called once with the exact error
    expect(notifyFailedSpy).toHaveBeenCalledTimes(1);
    expect(notifyFailedSpy.mock.calls[0][1]).toContain('IncorrectProgramId');
    // Capital reservation was released
    expect(capitalReservationLedger.getActiveReservations().some((r) => r.idempotencyKey === idKey)).toBe(false);
    // In-flight lock was released
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(false);
    // Token was NOT marked as successfully bought
    expect(riskEngine.isTokenPermanentlyLocked(mint)).toBe(false);
  });

  it('4. EXPIRED on-chain order never creates position and releases capital reservation', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_exp_${Date.now()}`;
    const folSig = `fol_exp_${Date.now()}`;
    const idKey = PendingOrderManager.generateIdempotencyKey(targetSig, mint, 'BUY');

    pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 50_000_000n,
      reservationLamports: 50_210_000n,
      recentBlockhash: 'mock_bh',
      followerSignature: folSig,
    });

    const notifyFilledSpy = vi.spyOn(telegramNotifier, 'notifyTradeFilled').mockResolvedValue();
    const notifyExpiredSpy = vi.spyOn(telegramNotifier, 'notifyTradeExpired').mockResolvedValue();
    const recordFillSpy = vi.spyOn(positionEngine, 'recordFill');

    vi.spyOn(transactionSubmitter, 'reconcileStatus').mockResolvedValue({
      signature: folSig,
      status: 'EXPIRED',
      provider: 'HELIUS_SWQOS',
      submittedAt: process.hrtime.bigint(),
      error: 'Blockhash expired on-chain',
    });

    const mockOrder: MirrorOrder = {
      orderId: 'order_expired',
      targetSignature: targetSig,
      orderSignature: folSig,
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      inAmountRaw: '50000000',
      outAmountRaw: '1000000',
      effectivePrice: 0.00005,
      mode: 'LIVE',
      status: 'SUBMITTED',
      quotedAt: process.hrtime.bigint(),
      submittedAt: process.hrtime.bigint(),
      priorityFeeLamports: 10000n,
      tipLamports: 200000n,
      targetWallet: mockWallet,
    };

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 1000,
      targetWallet: mockWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '50000000',
      outputAmountRaw: '1000000',
      estimatedPrice: 0.00005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    await (fastExecutionService as any).reconcileAsync({
      orderId: mockOrder.orderId,
      idempotencyKey: idKey,
      signature: folSig,
      blockhash: 'mock_bh',
      lastValidBlockHeight: 1000,
      mint,
      requestedLamports: 50_000_000n,
      targetIntent,
      mirrorIntent: {} as any,
      order: mockOrder,
      timestamps: { broadcast_completed: process.hrtime.bigint() },
    });

    // CRITICAL PROOFS:
    expect(recordFillSpy).toHaveBeenCalledTimes(0);
    expect(notifyFilledSpy).toHaveBeenCalledTimes(0);
    expect(notifyExpiredSpy).toHaveBeenCalledTimes(1);
    expect(capitalReservationLedger.getActiveReservations().some((r) => r.idempotencyKey === idKey)).toBe(false);
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(false);
    expect(riskEngine.isTokenPermanentlyLocked(mint)).toBe(false);
  });

  it('5. CONFIRMED on-chain order creates exactly one position, calls recordBuy, and emits exactly one definitive fill', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_conf_${Date.now()}`;
    const folSig = `fol_conf_${Date.now()}`;
    const idKey = PendingOrderManager.generateIdempotencyKey(targetSig, mint, 'BUY');

    pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 50_000_000n,
      reservationLamports: 50_210_000n,
      recentBlockhash: 'mock_bh',
      followerSignature: folSig,
    });

    const notifyFilledSpy = vi.spyOn(telegramNotifier, 'notifyTradeFilled').mockResolvedValue();
    const recordFillSpy = vi.spyOn(positionEngine, 'recordFill');
    const recordBuySpy = vi.spyOn(riskEngine, 'recordBuy');
    vi.spyOn(settlementReconciler, 'reconcileConfirmedTrade').mockResolvedValue({
      actualTokenDeltaRaw: 1000000n,
      actualSolDeltaLamports: -50000000n,
      status: 'RECONCILED',
    } as any);

    vi.spyOn(transactionSubmitter, 'reconcileStatus').mockResolvedValue({
      signature: folSig,
      status: 'CONFIRMED',
      provider: 'HELIUS_SWQOS',
      submittedAt: process.hrtime.bigint(),
      confirmedAt: process.hrtime.bigint(),
    });

    const mockOrder: MirrorOrder = {
      orderId: 'order_confirmed',
      targetSignature: targetSig,
      orderSignature: folSig,
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      inAmountRaw: '50000000',
      outAmountRaw: '1000000',
      effectivePrice: 0.00005,
      mode: 'LIVE',
      status: 'SUBMITTED',
      quotedAt: process.hrtime.bigint(),
      submittedAt: process.hrtime.bigint(),
      priorityFeeLamports: 10000n,
      tipLamports: 200000n,
      targetWallet: mockWallet,
    };

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 1000,
      targetWallet: mockWallet,
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '50000000',
      outputAmountRaw: '1000000',
      estimatedPrice: 0.00005,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    await (fastExecutionService as any).reconcileAsync({
      orderId: mockOrder.orderId,
      idempotencyKey: idKey,
      signature: folSig,
      blockhash: 'mock_bh',
      lastValidBlockHeight: 1000,
      mint,
      requestedLamports: 50_000_000n,
      targetIntent,
      mirrorIntent: {} as any,
      order: mockOrder,
      timestamps: { broadcast_completed: process.hrtime.bigint() },
    });

    // CRITICAL PROOFS:
    // Exactly ONE position recorded
    expect(recordFillSpy).toHaveBeenCalledTimes(1);
    // riskEngine recordBuy called
    expect(recordBuySpy).toHaveBeenCalledWith(mint);
    // Exactly ONE definitive fill alert
    expect(notifyFilledSpy).toHaveBeenCalledTimes(1);
    // Order status marked FILLED
    expect(mockOrder.status).toBe('FILLED');
  });

  it('6. Duplicate target signal cannot create duplicate broadcast', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const targetSig = `sig_dup_${Date.now()}`;

    // First order registers successfully
    const firstReg = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 50_000_000n,
      reservationLamports: 50_210_000n,
      recentBlockhash: 'mock_bh',
    });
    expect(firstReg.success).toBe(true);

    // Duplicate target signature + mint attempts registration
    const dupReg = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 50_000_000n,
      reservationLamports: 50_210_000n,
      recentBlockhash: 'mock_bh',
    });

    expect(dupReg.success).toBe(false);
    expect(dupReg.error).toContain('Duplicate order rejected by idempotency guard');
  });
});
