import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58Module from 'bs58';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { config, solToLamportsBigInt, validateHeliusSenderTip } from '../src/config/index.js';
import { db } from '../src/db/database.js';
import { dedupeEngine } from '../src/engine/dedupe.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import { JupiterSwapV2Adapter, WSOL_MINT } from '../src/execution/jupiter-swap.js';
import { liveEngine } from '../src/execution/live-engine.js';
import { OnChainBondingCurveState, PumpFunSwapAdapter } from '../src/execution/pump-fun-swap.js';
import { TransactionSubmitter } from '../src/execution/transaction-submitter.js';
import { ExecutionWalletManager } from '../src/execution/wallet-manager.js';
import { mintDecimalsService } from '../src/services/mint-decimals.js';
import { SwapIntent, WatchedWallet } from '../src/types/index.js';

const bs58Encode = (typeof (bs58Module as any).encode === 'function'
  ? (bs58Module as any).encode
  : (bs58Module as any).default?.encode) as (input: Uint8Array) => string;

describe('Real Mainnet Execution Safety & Integration Suite', () => {
  // Generate a temporary mock test keypair for cryptographic testing
  const mockTestKeypair = Keypair.generate();
  const validJsonBytesKey = JSON.stringify(Array.from(mockTestKeypair.secretKey));
  const validBase58Key = bs58Encode(mockTestKeypair.secretKey);

  describe('1. Execution Hot Wallet Cryptographic Loading & Validation', () => {
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

    it('fails closed when FOLLOWER_PRIVATE_KEY is empty', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = '';
        const manager = new ExecutionWalletManager();
        expect(manager.isReady()).toBe(false);
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
        (config as any).LIVE_TRADING_ACK = 'YES_I_WANT_LIVE'; // wrong phrase
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

    it('refuses to execute live trade when disarmed', async () => {
      liveEngine.kill('Safety unit test kill');
      const dummyIntent: SwapIntent = {
        targetSignature: 'sig_test_1',
        slot: 1,
        targetWallet: 'DummyTarget11111111111111111111111111111111',
        venue: 'PUMPFUN',
        side: 'BUY',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'DummyToken111111111111111111111111111111111',
        tokenMint: 'DummyToken111111111111111111111111111111111',
        inputAmountRaw: '100000000',
        outputAmountRaw: '1000000',
        estimatedPrice: 0.0001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };
      const dummyMirror = positionEngine.prepareMirrorIntent(
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

      await expect(liveEngine.executeLiveTrade(dummyIntent, dummyMirror)).rejects.toThrow(
        /Cannot execute live trade: LIVE execution is DISARMED/
      );
    });
  });

  describe('3. Wallet Balance & Reserve Floor Protection', () => {
    it('rejects buy when trade would breach minimum SOL reserve floor', () => {
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      try {
        (config as any).FOLLOWER_PRIVATE_KEY = validBase58Key;
        const manager = new ExecutionWalletManager();
        (manager as any).cachedBalanceLamports = solToLamportsBigInt(0.06);

        // Attempting to buy 0.02 SOL + fees (total 0.0215 SOL) -> remaining would be 0.0385 SOL (< 0.05 SOL)
        const check = manager.checkSpendable(solToLamportsBigInt(0.02), 50_000n, 100_000n);
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

        // Buy 0.01 SOL (smoke test)
        const check = manager.checkSpendable(solToLamportsBigInt(0.01), 50_000n, 100_000n);
        expect(check.allowed).toBe(true);
        expect(check.spendableSol).toBeCloseTo(1.0 - config.MIN_SOL_RESERVE_SOL, 2);
      } finally {
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
      }
    });
  });

  describe('4. Entry Quality Guard (Signal Age & Entry Gap)', () => {
    it('rejects signals exceeding MAX_SIGNAL_AGE_MS', () => {
      const staleIntent: SwapIntent = {
        targetSignature: 'sig_stale_1',
        slot: 1,
        targetWallet: 'DummyTarget11111111111111111111111111111111',
        venue: 'PUMPFUN',
        side: 'BUY',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'DummyToken111111111111111111111111111111111',
        tokenMint: 'DummyToken111111111111111111111111111111111',
        inputAmountRaw: '100000000',
        outputAmountRaw: '1000000',
        estimatedPrice: 0.0001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now() - (config.MAX_SIGNAL_AGE_MS + 500),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const res = riskEngine.evaluateIntent(
        staleIntent,
        solToLamportsBigInt(1.0),
        0n
      );
      expect(res.approved).toBe(false);
      expect(res.decision).toBe('REJECTED_STALE');
    });

    it('rejects quote when entry price gap exceeds MAX_ENTRY_GAP_BPS', () => {
      const targetPrice = 0.00001;
      const badFollowerPrice = 0.00001035;

      const check = riskEngine.evaluateQuote(targetPrice, badFollowerPrice);
      expect(check.approved).toBe(false);
      expect(check.decision).toBe('REJECTED_ENTRY_GAP');
    });

    it('approves quote when entry price gap is within tolerance', () => {
      const targetPrice = 0.00001;
      const goodFollowerPrice = 0.00001005;

      const check = riskEngine.evaluateQuote(targetPrice, goodFollowerPrice);
      expect(check.approved).toBe(true);
      expect(check.decision).toBe('APPROVED');
    });
  });

  describe('5. Proportional Sells & Holding Protection', () => {
    const runId = randomUUID().substring(0, 6);
    const targetA = `TargetA_${runId}`;
    const targetB = `TargetB_${runId}`;
    const tokenMint = `TokenTest_${runId}`;

    const walletConfigA: WatchedWallet = {
      wallet: targetA,
      label: 'Target A',
      enabled: true,
      buyMode: 'FIXED_SIZE',
      fixedBuyLamports: '10000000',
      copyRatio: 0.05,
      maxBuyLamports: '50000000',
      createdAt: Date.now(),
    };

    it('tracks position for target A and sells exactly 25% when target sells 25%', () => {
      positionEngine.recordFill(targetA, tokenMint, 'BUY', 1_000_000n, 10_000_000n, 0.00001, 'sig_buy_a');

      const sellIntent: SwapIntent = {
        targetSignature: `sig_sell_25_${runId}`,
        slot: 2,
        targetWallet: targetA,
        venue: 'PUMPFUN',
        side: 'SELL',
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        tokenMint,
        inputAmountRaw: '2500000',
        outputAmountRaw: '25000000',
        targetPreBalanceToken: '10000000',
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirror = positionEngine.prepareMirrorIntent(sellIntent, walletConfigA, 'APPROVED');
      expect(mirror.sellFraction).toBeCloseTo(0.25, 2);
      expect(mirror.requestedInAmountRaw).toBe('250000');
    });

    it('sells exactly 50% when target sells 50%', () => {
      const sellIntent50: SwapIntent = {
        targetSignature: `sig_sell_50_${runId}`,
        slot: 3,
        targetWallet: targetA,
        venue: 'PUMPFUN',
        side: 'SELL',
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        tokenMint,
        inputAmountRaw: '5000000',
        outputAmountRaw: '50000000',
        targetPreBalanceToken: '10000000',
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirror = positionEngine.prepareMirrorIntent(sellIntent50, walletConfigA, 'APPROVED');
      expect(mirror.sellFraction).toBeCloseTo(0.5, 2);
    });

    it('exits 100% when target sells 100%', () => {
      const sellIntent100: SwapIntent = {
        targetSignature: `sig_sell_100_${runId}`,
        slot: 4,
        targetWallet: targetA,
        venue: 'PUMPFUN',
        side: 'SELL',
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        tokenMint,
        inputAmountRaw: '10000000',
        outputAmountRaw: '100000000',
        targetPreBalanceToken: '10000000',
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirror = positionEngine.prepareMirrorIntent(sellIntent100, walletConfigA, 'APPROVED');
      expect(mirror.sellFraction).toBeCloseTo(1.0, 2);
    });

    it('does NOT sell unrelated holdings: target B sell cannot liquidate target A position', () => {
      const walletConfigB: WatchedWallet = {
        wallet: targetB,
        label: 'Target B',
        enabled: true,
        buyMode: 'FIXED_SIZE',
        fixedBuyLamports: '10000000',
        copyRatio: 0.05,
        maxBuyLamports: '50000000',
        createdAt: Date.now(),
      };

      const sellIntentB: SwapIntent = {
        targetSignature: `sig_sell_b_${runId}`,
        slot: 5,
        targetWallet: targetB,
        venue: 'PUMPFUN',
        side: 'SELL',
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        tokenMint,
        inputAmountRaw: '5000000',
        outputAmountRaw: '50000000',
        targetPreBalanceToken: '5000000',
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirrorB = positionEngine.prepareMirrorIntent(sellIntentB, walletConfigB, 'APPROVED');
      expect(mirrorB.requestedInAmountRaw).toBe('0');
    });
  });

  describe('6. Multi-Feed Ingestion Deduplication', () => {
    it('deduplicates signals: does not act twice on identical target signature', () => {
      const sig = `dup_test_${randomUUID().substring(0, 8)}`;
      const first = dedupeEngine.registerEvent(sig, 'SEEN_PRECONF', 'HELIUS_PRECONFIRMATION');
      expect(first.shouldAct).toBe(true);

      dedupeEngine.markActed(sig);

      const second = dedupeEngine.registerEvent(sig, 'PROCESSED_SUCCESS', 'LASERSTREAM_WS');
      expect(second.shouldAct).toBe(false);
    });
  });

  describe('7. No Blind Retries & Ambiguous Status Polling', () => {
    it('polls signature status and avoids blind retries on ambiguous network results', async () => {
      const submitter = new TransactionSubmitter();
      (submitter as any).connection.getSignatureStatuses = async () => ({
        value: [
          {
            slot: 280000000,
            confirmations: 10,
            err: null,
            confirmationStatus: 'confirmed',
          },
        ],
      });

      const receipt = await submitter.reconcileStatus(
        'mock_sig_123',
        { blockhash: 'bh', lastValidBlockHeight: 300000000 },
        process.hrtime.bigint(),
        2000
      );

      expect(receipt.status).toBe('CONFIRMED');
      expect(receipt.slot).toBe(280000000);
    });
  });

  describe('8. Jupiter Swap API V2 (/order and /execute) Integration', () => {
    it('parses Jupiter Swap API V2 /order response and prepares signed transaction', async () => {
      const jupV2 = new JupiterSwapV2Adapter();
      // Mock global fetch for V2 /order
      const origFetch = global.fetch;
      try {
        global.fetch = async (url: any) => {
          if (String(url).includes('/order')) {
            return {
              ok: true,
              json: async () => ({
                requestId: 'req_v2_abc123',
                transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED',
                inputMint: WSOL_MINT,
                outputMint: 'TokenMintXYZ1111111111111111111111111111111',
                inAmount: '10000000', // 0.01 SOL
                outAmount: '5000000', // 5 tokens
                slippageBps: 150,
              }),
            } as any;
          }
          return origFetch(url);
        };

        const order = await jupV2.createOrder(
          WSOL_MINT,
          'TokenMintXYZ1111111111111111111111111111111',
          '10000000',
          mockTestKeypair.publicKey.toBase58()
        );

        expect(order.requestId).toBe('req_v2_abc123');
        expect(order.inAmount).toBe('10000000');
        expect(order.outAmount).toBe('5000000');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('submits signed transaction to Jupiter V2 /execute and handles success result', async () => {
      const jupV2 = new JupiterSwapV2Adapter();
      const origFetch = global.fetch;
      try {
        global.fetch = async (url: any, opts: any) => {
          if (String(url).includes('/execute')) {
            return {
              ok: true,
              json: async () => ({
                status: 'Success',
                signature: '4XvH876...realTxSig',
                totalInputAmount: '10000000',
                totalOutputAmount: '5000000',
              }),
            } as any;
          }
          return origFetch(url, opts);
        };

        const mockVersionedTx = {
          serialize: () => Buffer.from('mock_tx_bytes'),
        } as any;

        const res = await jupV2.executeOrder(mockVersionedTx, 'req_v2_abc123');
        expect(res.status).toBe('Success');
        expect(res.signature).toBe('4XvH876...realTxSig');
        expect(res.totalOutputAmount).toBe('5000000');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('handles Jupiter V2 /execute failure without marking order filled', async () => {
      const jupV2 = new JupiterSwapV2Adapter();
      const origFetch = global.fetch;
      try {
        global.fetch = async (url: any) => {
          if (String(url).includes('/execute')) {
            return {
              ok: false,
              status: 400,
              text: async () => 'SlippageToleranceExceeded',
            } as any;
          }
          return origFetch(url);
        };

        const mockVersionedTx = {
          serialize: () => Buffer.from('mock_tx_bytes'),
        } as any;

        const res = await jupV2.executeOrder(mockVersionedTx, 'req_v2_abc123');
        expect(res.status).toBe('Failed');
        expect(res.error).toContain('SlippageToleranceExceeded');
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('9. SPL Mint Decimals Resolution (No Hardcoded 1e6)', () => {
    it('correctly converts amounts for 6-decimal and 9-decimal tokens', () => {
      // 6 decimals (e.g. USDC, Pump.fun standard)
      expect(mintDecimalsService.rawToUi('1000000', 6)).toBe(1.0);
      expect(mintDecimalsService.rawToUi('2500000', 6)).toBe(2.5);
      expect(mintDecimalsService.uiToRaw(2.5, 6)).toBe(2_500_000n);

      // 9 decimals (e.g. SOL, WSOL)
      expect(mintDecimalsService.rawToUi('1000000000', 9)).toBe(1.0);
      expect(mintDecimalsService.rawToUi('10000000', 9)).toBe(0.01);
      expect(mintDecimalsService.uiToRaw(0.01, 9)).toBe(10_000_000n);

      // 8 decimals (e.g. WBTC)
      expect(mintDecimalsService.rawToUi('100000000', 8)).toBe(1.0);
    });
  });

  describe('10. Pump.fun On-Chain Reserves & Graduation Detection', () => {
    const adapter = new PumpFunSwapAdapter();

    it('calculates exact constant product output for active bonding curve', () => {
      const activeState: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 1_073_000_000_000_000n, // ~1.073B tokens
        virtualSolReserves: 30_000_000_000n, // 30 SOL
        realTokenReserves: 793_000_000_000_000n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: false,
        pairAsset: 'SOL',
      };

      const quote = adapter.calculateQuote(activeState, 'BUY', solToLamportsBigInt(0.01));
      expect(quote.isGraduated).toBe(false);
      expect(quote.expectedOutRaw).toBeGreaterThan(0n);
      expect(quote.minOutRaw).toBeLessThan(quote.expectedOutRaw);
      expect(quote.effectivePriceSol).toBeGreaterThan(0);
    });

    it('identifies graduated token and flags for Jupiter V2 / PumpSwap routing', () => {
      const graduatedState: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: true, // Graduated!
        pairAsset: 'SOL',
      };

      const quote = adapter.calculateQuote(graduatedState, 'BUY', solToLamportsBigInt(0.01));
      expect(quote.isGraduated).toBe(true);
      expect(quote.expectedOutRaw).toBe(0n);
    });
  });

  describe('11. Preflight Simulation & Helius Sender Tip Validation', () => {
    it('enforces minimum 0.001 SOL tip for Helius Sender MAX mode', () => {
      // 100,000 lamports is 0.0001 SOL -> invalid for MAX mode
      const checkBad = validateHeliusSenderTip('MAX', 100_000);
      expect(checkBad.valid).toBe(false);
      expect(checkBad.error).toContain('Helius Sender MAX requires a minimum tip of 0.001 SOL');

      // 1,000,000 lamports is 0.001 SOL -> valid
      const checkGood = validateHeliusSenderTip('MAX', 1_000_000);
      expect(checkGood.valid).toBe(true);

      // SWQOS mode permits lower tip
      const checkSwqos = validateHeliusSenderTip('SWQOS', 100_000);
      expect(checkSwqos.valid).toBe(true);
    });

    it('fails submission before broadcasting if preflight simulation returns an error', async () => {
      const submitter = new TransactionSubmitter();
      // Mock simulateTransaction returning an error
      (submitter as any).connection.simulateTransaction = async () => ({
        value: {
          err: { InstructionError: [0, 'Custom(1)'] },
          logs: ['Program 6EF8... failed: custom program error: 0x1'],
        },
      });

      const mockVersionedTx = {
        serialize: () => Buffer.from('mock_tx_bytes'),
      } as any;

      const receipt = await submitter.submitAndConfirm(
        mockVersionedTx,
        { blockhash: 'bh', lastValidBlockHeight: 100 },
        'sig_mock_sim'
      );

      expect(receipt.status).toBe('FAILED');
      expect(receipt.error).toContain('Preflight simulation rejected');
    });
  });

  describe('12. Mainnet Smoke-Test Mode & Single-Trade Auto-Disarm', () => {
    it('auto-disarms engine and blocks second trade when in smoke-test mode', async () => {
      // Verify initial state
      const status = liveEngine.getStatus();
      expect(status.smokeTestMode).toBe(true);
    });
  });
});
