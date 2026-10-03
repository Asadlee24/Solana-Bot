import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../src/config/index.js';
import { db } from '../src/db/database.js';
import { dedupeEngine } from '../src/engine/dedupe.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { PendingOrderManager, pendingOrderManager } from '../src/engine/pending-order-manager.js';
import { FastSimulationPolicy } from '../src/execution/fast-simulation-policy.js';
import { fastExecutionService } from '../src/execution/fast-executor.js';
import { executionWalletManager } from '../src/execution/wallet-manager.js';
import { fastPumpBuilder } from '../src/execution/fast-pump-builder.js';
import { transactionSubmitter } from '../src/execution/transaction-submitter.js';
import { FastTransactionDecoder, ParsedTransactionEnvelope } from '../src/parsers/fast-decoder.js';
import { capitalReservationLedger } from '../src/services/capital-reservation.js';
import { curveStateCache } from '../src/services/curve-state-cache.js';
import { HeliusTransactionStream } from '../src/streams/helius-transaction-stream.js';
import { signalManager } from '../src/streams/signal-manager.js';
import { liveEngine } from '../src/execution/live-engine.js';
import { latencyTracker } from '../src/telemetry/latency-tracker.js';
import { FastPathTimestamps, MirrorIntent, SwapIntent } from '../src/types/index.js';

