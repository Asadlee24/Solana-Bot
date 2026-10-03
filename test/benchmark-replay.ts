import { Keypair, PublicKey } from '@solana/web3.js';
import { FastTransactionDecoder, ParsedTransactionEnvelope } from '../src/parsers/fast-decoder.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { fastPumpBuilder } from '../src/execution/fast-pump-builder.js';
import { FastSimulationPolicy } from '../src/execution/fast-simulation-policy.js';
import { capitalReservationLedger } from '../src/services/capital-reservation.js';
import { curveStateCache } from '../src/services/curve-state-cache.js';
import { blockhashService } from '../src/execution/blockhash-service.js';
import { PendingOrderManager, pendingOrderManager } from '../src/engine/pending-order-manager.js';
import { WatchedWallet } from '../src/types/index.js';
import { db } from '../src/db/database.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    p50: Number(percentile(sorted, 0.5).toFixed(3)),
    p90: Number(percentile(sorted, 0.9).toFixed(3)),
    p95: Number(percentile(sorted, 0.95).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3)),
  };
}

export async function runBenchmark(sampleCount: number = 50) {
  console.log(`\n============================================================`);
  console.log(`⚡ FIRST-TX FAST PATH LOCAL REPLAY BENCHMARK (N = ${sampleCount}) ⚡`);
  console.log(`============================================================\n`);

  const targetKeypair = Keypair.generate();
  const targetWallet = targetKeypair.publicKey.toBase58();
  const followerKeypair = Keypair.generate();

  const walletConfig: WatchedWallet = {
    wallet: targetWallet,
    label: 'Target VIP',
    enabled: true,
    buyMode: 'FIXED',
    fixedBuyLamports: '100000000', // 0.1 SOL
    copyRatio: 1.0,
    maxBuyLamports: '500000000',
  };

  // Seed sample curve state
  const testMintKeypair = Keypair.generate();
  const testMint = testMintKeypair.publicKey.toBase58();
  curveStateCache.registerState(testMint, {
    virtualTokenReserves: 1_000_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realSolReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    pairAsset: 'SOL',
    isInitialized: true,
  });

  const normalLatenciesMs: number[] = [];
  const fastLatenciesMs: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const targetSig = `mock_bench_target_sig_${i}_${Date.now()}_${Math.random()}`;

    // Construct realistic ParsedTransactionEnvelope as delivered by stream
    const envelope: ParsedTransactionEnvelope = {
      signature: targetSig,
      slot: 312000000 + i,
      signers: [targetWallet],
      accountKeys: [
        targetWallet,
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        testMint,
        '11111111111111111111111111111111',
      ],
      instructions: [
        {
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          accounts: [
            '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', // global
            'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // fee recipient
            testMint,
            '8HjPjY2L24Hw1e3uP2YjW9GfH2kP3zX5yU7aB9cV1dE3', // bonding curve
            '5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P111111111111', // associated bonding curve
            '7A2kP3zX5yU7aB9cV1dE38HjPjY2L24Hw1e3uP2YjW9G', // user ATA
            targetWallet,
            '11111111111111111111111111111111',
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            'SysvarRent111111111111111111111111111111111',
            'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasJJL7Xx8EQinn',
            '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          ],
          data: Buffer.concat([
            Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]),
            Buffer.from('00e1f50500000000', 'hex'), // amount
            Buffer.from('00e40b5402000000', 'hex'), // max_sol_cost
          ]),
        },
      ],
      observedAt: process.hrtime.bigint(),
    };

    // ========================================================
    // PATH A: Normal / Unoptimized Path Measurement
    // ========================================================
    const t0Normal = process.hrtime.bigint();
    // 1. Decode transaction
    const normalIntent = FastTransactionDecoder.decodeTransaction(envelope, targetWallet);
    // 2. Risk check
    const normalRisk = riskEngine.evaluateIntent(
      normalIntent!,
      10_000_000_000n,
      0n
    );
    // 3. Prepare mirror intent
    const normalMirror = positionEngine.prepareMirrorIntent(
      normalIntent!,
      walletConfig,
      normalRisk.decision,
      normalRisk.reason
    );
    // 4. Normal blockhash fetch simulation + standard build
    await blockhashService.getLatestBlockhash();
    // 5. In normal mode, simulation runs via simulateTransaction (modelled by 2ms process overhead)
    const t1Normal = process.hrtime.bigint();
    const normalDurationMs = Number(t1Normal - t0Normal) / 1_000_000;
    normalLatenciesMs.push(normalDurationMs);

    // ========================================================
    // PATH B: FAST_COPY_MODE Path Measurement
    // ========================================================
    const t0Fast = process.hrtime.bigint();
    // 1. Direct decode from stream
    const fastIntent = FastTransactionDecoder.decodeTransaction(envelope, targetWallet);
    // 2. In-memory capital reservation check
    const canSpend = capitalReservationLedger.canSpend(
      100_000_000n,
      10_000_000_000n,
      20_000_000n
    );
    // 3. Curve state cache lookup (sub-microsecond memory hit)
    const curveRes = await curveStateCache.getOrFetchCurveState(testMint, envelope);
    // 4. Fast simulation policy check
    const simPolicy = FastSimulationPolicy.evaluateBypass({
      venue: 'PUMPFUN',
      side: 'BUY',
      slippageBps: 200,
      curveStateVerified: curveRes.verified,
      accountsValid: true,
      templateKnown: true,
      tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    });
    // 5. Fast in-memory transaction build and synchronous keypair sign
    const fastBuild = await fastPumpBuilder.buildFastBuy(
      followerKeypair,
      testMint,
      100_000_000n,
      curveRes.state!,
      200
    );
    // 6. Pre-broadcast idempotency registration
    const idKey = PendingOrderManager.generateIdempotencyKey(envelope.signature, testMint, 'BUY');
    capitalReservationLedger.reserveSimple(idKey, testMint, 100_050_000n, targetWallet);
    // 7. Ready for non-blocking broadcast
    const t1Fast = process.hrtime.bigint();
    const fastDurationMs = Number(t1Fast - t0Fast) / 1_000_000;
    fastLatenciesMs.push(fastDurationMs);

    // Cleanup reservation for next iteration
    capitalReservationLedger.release(idKey);
  }

  const normalStats = stats(normalLatenciesMs);
  const fastStats = stats(fastLatenciesMs);

  console.log('--- PATH A: Normal / Unoptimized Processing Time (Signal -> Tx Ready) ---');
  console.table(normalStats);

  console.log('\n--- PATH B: FAST_COPY_MODE In-Memory Processing Time (Signal -> Broadcast Dispatch) ---');
  console.table(fastStats);

  const speedupP50 = (normalStats.p50 / fastStats.p50).toFixed(2);
  const speedupP95 = (normalStats.p95 / fastStats.p95).toFixed(2);

  console.log(`\n🚀 MEASURED LOCAL ACCELERATION:`);
  console.log(`- p50 Latency:  ${normalStats.p50} ms -> ${fastStats.p50} ms (${speedupP50}x faster)`);
  console.log(`- p95 Latency:  ${normalStats.p95} ms -> ${fastStats.p95} ms (${speedupP95}x faster)`);
  console.log(`- Min/Max Fast: ${fastStats.min} ms / ${fastStats.max} ms`);

  return { normalStats, fastStats, speedupP50, speedupP95 };
}

runBenchmark(100).catch(console.error);
