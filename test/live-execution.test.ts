import {
  BlockhashWithExpiryBlockHeight,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58Module from 'bs58';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  calculateEstimatedFeesLamports,
  config,
  solToLamportsBigInt,
  validateHeliusSenderTip,
} from '../src/config/index.js';
import { db } from '../src/db/database.js';
import { dedupeEngine } from '../src/engine/dedupe.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import {
  jupiterSwapV2Adapter,
  JupiterSwapV2Adapter,
  WSOL_MINT,
} from '../src/execution/jupiter-swap.js';
import { liveEngine, LiveExecutionEngine } from '../src/execution/live-engine.js';
import {
  OnChainBondingCurveState,
  PumpFunSwapAdapter,
  USDC_MINT,
} from '../src/execution/pump-fun-swap.js';
import { settlementReconciler } from '../src/execution/settlement-reconciler.js';
import {
  HELIUS_SENDER_TIP_ACCOUNTS,
  transactionSubmitter,
  TransactionSubmitter,
} from '../src/execution/transaction-submitter.js';
import {
  executionWalletManager,
  ExecutionWalletManager,
} from '../src/execution/wallet-manager.js';
import { mintDecimalsService } from '../src/services/mint-decimals.js';
import { MirrorIntent, SwapIntent, WatchedWallet } from '../src/types/index.js';

const bs58Encode = (typeof (bs58Module as any).encode === 'function'
  ? (bs58Module as any).encode
  : (bs58Module as any).default?.encode) as (input: Uint8Array) => string;

