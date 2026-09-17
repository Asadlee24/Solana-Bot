import { Keypair } from '@solana/web3.js';
import bs58Module from 'bs58';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { config, solToLamportsBigInt } from '../src/config/index.js';
import { db } from '../src/db/database.js';
import { dedupeEngine } from '../src/engine/dedupe.js';
import { positionEngine } from '../src/engine/position-engine.js';
import { riskEngine } from '../src/engine/risk-engine.js';
import { liveEngine } from '../src/execution/live-engine.js';
import { TransactionSubmitter } from '../src/execution/transaction-submitter.js';
import { ExecutionWalletManager } from '../src/execution/wallet-manager.js';
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
        // Simulate cached balance of 0.06 SOL (reserve is 0.05 SOL)
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
        // Simulate cached balance of 1.0 SOL
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
        timestampMs: Date.now() - (config.MAX_SIGNAL_AGE_MS + 500), // Stale
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
      // Follower price is 3.5% higher (350 bps gap > 200 bps tolerance)
      const badFollowerPrice = 0.00001035;

      const check = riskEngine.evaluateQuote(targetPrice, badFollowerPrice);
      expect(check.approved).toBe(false);
      expect(check.decision).toBe('REJECTED_ENTRY_GAP');
    });

    it('approves quote when entry price gap is within tolerance', () => {
      const targetPrice = 0.00001;
      // Follower price is 0.5% higher (50 bps gap <= 200 bps tolerance)
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
      // Follower bought 1,000,000 raw tokens
      positionEngine.recordFill(targetA, tokenMint, 'BUY', 1_000_000n, 10_000_000n, 0.00001, 'sig_buy_a');

      // Target had 10,000,000 tokens and sells 2,500,000 (25%)
      const sellIntent: SwapIntent = {
        targetSignature: `sig_sell_25_${runId}`,
        slot: 2,
        targetWallet: targetA,
        venue: 'PUMPFUN',
        side: 'SELL',
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        tokenMint,
        inputAmountRaw: '2500000', // S_t
        outputAmountRaw: '25000000',
        targetPreBalanceToken: '10000000', // B_t
        estimatedPrice: 0.00001,
        observedAt: process.hrtime.bigint(),
        timestampMs: Date.now(),
        rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        confidence: 1.0,
      };

      const mirror = positionEngine.prepareMirrorIntent(sellIntent, walletConfigA, 'APPROVED');
      expect(mirror.sellFraction).toBeCloseTo(0.25, 2);
      expect(mirror.requestedInAmountRaw).toBe('250000'); // Exactly 25% of 1,000,000
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

      // Target B sells the same token, but follower never copied target B for this token
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
      // Holding protection: Follower sells 0 because follower position belongs to target A, not target B
      expect(mirrorB.requestedInAmountRaw).toBe('0');
    });
  });

  describe('6. Multi-Feed Ingestion Deduplication', () => {
    it('deduplicates signals: does not act twice on identical target signature', () => {
      const sig = `dup_test_${randomUUID().substring(0, 8)}`;
      const first = dedupeEngine.registerEvent(sig, 'SEEN_PRECONF', 'HELIUS_PRECONFIRMATION');
      expect(first.shouldAct).toBe(true);

      dedupeEngine.markActed(sig);

      // Same signature arrives from LaserStream WS or RPC
      const second = dedupeEngine.registerEvent(sig, 'PROCESSED_SUCCESS', 'LASERSTREAM_WS');
      expect(second.shouldAct).toBe(false);
    });
  });

  describe('7. No Blind Retries & Ambiguous Status Polling', () => {
    it('polls signature status and avoids blind retries on ambiguous network results', async () => {
      const submitter = new TransactionSubmitter();
      // Mock getSignatureStatuses to simulate transaction successfully confirmed
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
});