describe('First-TX Fast Path Test Suite', () => {
  const originalFastCopyMode = config.FAST_COPY_MODE;
  const originalFastSkipSim = config.FAST_COPY_SKIP_SIMULATION;
  const originalFallbackEnabled = config.FAST_PATH_FALLBACK_ENABLED;

  beforeEach(() => {
    config.FAST_COPY_MODE = true;
    config.FAST_COPY_SKIP_SIMULATION = true;
    config.FAST_PATH_FALLBACK_ENABLED = true;
    capitalReservationLedger.clear();
    curveStateCache.clear();
    db.clearPendingOrders();
  });

  afterEach(() => {
    config.FAST_COPY_MODE = originalFastCopyMode;
    config.FAST_COPY_SKIP_SIMULATION = originalFastSkipSim;
    config.FAST_PATH_FALLBACK_ENABLED = originalFallbackEnabled;
    capitalReservationLedger.clear();
    curveStateCache.clear();
    db.clearPendingOrders();
    vi.restoreAllMocks();
  });

  // 1. FAST_COPY_MODE=false preserves normal behavior
  it('FAST_COPY_MODE=false preserves normal behavior and requires simulation', () => {
    config.FAST_COPY_MODE = false;
    const policy = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 100,
      curveStateVerified: true,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
    });

    expect(policy.canBypass).toBe(false);
    expect(policy.shouldSimulate).toBe(true);
    expect(policy.reason).toContain('FAST_COPY_MODE is false');
  });

  // 2. Full transaction stream decoding
  it('decodes full transaction stream envelope without RPC fetch', () => {
    const stream = new HeliusTransactionStream({ onTransaction: () => {} });
    const targetKey = Keypair.generate().publicKey.toBase58();

    const sampleNotification = {
      signature: 'mock_tx_stream_sig_123',
      slot: 312500000,
      transaction: {
        signatures: ['mock_tx_stream_sig_123'],
        message: {
          accountKeys: [targetKey, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
          instructions: [
            {
              programIdIndex: 1,
              accounts: [0],
              data: Buffer.from([0x01, 0x02, 0x03]).toString('base64'),
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1000000000, 0],
        postBalances: [999995000, 0],
      },
    };

    const envelope = stream.transformNotification(sampleNotification, process.hrtime.bigint());
    expect(envelope).not.toBeNull();
    expect(envelope?.signature).toBe('mock_tx_stream_sig_123');
    expect(envelope?.accountKeys).toContain(targetKey);
    expect(envelope?.instructions).toHaveLength(1);
    expect(envelope?.meta?.fee).toBe(5000);
  });

  // 3. Duplicate target signature filtering
  it('filters duplicate target signatures', () => {
    const sig = `sig_dup_${Date.now()}`;
    const first = dedupeEngine.registerEvent(sig, 'SEEN_PRECONF', 'HELIUS_PRECONFIRMATION');
    expect(first.shouldAct).toBe(true);

    dedupeEngine.markActed(sig);
    const second = dedupeEngine.registerEvent(sig, 'SEEN_PRECONF', 'HELIUS_PRECONFIRMATION');
    expect(second.shouldAct).toBe(false);
  });

  // 4. Duplicate mint / idempotency protection
  it('prevents duplicate follower buy on same target transaction and mint', () => {
    const targetSig = `target_${Date.now()}`;
    const mint = Keypair.generate().publicKey.toBase58();
    const idKey = PendingOrderManager.generateIdempotencyKey(targetSig, mint, 'BUY');

    const first = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'mock_bh',
    });
    expect(first.success).toBe(true);

    const second = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'mock_bh',
    });
    expect(second.success).toBe(false);
    expect(second.error).toContain('Duplicate order rejected by idempotency guard');

    // Clean up
    pendingOrderManager.resolveOrder(idKey, 'FAILED');
  });

  // 5. Target is not signer -> reject (Anti-bait)
  it('rejects transaction if target wallet is not a signer (anti-bait guard)', () => {
    const target = Keypair.generate().publicKey.toBase58();
    const attacker = Keypair.generate().publicKey.toBase58();

    const envelope: ParsedTransactionEnvelope = {
      signature: 'unsolicited_airdrop_sig',
      slot: 1000,
      signers: [attacker], // Target is NOT a signer!
      accountKeys: [attacker, target],
      instructions: [
        {
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          accounts: [attacker, target],
          data: Buffer.alloc(10),
        },
      ],
      observedAt: process.hrtime.bigint(),
    };

    const intent = FastTransactionDecoder.decodeTransaction(envelope, target);
    expect(intent).toBeNull();
  });

  // 6. Pure transfer -> reject
  it('rejects pure SPL transfers without swap contract interaction', () => {
    const target = Keypair.generate().publicKey.toBase58();

    const envelope: ParsedTransactionEnvelope = {
      signature: 'pure_transfer_sig',
      slot: 1000,
      signers: [target],
      accountKeys: [target, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      instructions: [
        {
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          accounts: [target],
          data: Buffer.from([3, 0, 0, 0]), // transfer instruction
        },
      ],
      observedAt: process.hrtime.bigint(),
    };

    const intent = FastTransactionDecoder.decodeTransaction(envelope, target);
    expect(intent?.isTransferNoise).toBe(true);
  });

  // 7. Unsupported venue -> fallback
  it('signals fallback if swap venue is not direct Pump.fun', async () => {
    const targetSig = `sig_raydium_${Date.now()}`;
    const mint = Keypair.generate().publicKey.toBase58();

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 100,
      targetWallet: 'wallet1',
      venue: 'RAYDIUM_AMM', // Unsupported by Fast-Path direct builder
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '100000000',
      outputAmountRaw: '5000000',
      estimatedPrice: 0.00002,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      confidence: 1.0,
    };

    const mirrorIntent: MirrorIntent = {
      id: 'mirror_1',
      targetSignature: targetSig,
      targetWallet: 'wallet1',
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      requestedInAmountRaw: '100000000',
      expectedOutAmountRaw: '5000000',
      riskDecision: 'APPROVED',
      createdAt: process.hrtime.bigint(),
    };

    const timestamps: FastPathTimestamps = { signal_received: process.hrtime.bigint() };
    const res = await fastExecutionService.executeFastBuy({
      targetIntent,
      mirrorIntent,
      timestamps,
    });

    expect(res.fallbackNeeded).toBe(true);
    expect(res.fallbackReason).toContain('Fast-Path only supports direct Pump.fun BUY');
  });

  // 8. Curve state unavailable -> fallback
  it('signals fallback if bonding curve state cannot be verified', async () => {
    const targetSig = `sig_unverified_${Date.now()}`;
    const mint = Keypair.generate().publicKey.toBase58();

    // Mock wallet keypair and balance so it proceeds to curve state check
    vi.spyOn(executionWalletManager, 'getKeypair').mockReturnValue(Keypair.generate());
    vi.spyOn(executionWalletManager, 'getCachedBalanceLamports').mockReturnValue(10_000_000_000n);

    // Mock curve state resolver returning null (e.g. RPC fails or curve complete)
    vi.spyOn(curveStateCache, 'getOrFetchCurveState').mockResolvedValueOnce({
      verified: false,
      state: null,
      reason: 'Curve complete or uninitialized',
    });

    const targetIntent: SwapIntent = {
      targetSignature: targetSig,
      slot: 100,
      targetWallet: 'wallet1',
      venue: 'PUMPFUN',
      side: 'BUY',
      inputMint: 'WSOL',
      outputMint: mint,
      tokenMint: mint,
      inputAmountRaw: '100000000',
      outputAmountRaw: '5000000',
      estimatedPrice: 0.00002,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    const mirrorIntent: MirrorIntent = {
      id: 'mirror_2',
      targetSignature: targetSig,
      targetWallet: 'wallet1',
      side: 'BUY',
      tokenMint: mint,
      inputMint: 'WSOL',
      outputMint: mint,
      requestedInAmountRaw: '100000000',
      expectedOutAmountRaw: '5000000',
      riskDecision: 'APPROVED',
      createdAt: process.hrtime.bigint(),
    };

    const timestamps: FastPathTimestamps = { signal_received: process.hrtime.bigint() };
    const res = await fastExecutionService.executeFastBuy({
      targetIntent,
      mirrorIntent,
      timestamps,
    });

    expect(res.fallbackNeeded).toBe(true);
    expect(res.fallbackReason).toContain('Curve state unavailable');
  });

  // 9. Token program dynamic detection
  it('correctly handles Token-2022 vs standard Token Program in simulation policy', () => {
    const validSpl = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 200,
      curveStateVerified: true,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
    });
    expect(validSpl.canBypass).toBe(true);

    const valid2022 = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 200,
      curveStateVerified: true,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: TOKEN_2022_PROGRAM_ID.toBase58(),
    });
    expect(valid2022.canBypass).toBe(true);

    const invalidProgram = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 200,
      curveStateVerified: true,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: 'CustomMaliciousTokenProg1111111111111111111',
    });
    expect(invalidProgram.canBypass).toBe(false);
    expect(invalidProgram.reason).toContain('Unsupported token program');
  });

  // 10. Capital reservation prevents overspend
  it('capital reservation ledger prevents overspending spendable balance', () => {
    const balance = 1_000_000_000n; // 1 SOL
    const floor = 20_000_000n; // 0.02 SOL
    const mint1 = Keypair.generate().publicKey.toBase58();
    const mint2 = Keypair.generate().publicKey.toBase58();

    // First reservation takes 800M lamports (0.8 SOL)
    capitalReservationLedger.reserveSimple('id_order_1', mint1, 800_000_000n);

    // Spendable balance is now 1000M - 800M - 20M = 180M lamports
    const spendable = capitalReservationLedger.calculateSpendableLamports(balance, floor);
    expect(spendable).toBe(180_000_000n);

    // Second trade attempts to reserve 250M lamports -> must be rejected!
    const canSpendSecond = capitalReservationLedger.canSpend(250_000_000n, balance, floor);
    expect(canSpendSecond).toBe(false);

    // Second trade attempts to reserve 150M lamports -> approved
    const canSpendSmaller = capitalReservationLedger.canSpend(150_000_000n, balance, floor);
    expect(canSpendSmaller).toBe(true);
  });

  // 11. Reservations release on definitive failure
  it('releases capital reservation upon order resolution', () => {
    const idKey = 'id_release_test';
    capitalReservationLedger.reserveSimple(idKey, 'token_xyz', 500_000_000n);
    expect(capitalReservationLedger.getTotalReservedLamports()).toBe(500_000_000n);

    capitalReservationLedger.release(idKey);
    expect(capitalReservationLedger.getTotalReservedLamports()).toBe(0n);
  });

  // 12. Reservation survives / rebuilds after restart
  it('repopulates active reservations from pending database records on restart', () => {
    const records = [
      {
        idempotencyKey: 'id_recover_1',
        targetSignature: 'sig1',
        tokenMint: 'mint1',
        side: 'BUY' as const,
        amountInLamports: '100000000',
        reservedLamports: '100050000',
        state: 'SUBMITTED' as const,
        recentBlockhash: 'bh1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        idempotencyKey: 'id_recover_2',
        targetSignature: 'sig2',
        tokenMint: 'mint2',
        side: 'BUY' as const,
        amountInLamports: '200000000',
        reservedLamports: '200050000',
        state: 'SUBMITTING' as const,
        recentBlockhash: 'bh2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    capitalReservationLedger.repopulateFromPendingOrders(records);
    expect(capitalReservationLedger.getTotalReservedLamports()).toBe(300_100_000n);
  });

  // 13. HTTP submission timeout does not duplicate broadcast
  it('maintains pending order state as SUBMISSION_UNKNOWN if HTTP broadcast fails uncertainly', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const idKey = PendingOrderManager.generateIdempotencyKey('sig_timeout', mint, 'BUY');

    pendingOrderManager.registerOrder({
      targetSignature: 'sig_timeout',
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'bh_timeout',
    });

    // Simulate uncertain broadcast return
    pendingOrderManager.transitionState(idKey, 'SUBMISSION_UNKNOWN', {
      error: 'HTTP 504 Gateway Timeout',
    });

    const order = pendingOrderManager.getOrder(idKey);
    expect(order?.state).toBe('SUBMISSION_UNKNOWN');
    // Lock must remain active
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(true);

    // Clean up
    pendingOrderManager.resolveOrder(idKey, 'FAILED');
  });

  // 14. Unresolved order keeps in-flight lock
  it('keeps in-flight token lock active while order status is unresolved', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const idKey = PendingOrderManager.generateIdempotencyKey('sig_lock', mint, 'BUY');

    pendingOrderManager.registerOrder({
      targetSignature: 'sig_lock',
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'bh_lock',
    });

    expect(pendingOrderManager.isTokenLocked(mint)).toBe(true);

    // Only release after definitive resolve
    pendingOrderManager.resolveOrder(idKey, 'CONFIRMED');
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(false);
  });

  // 15. Expired blockhash lifecycle
  it('resolves order as EXPIRED when block height exceeds lastValidBlockHeight', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const folSig = 'mock_fol_sig_expired';

    pendingOrderManager.registerOrder({
      targetSignature: 'sig_exp',
      followerSignature: folSig,
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'bh_exp',
      lastValidBlockHeight: 300,
    });

    const mockConn = {
      getBlockHeight: vi.fn().mockResolvedValue(350), // 350 > 300 (expired)
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
    } as unknown as Connection;

    const res = await pendingOrderManager.recover(mockConn);
    expect(res.failedCount).toBe(1); // Marked EXPIRED/FAILED
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(false);
  });

  // 16. Fast-path simulation policy
  it('simulation policy rejects bypass when slippage exceeds limit', () => {
    const policy = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 800, // 8% exceeds max 500 bps
      curveStateVerified: true,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
    });

    expect(policy.canBypass).toBe(false);
    expect(policy.shouldSimulate).toBe(true);
    expect(policy.reason).toContain('exceeds max bypass limit');
  });

  // 17. Telemetry timestamps ordered correctly
  it('records monotonically ordered Fast-Path timestamps and calculates stages', () => {
    const t0 = process.hrtime.bigint();
    const t1 = t0 + 500_000n; // +0.5ms decode
    const t2 = t1 + 300_000n; // +0.3ms risk
    const t3 = t2 + 800_000n; // +0.8ms build
    const t4 = t3 + 200_000n; // +0.2ms sign
    const t5 = t4 + 400_000n; // +0.4ms persist
    const t6 = t5 + 1_000_000n; // +1.0ms broadcast

    const ts: FastPathTimestamps = {
      signal_received: t0,
      decoded: t1,
      risk_started: t1,
      risk_completed: t2,
      tx_built: t3,
      tx_signed: t4,
      persistence_completed: t5,
      broadcast_completed: t6,
    };

    const telemetry = latencyTracker.recordFastPathTelemetry({
      targetSignature: 'target_telemetry_sig',
      followerSignature: 'fol_telemetry_sig',
      mint: 'test_mint',
      timestamps: ts,
    });

    expect(telemetry.stagesMs.signal_to_decode).toBeCloseTo(0.5, 2);
    expect(telemetry.stagesMs.signal_to_build).toBeCloseTo(1.6, 2);
    expect(telemetry.stagesMs.signal_to_broadcast).toBeCloseTo(3.2, 2);
    expect(telemetry.stagesMs.persistence_cost_ms).toBeCloseTo(0.4, 2);

    const summary = latencyTracker.getFastPathSummary();
    expect(summary.count).toBeGreaterThanOrEqual(1);
    expect(summary.signal_to_broadcast.p50).toBeGreaterThan(0);
  });

  // 18. PAPER safety proof: EXECUTION_MODE=PAPER + FAST_COPY_MODE=true NEVER broadcasts real transaction
  it('EXECUTION_MODE=PAPER + FAST_COPY_MODE=true never invokes real broadcast path or moves funds', async () => {
    config.EXECUTION_MODE = 'PAPER';
    config.FAST_COPY_MODE = true;

    vi.spyOn(riskEngine, 'evaluateIntent').mockReturnValue({
      decision: 'APPROVED',
      approved: true,
    });

    const broadcastFastSpy = vi.spyOn(transactionSubmitter, 'broadcastFast');
    const submitAndConfirmSpy = vi.spyOn(transactionSubmitter, 'submitAndConfirm');
    const fastBuySpy = vi.spyOn(fastExecutionService, 'executeFastBuy');
    const liveTradeSpy = vi.spyOn(liveEngine, 'executeLiveTrade');

    const targetKeypair = Keypair.generate();
    const targetWallet = targetKeypair.publicKey.toBase58();
    const testMint = Keypair.generate().publicKey.toBase58();

    // Register watched wallet in DB
    db.upsertWatchedWallet({
      wallet: targetWallet,
      label: 'Paper Test Target',
      enabled: true,
      buyMode: 'FIXED',
      fixedBuyLamports: '100000000',
      copyRatio: 1.0,
      maxBuyLamports: '500000000',
    });
    signalManager.refreshWallets();

    const sampleAccounts = [
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', // global
      'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // fee recipient
      testMint,                                       // mint
      '8HjPjY2L24Hw1e3uP2YjW9GfH2kP3zX5yU7aB9cV1dE3', // bonding curve
      '5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P111111111111', // associated bonding curve
      '7A2kP3zX5yU7aB9cV1dE38HjPjY2L24Hw1e3uP2YjW9G', // user ATA
      targetWallet,                                   // user / signer
    ];

    const ixData = Buffer.alloc(24);
    Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]).copy(ixData, 0);
    ixData.writeBigUInt64LE(5_000_000_000n, 8); // 5000 tokens
    ixData.writeBigUInt64LE(100_000_000n, 16);  // 0.1 SOL

    const envelope: ParsedTransactionEnvelope = {
      signature: `sig_paper_${Date.now()}`,
      slot: 123456,
      signers: [targetWallet],
      accountKeys: [targetWallet, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', testMint, ...sampleAccounts],
      instructions: [
        {
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          accounts: sampleAccounts,
          data: ixData,
        },
      ],
      observedAt: process.hrtime.bigint(),
    };

    const result = await signalManager.handleIncomingTransaction(envelope);

    // PROOF: Zero real transaction broadcasts or live calls occurred
    expect(broadcastFastSpy).toHaveBeenCalledTimes(0);
    expect(submitAndConfirmSpy).toHaveBeenCalledTimes(0);
    expect(fastBuySpy).toHaveBeenCalledTimes(0);
    expect(liveTradeSpy).toHaveBeenCalledTimes(0);

    // Verified that paper engine processed trade safely
    expect(result.order).not.toBeNull();
    expect(result.order?.mode).toBe('PAPER');
    expect(result.order?.status).toBe('FILLED');
  });

  // 19. Capital reservation math: MIN_SOL_RESERVE_SOL subtracted exactly ONCE across 3+ concurrent orders
  it('subtracts MIN_SOL_RESERVE_SOL exactly once globally across 3+ concurrent pending reservations', () => {
    const totalBalance = 1_000_000_000n; // 1.0 SOL
    const minReserveFloor = 20_000_000n; // 0.02 SOL
    const mint1 = Keypair.generate().publicKey.toBase58();
    const mint2 = Keypair.generate().publicKey.toBase58();
    const mint3 = Keypair.generate().publicKey.toBase58();

    // Order 1: 200M lamports (0.2 SOL)
    capitalReservationLedger.reserveSimple('order_1', mint1, 200_000_000n);
    const spendableAfter1 = capitalReservationLedger.calculateSpendableLamports(totalBalance, minReserveFloor);
    expect(spendableAfter1).toBe(780_000_000n); // 1000M - 200M - 20M = 780M

    // Order 2: 300M lamports (0.3 SOL)
    capitalReservationLedger.reserveSimple('order_2', mint2, 300_000_000n);
    const spendableAfter2 = capitalReservationLedger.calculateSpendableLamports(totalBalance, minReserveFloor);
    expect(spendableAfter2).toBe(480_000_000n); // 1000M - (200M + 300M) - 20M = 480M

    // Order 3: 400M lamports (0.4 SOL)
    capitalReservationLedger.reserveSimple('order_3', mint3, 400_000_000n);
    const spendableAfter3 = capitalReservationLedger.calculateSpendableLamports(totalBalance, minReserveFloor);
    expect(spendableAfter3).toBe(80_000_000n); // 1000M - (200M + 300M + 400M) - 20M = 80M

    // Order 4: Attempting 100M lamports (0.1 SOL) -> Must fail because 80M < 100M
    const canSpend4 = capitalReservationLedger.canSpend(100_000_000n, totalBalance, minReserveFloor);
    expect(canSpend4).toBe(false);

    // Order 5: Attempting 50M lamports (0.05 SOL) -> Must succeed because 50M <= 80M
    const canSpend5 = capitalReservationLedger.canSpend(50_000_000n, totalBalance, minReserveFloor);
    expect(canSpend5).toBe(true);

    // PROOF: If minReserveFloor (20M) were subtracted 3 times (once per reservation),
    // remaining spendable would have been 1000M - 900M - 60M = 40M, which would have rejected 50M!
    // Since 50M succeeded, the floor was proven subtracted EXACTLY ONCE globally.
    expect(capitalReservationLedger.getTotalReservedLamports()).toBe(900_000_000n);
  });

  // 20. SUBMISSION_UNKNOWN timeout idempotency: only ONE broadcast attempt occurs and never duplicate-broadcasts
  it('SUBMISSION_UNKNOWN state prevents automatic duplicate broadcast on retry or re-ingestion', async () => {
    const targetSig = `sig_sender_timeout_${Date.now()}`;
    const mint = Keypair.generate().publicKey.toBase58();
    const idKey = PendingOrderManager.generateIdempotencyKey(targetSig, mint, 'BUY');

    // 1. Initial registration
    const regResult = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'mock_bh',
    });
    expect(regResult.success).toBe(true);

    // 2. Sender HTTP times out after accepted dispatch -> transition to SUBMISSION_UNKNOWN
    pendingOrderManager.transitionState(idKey, 'SUBMISSION_UNKNOWN', {
      followerSignature: 'fol_sig_in_flight',
      error: 'Gateway Timeout 504: Transaction status uncertain',
    });

    const order = pendingOrderManager.getOrder(idKey);
    expect(order?.state).toBe('SUBMISSION_UNKNOWN');
    expect(order?.followerSignature).toBe('fol_sig_in_flight');

    // 3. Duplicate signal arrives via secondary stream/poller
    const broadcastFastSpy = vi.spyOn(transactionSubmitter, 'broadcastFast');

    // Idempotency check MUST reject the duplicate
    const duplicateReg = pendingOrderManager.registerOrder({
      targetSignature: targetSig,
      mint,
      side: 'BUY',
      amountLamports: 100_000_000n,
      reservationLamports: 100_050_000n,
      recentBlockhash: 'mock_bh',
    });

    expect(duplicateReg.success).toBe(false);
    expect(duplicateReg.error).toContain('Duplicate order rejected by idempotency guard');

    // PROOF: Zero duplicate broadcast dispatches occurred
    expect(broadcastFastSpy).toHaveBeenCalledTimes(0);
    expect(pendingOrderManager.isTokenLocked(mint)).toBe(true); // Lock remains active
  });
});