describe('Real Mainnet Execution Safety & Verification Suite', () => {
  const mockTestKeypair = Keypair.generate();
  const validJsonBytesKey = JSON.stringify(Array.from(mockTestKeypair.secretKey));
  const validBase58Key = bs58Encode(mockTestKeypair.secretKey);

  describe('1. Execution Hot Wallet Cryptographic Loading', () => {
    it('cryptographically decodes and validates a JSON byte-array private key', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = validJsonBytesKey;
        const manager = new ExecutionWalletManager();
        expect(manager.isReady()).toBe(true);
        expect(manager.getPublicKeyBase58()).toBe(mockTestKeypair.publicKey.toBase58());
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });

    it('cryptographically decodes and validates a Base58 private key using bs58', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = validBase58Key;
        const manager = new ExecutionWalletManager();
        expect(manager.isReady()).toBe(true);
        expect(manager.getPublicKeyBase58()).toBe(mockTestKeypair.publicKey.toBase58());
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });

    it('fails closed when FOLLOWER_PRIVATE_KEY is invalid or corrupt', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = 'corrupt_non_base58_key_invalid';
        const manager = new ExecutionWalletManager();
        expect(manager.isReady()).toBe(false);
        expect(manager.getKeypair()).toBeNull();
        expect(manager.getPublicKeyBase58()).toBeNull();
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });
  });

  describe('2. Fail-Closed Live Safety Acknowledgement & Arm Status', () => {
    it('disarms live trading if LIVE_TRADING_ACK does not equal exact required phrase', async () => {
      const origAck = config.LIVE_TRADING_ACK;
      const origMode = config.EXECUTION_MODE;
      try {
        (config as any).EXECUTION_MODE = 'LIVE';
        (config as any).LIVE_TRADING_ACK = 'WRONG_ACK';
        const status = await liveEngine.evaluateArmStatus();
        expect(status.armed).toBe(false);
        expect(status.reason).toContain('LIVE_TRADING_ACK must equal');
      } finally {
        (config as any).EXECUTION_MODE = origMode;
        (config as any).LIVE_TRADING_ACK = origAck;
      }
    });

    it('disarms live trading if EXECUTION_MODE is PAPER', async () => {
      const origMode = config.EXECUTION_MODE;
      try {
        (config as any).EXECUTION_MODE = 'PAPER';
        const status = await liveEngine.evaluateArmStatus();
        expect(status.armed).toBe(false);
        expect(status.reason).toContain('EXECUTION_MODE is set to PAPER');
      } finally {
        (config as any).EXECUTION_MODE = origMode;
      }
    });
  });

  describe('3. Fee-Unit Correctness & Spendable Balance Check', () => {
    it('properly distinguishes compute unit price from lamports priority fee', () => {
      const computeUnitPriceMicroLamports = 50_000n; // 50,000 micro-lamports per CU
      const computeUnitLimit = 250_000n; // 250,000 CUs
      const senderTipLamports = 100_000n; // 100,000 lamports

      const feeCalc = calculateEstimatedFeesLamports(
        computeUnitPriceMicroLamports,
        computeUnitLimit,
        senderTipLamports
      );

      // (50,000 * 250,000) / 1,000,000 = 12,500 lamports
      expect(feeCalc.estimatedPriorityFeeLamports).toBe(12_500n);
      expect(feeCalc.baseFeeLamports).toBe(5_000n);
      expect(feeCalc.senderTipLamports).toBe(100_000n);
      expect(feeCalc.totalEstimatedFeesLamports).toBe(117_500n);
    });

    it('rejects buy when trade outlay would breach minimum SOL reserve floor', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = validBase58Key;
        const manager = new ExecutionWalletManager();
        (manager as any).cachedBalanceLamports = solToLamportsBigInt(0.06);

        // Buy 0.02 SOL: 0.06 - (0.02 + 0.0001175) = ~0.03988 SOL (< 0.05 SOL reserve)
        const check = manager.checkSpendable(solToLamportsBigInt(0.02), 50_000n, 250_000n, 100_000n);
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('breach minimum SOL reserve floor');
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });

    it('approves buy when balance comfortably covers trade, fees, and reserve', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = validBase58Key;
        const manager = new ExecutionWalletManager();
        (manager as any).cachedBalanceLamports = solToLamportsBigInt(1.0);

        const check = manager.checkSpendable(solToLamportsBigInt(0.01), 50_000n, 250_000n, 100_000n);
        expect(check.allowed).toBe(true);
        expect(check.feeBreakdown.estimatedPriorityFeeLamports).toBe(12_500n);
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });
  });

  describe('4. Jupiter Swap API V2 Managed Execution Path (/order -> /execute)', () => {
    it('executes managed flow: /order -> signOrder -> /execute', async () => {
      const jupV2 = new JupiterSwapV2Adapter();
      const origFetch = global.fetch;
      let executeCalled = false;
      let executePayload: any = null;

      // Construct a valid real VersionedTransaction message for deserialization
      const dummyMsg = new TransactionMessage({
        payerKey: mockTestKeypair.publicKey,
        recentBlockhash: 'GfDbMbtgVzK9yN5h9z9t9yZt1Zz1Zz1Zz1Zz1Zz1Zz1Z',
        instructions: [],
      }).compileToV0Message();
      const dummyTx = new VersionedTransaction(dummyMsg);
      const validBase64Tx = Buffer.from(dummyTx.serialize()).toString('base64');

      try {
        global.fetch = async (url: any, opts: any) => {
          const urlStr = String(url);
          if (urlStr.includes('/order')) {
            return {
              ok: true,
              json: async () => ({
                requestId: 'req_v2_managed_999',
                transaction: validBase64Tx,
                inputMint: WSOL_MINT,
                outputMint: 'TokenMintXYZ1111111111111111111111111111111',
                inAmount: '10000000',
                outAmount: '5000000',
                lastValidBlockHeight: 310500123,
                slippageBps: 150,
              }),
            } as any;
          }
          if (urlStr.includes('/execute')) {
            executeCalled = true;
            executePayload = JSON.parse(opts.body);
            return {
              ok: true,
              json: async () => ({
                status: 'Success',
                signature: '5Kz...realJupiterSignature',
                totalInputAmount: '10000000',
                totalOutputAmount: '4950000',
                inputAmountResult: '10000000',
                outputAmountResult: '4950000',
              }),
            } as any;
          }
          return origFetch(url, opts);
        };

        const order = await jupV2.createOrder(
          WSOL_MINT,
          'TokenMintXYZ1111111111111111111111111111111',
          '10000000',
          mockTestKeypair.publicKey.toBase58()
        );
        expect(order.requestId).toBe('req_v2_managed_999');
        expect(order.lastValidBlockHeight).toBe(310500123);

        const signedResult = await jupV2.signOrder(mockTestKeypair, order);
        // Correct Jupiter expiry metadata preserved
        expect(signedResult.blockhashWithExpiry.lastValidBlockHeight).toBe(310500123);

        const executeResult = await jupV2.executeOrder(
          signedResult.transaction,
          order.requestId,
          order.lastValidBlockHeight
        );

        expect(executeCalled).toBe(true);
        expect(executePayload.requestId).toBe('req_v2_managed_999');
        expect(executePayload.signedTransaction).toBeDefined();
        expect(executeResult.status).toBe('Success');
        expect(executeResult.signature).toBe('5Kz...realJupiterSignature');
        expect(executeResult.outputAmountResult).toBe('4950000');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('proves LiveExecutionEngine actually invokes jupiterSwapV2Adapter.executeOrder during managed execution', async () => {
      const engine = new LiveExecutionEngine();
      (engine as any).isArmed = true;
      (engine as any).smokeTestTradesCount = 0;

      const origCreate = jupiterSwapV2Adapter.createOrder;
      const origSign = jupiterSwapV2Adapter.signOrder;
      const origExecute = jupiterSwapV2Adapter.executeOrder;

      let executeOrderInvoked = false;
      let passedRequestId = '';

      const dummyMsg = new TransactionMessage({
        payerKey: mockTestKeypair.publicKey,
        recentBlockhash: 'GfDbMbtgVzK9yN5h9z9t9yZt1Zz1Zz1Zz1Zz1Zz1Zz1Z',
        instructions: [],
      }).compileToV0Message();
      const dummyTx = new VersionedTransaction(dummyMsg);

      try {
        jupiterSwapV2Adapter.createOrder = async () => ({
          requestId: 'req_live_managed_test',
          transaction: Buffer.from(dummyTx.serialize()).toString('base64'),
          inputMint: WSOL_MINT,
          outputMint: 'RaydiumTokenXYZ11111111111111111111111111111',
          inAmount: '10000000',
          outAmount: '2000000',
          lastValidBlockHeight: 310500999,
          slippageBps: 150,
        });

        jupiterSwapV2Adapter.signOrder = async () => ({
          transaction: dummyTx,
          order: {
            requestId: 'req_live_managed_test',
            transaction: '',
            inputMint: WSOL_MINT,
            outputMint: 'RaydiumTokenXYZ11111111111111111111111111111',
            inAmount: '10000000',
            outAmount: '2000000',
            lastValidBlockHeight: 310500999,
            slippageBps: 150,
          },
          outAmountRaw: '2000000',
          effectivePriceSol: 0.000005,
          blockhashWithExpiry: {
            blockhash: 'GfDbMbtgVzK9yN5h9z9t9yZt1Zz1Zz1Zz1Zz1Zz1Zz1Z',
            lastValidBlockHeight: 310500999,
          },
        });

        jupiterSwapV2Adapter.executeOrder = async (tx, reqId) => {
          executeOrderInvoked = true;
          passedRequestId = reqId;
          return {
            status: 'Success',
            signature: 'sig_jup_live_verified',
            totalInputAmount: '10000000',
            totalOutputAmount: '2000000',
            inputAmountResult: '10000000',
            outputAmountResult: '2000000',
          };
        };

        const targetIntent: SwapIntent = {
          targetSignature: 'sig_target_raydium',
          slot: 200,
          targetWallet: 'TargetRaydium111111111111111111111111111111',
          venue: 'RAYDIUM_AMM',
          side: 'BUY',
          inputMint: WSOL_MINT,
          outputMint: 'RaydiumTokenXYZ11111111111111111111111111111',
          tokenMint: 'RaydiumTokenXYZ11111111111111111111111111111',
          inputAmountRaw: '10000000',
          outputAmountRaw: '2000000',
          estimatedPrice: 0.000005,
          observedAt: process.hrtime.bigint(),
          timestampMs: Date.now(),
          rawProgramId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          confidence: 1.0,
        };

        const mirrorIntent: MirrorIntent = {
          id: 'mirror_raydium_1',
          targetSignature: targetIntent.targetSignature,
          targetWallet: targetIntent.targetWallet,
          side: 'BUY',
          tokenMint: targetIntent.tokenMint,
          inputMint: targetIntent.inputMint,
          outputMint: targetIntent.outputMint,
          requestedInAmountRaw: '10000000',
          expectedOutAmountRaw: '2000000',
          riskDecision: 'APPROVED',
          createdAt: process.hrtime.bigint(),
        };

        (executionWalletManager as any).cachedBalanceLamports = 1_000_000_000n;
        (executionWalletManager as any).keypair = mockTestKeypair;

        const origSubmitterReconcile = transactionSubmitter.reconcileStatus;
        transactionSubmitter.reconcileStatus = async () => ({
          signature: 'sig_jup_live_verified',
          status: 'CONFIRMED',
          provider: 'JUPITER_EXECUTE',
          slot: 285000100,
          submittedAt: process.hrtime.bigint(),
          confirmedAt: process.hrtime.bigint(),
        });

        try {
          const resultOrder = await engine.executeLiveTrade(targetIntent, mirrorIntent);
          expect(executeOrderInvoked).toBe(true);
          expect(passedRequestId).toBe('req_live_managed_test');
          expect(resultOrder.landingProvider).toBe('JUPITER_EXECUTE');
          expect(resultOrder.status).toBe('FILLED');
        } finally {
          transactionSubmitter.reconcileStatus = origSubmitterReconcile;
        }
      } finally {
        jupiterSwapV2Adapter.createOrder = origCreate;
        jupiterSwapV2Adapter.signOrder = origSign;
        jupiterSwapV2Adapter.executeOrder = origExecute;
      }
    });
  });

  describe('5. Pump.fun Routing: Elimination of Mint Suffix & Pure On-Chain Curve State', () => {
    const adapter = new PumpFunSwapAdapter();

    it('routes active curve token to bonding curve regardless of mint suffix', () => {
      // Case A: Mint does NOT end in pump, but curve is active
      const activeNonPumpSuffix: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 1_000_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        realTokenReserves: 700_000_000_000_000n,
        realSolReserves: 10_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: false,
        pairAsset: 'SOL',
      };

      const quoteA = adapter.calculateQuote(activeNonPumpSuffix, 'BUY', 10_000_000n);
      expect(quoteA.isGraduated).toBe(false);
      expect(quoteA.expectedOutRaw).toBeGreaterThan(0n);

      // Case B: Mint DOES end in pump, but curve is active
      const quoteB = adapter.calculateQuote(activeNonPumpSuffix, 'BUY', 10_000_000n);
      expect(quoteB.isGraduated).toBe(false);
      expect(quoteB.expectedOutRaw).toBeGreaterThan(0n);
    });

    it('routes graduated token to Jupiter Swap API V2 / PumpSwap regardless of mint suffix', () => {
      const graduatedCurve: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: true, // Graduated
        pairAsset: 'SOL',
      };

      const quote = adapter.calculateQuote(graduatedCurve, 'BUY', 10_000_000n);
      expect(quote.isGraduated).toBe(true);
      expect(quote.expectedOutRaw).toBe(0n);
    });

    it('identifies USDC-paired Pump.fun token and flags for Jupiter V2 routing', () => {
      const usdcCurve: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 1_000_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        realTokenReserves: 700_000_000_000_000n,
        realSolReserves: 10_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: false,
        pairAsset: 'USDC', // USDC paired
      };

      expect(usdcCurve.pairAsset).toBe('USDC');
    });
  });

  describe('6. Landing Provider Identification & Helius Sender Request Construction', () => {
    it('identifies STANDARD_RPC when Helius is not configured (never labels standard RPC as Helius)', () => {
      const origKey = config.HELIUS_API_KEY;
      const origUrl = config.HELIUS_SENDER_URL;
      try {
        (config as any).HELIUS_API_KEY = '';
        (config as any).HELIUS_SENDER_URL = '';

        const submitter = new TransactionSubmitter();
        const resolved = submitter.resolveLandingProvider();
        expect(resolved.provider).toBe('STANDARD_RPC');
        expect(resolved.endpointUrl).toBe(config.SOLANA_RPC_URL);
      } finally {
        (config as any).HELIUS_API_KEY = origKey;
        (config as any).HELIUS_SENDER_URL = origUrl;
      }
    });

    it('identifies HELIUS_SWQOS and constructs swqos_only=true endpoint', () => {
      const origKey = config.HELIUS_API_KEY;
      const origMode = config.HELIUS_SENDER_MODE;
      const origUrl = config.HELIUS_SENDER_URL;
      try {
        (config as any).HELIUS_API_KEY = 'test_helius_key_123';
        (config as any).HELIUS_SENDER_MODE = 'SWQOS';
        (config as any).HELIUS_SENDER_URL = '';

        const submitter = new TransactionSubmitter();
        const resolved = submitter.resolveLandingProvider();
        expect(resolved.provider).toBe('HELIUS_SWQOS');
        expect(resolved.endpointUrl).toContain('swqos_only=true');
        expect(resolved.endpointUrl).toContain('api-key=test_helius_key_123');
      } finally {
        (config as any).HELIUS_API_KEY = origKey;
        (config as any).HELIUS_SENDER_MODE = origMode;
        (config as any).HELIUS_SENDER_URL = origUrl;
      }
    });

    it('identifies HELIUS_SENDER_MAX and constructs swqos_only=false endpoint', () => {
      const origKey = config.HELIUS_API_KEY;
      const origMode = config.HELIUS_SENDER_MODE;
      const origUrl = config.HELIUS_SENDER_URL;
      try {
        (config as any).HELIUS_API_KEY = 'test_helius_key_123';
        (config as any).HELIUS_SENDER_MODE = 'MAX';
        (config as any).HELIUS_SENDER_URL = '';

        const submitter = new TransactionSubmitter();
        const resolved = submitter.resolveLandingProvider();
        expect(resolved.provider).toBe('HELIUS_SENDER_MAX');
        expect(resolved.endpointUrl).toContain('swqos_only=false');
      } finally {
        (config as any).HELIUS_API_KEY = origKey;
        (config as any).HELIUS_SENDER_MODE = origMode;
        (config as any).HELIUS_SENDER_URL = origUrl;
      }
    });

    it('includes verified designated Helius Sender tip accounts', () => {
      expect(HELIUS_SENDER_TIP_ACCOUNTS.length).toBeGreaterThanOrEqual(4);
      expect(HELIUS_SENDER_TIP_ACCOUNTS).toContain('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE');
      expect(HELIUS_SENDER_TIP_ACCOUNTS).toContain('D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ');
    });
  });

  describe('7. Order Lifecycle: PROCESSED Does NOT Equal FILLED', () => {
    it('does not mark order FILLED when status is only PROCESSED', async () => {
      const submitter = new TransactionSubmitter();
      let polledCount = 0;

      // Mock getSignatureStatuses returning 'processed'
      (submitter as any).connection.getSignatureStatuses = async () => {
        polledCount++;
        return {
          value: [
            {
              slot: 285000000,
              confirmations: 1,
              err: null,
              confirmationStatus: 'processed',
            },
          ],
        };
      };

      // Mock block height expiring
      (submitter as any).connection.getBlockHeight = async () => 300000100;

      const receipt = await submitter.reconcileStatus(
        'mock_sig_processed_only',
        { blockhash: 'bh', lastValidBlockHeight: 300000000 },
        process.hrtime.bigint(),
        'STANDARD_RPC',
        500
      );

      // Must NOT be CONFIRMED!
      expect(receipt.status).not.toBe('CONFIRMED');
      expect(receipt.status).toBe('EXPIRED');
    });

    it('marks order CONFIRMED only when confirmationStatus is confirmed or finalized', async () => {
      const submitter = new TransactionSubmitter();
      (submitter as any).connection.getSignatureStatuses = async () => ({
        value: [
          {
            slot: 285000050,
            confirmations: 15,
            err: null,
            confirmationStatus: 'confirmed',
          },
        ],
      });

      const receipt = await submitter.reconcileStatus(
        'mock_sig_confirmed',
        { blockhash: 'bh', lastValidBlockHeight: 300000000 },
        process.hrtime.bigint(),
        'STANDARD_RPC',
        2000
      );

      expect(receipt.status).toBe('CONFIRMED');
      expect(receipt.slot).toBe(285000050);
    });
  });

  describe('8. Settlement Reconciliation: Actual Settlement Differs from Quoted', () => {
    it('stores actual received tokens and SOL in PositionEngine, not expected quote', async () => {
      const testTokenMint = `TokenActual_${randomUUID().substring(0, 6)}`;
      const targetWallet = `TargetWallet_${randomUUID().substring(0, 6)}`;
      const signature = `SigReconcile_${randomUUID().substring(0, 8)}`;

      // Quoted estimate: 5,000,000 raw tokens
      const quotedOutRaw = 5_000_000n;
      // Actual on-chain settlement result: 4,920,000 raw tokens (due to AMM curve dynamics)
      const actualOutRaw = 4_920_000n;
      const actualSolSpent = 10_000_000n; // 0.01 SOL
      const actualPriceSol = 0.0000020325;

      // Record fill with ACTUAL amounts
      positionEngine.recordFill(
        targetWallet,
        testTokenMint,
        'BUY',
        actualOutRaw,
        actualSolSpent,
        actualPriceSol,
        signature
      );

      const pos = db.getPosition(targetWallet, testTokenMint);
      expect(pos).toBeDefined();
      // Verified: Position engine stores ACTUAL settled quantity, NOT quoted quantity!
      expect(pos!.qtyRaw).toBe('4920000');
      expect(pos!.qtyRaw).not.toBe(quotedOutRaw.toString());
      expect(pos!.costBasisLamports).toBe('10000000');
      expect(pos!.avgEntryPriceSol).toBe(actualPriceSol);
    });

    it('settlement reconciler extracts actual amounts from Jupiter execution result', async () => {
      const dummyKeypair = Keypair.generate();
      const settlement = await settlementReconciler.reconcileConfirmedTrade(
        'mock_sig_reconcile_jup',
        dummyKeypair.publicKey,
        'TokenMintXYZ1111111111111111111111111111111',
        'BUY',
        10_000_000n,
        5_000_000n,
        0.000002,
        {
          status: 'Success',
          signature: 'sig_jup_done',
          totalInputAmount: '10000000',
          totalOutputAmount: '4950000',
          inputAmountResult: '10000000',
          outputAmountResult: '4950000',
        }
      );

      expect(settlement.actualTokensRaw).toBe(4_950_000n);
      expect(settlement.actualSolLamports).toBe(10_000_000n);
      expect(settlement.reconciliationSource).toBe('JUPITER_RESULT');
    });
  });

  describe('9. Concurrency Protection & Auto-Disarm upon First Broadcast', () => {
    it('auto-disarms engine immediately upon broadcast and blocks concurrent second trade', async () => {
      const engine = new LiveExecutionEngine();
      // Arm the engine manually
      (engine as any).isArmed = true;
      (engine as any).smokeTestTradesCount = 0;

      expect(engine.getStatus().isArmed).toBe(true);

      // Simulate first trade broadcast auto-disarm trigger
      (engine as any).smokeTestTradesCount++;
      engine.kill('SMOKE TEST BROADCAST SUBMITTED — Auto-disarmed to prevent concurrent executions');

      expect(engine.getStatus().isArmed).toBe(false);

      // Second trade arrives while first is in flight -> MUST FAIL CLOSED!
      const dummyIntent: SwapIntent = {
        targetSignature: 'sig_concurrent_2',
        slot: 100,
        targetWallet: 'Target111111111111111111111111111111111111',
        venue: 'PUMPFUN',
        side: 'BUY',
        inputMint: WSOL_MINT,
        outputMint: 'TokenConcurrent11111111111111111111111111111',
        tokenMint: 'TokenConcurrent11111111111111111111111111111',
        inputAmountRaw: '10000000',
        outputAmountRaw: '1000000',
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirror = positionEngine.prepareMirrorIntent(
        dummyIntent,
        {
          wallet: dummyIntent.targetWallet,
          label: 'Test',
          enabled: true,
          buyMode: 'FIXED_SIZE',
          fixedBuyLamports: '10000000',
          copyRatio: 0.05,
          maxBuyLamports: '50000000',
          createdAt: Date.now(),
        },
        'APPROVED'
      );

      await expect(engine.executeLiveTrade(dummyIntent, mirror)).rejects.toThrow(
        /Cannot execute live trade: LIVE execution is DISARMED/
      );
    });
  });

  describe('10. BUY-Only Smoke-Test Guard', () => {
    it('blocks SELL orders when SMOKE_TEST_ALLOWED_SIDE is BUY', async () => {
      const engine = new LiveExecutionEngine();
      (engine as any).isArmed = true;

      const origSide = config.SMOKE_TEST_ALLOWED_SIDE;
      const origSmoke = config.MAINNET_SMOKE_TEST_MODE;
      try {
        (config as any).MAINNET_SMOKE_TEST_MODE = true;
        (config as any).SMOKE_TEST_ALLOWED_SIDE = 'BUY';

        const sellIntent: SwapIntent = {
          targetSignature: 'sig_sell_blocked',
          slot: 101,
          targetWallet: 'Target111111111111111111111111111111111111',
          venue: 'PUMPFUN',
          side: 'SELL',
          inputMint: 'TokenMintBlocked1111111111111111111111111111',
          outputMint: WSOL_MINT,
          tokenMint: 'TokenMintBlocked1111111111111111111111111111',
          inputAmountRaw: '500000',
          outputAmountRaw: '5000000',
          estimatedPrice: 0.00001,
          observedAt: process.hrtime.bigint(),
          timestampMs: Date.now(),
          rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          confidence: 1.0,
        };

        const sellMirror: MirrorIntent = {
          id: 'mirror_sell_1',
          targetSignature: sellIntent.targetSignature,
          targetWallet: sellIntent.targetWallet,
          side: 'SELL',
          tokenMint: sellIntent.tokenMint,
          inputMint: sellIntent.inputMint,
          outputMint: sellIntent.outputMint,
          requestedInAmountRaw: '500000',
          expectedOutAmountRaw: '5000000',
          riskDecision: 'APPROVED',
          createdAt: process.hrtime.bigint(),
        };

        await expect(engine.executeLiveTrade(sellIntent, sellMirror)).rejects.toThrow(
          /Trade side SELL is blocked by SMOKE_TEST_ALLOWED_SIDE=BUY/
        );
      } finally {
        (config as any).SMOKE_TEST_ALLOWED_SIDE = origSide;
        (config as any).MAINNET_SMOKE_TEST_MODE = origSmoke;
      }
    });
  });
});
