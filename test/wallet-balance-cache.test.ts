import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ExecutionWalletManager } from '../src/execution/wallet-manager.js';
import { liveEngine } from '../src/execution/live-engine.js';
import { config, CANONICAL_LIVE_TRADING_ACK } from '../src/config/index.js';

describe('ExecutionWalletManager - Balance Cache & Display Integrity Suite', () => {
  let manager: ExecutionWalletManager;
  const mockKeypair = Keypair.generate();

  beforeEach(() => {
    vi.restoreAllMocks();
    manager = new ExecutionWalletManager();
    // Inject mock keypair directly
    (manager as any).keypair = mockKeypair;
    (manager as any).isInitialized = false;
    (manager as any).isVerifiedZero = false;
    (manager as any).cachedBalanceLamports = 0n;
    (manager as any).lastBalanceFetchTime = 0;
    (manager as any).lastFetchError = null;
    (manager as any).inFlightRefreshPromise = null;
  });

  afterEach(() => {
    manager.stopBackgroundPolling();
    vi.restoreAllMocks();
  });

  it('1. Startup uninitialized state: never reports genuine 0 SOL when uninitialized', () => {
    expect(manager.isBalanceAvailable()).toBe(false);
    expect(manager.isInitializedState()).toBe(false);
    expect(manager.isVerifiedZeroBalance()).toBe(false);

    const state = manager.getBalanceDisplayState();
    expect(state.isAvailable).toBe(false);
    expect(state.isInitialized).toBe(false);
    expect(state.displayBalance).toBe('Balance unavailable / RPC syncing');
    expect(state.spendableSol).toBe(0);
  });

  it('2. Verified zero balance: genuine 0 lamports displays 0.0000 SOL', async () => {
    vi.spyOn((manager as any).connection, 'getBalance').mockResolvedValue(0);

    const lamports = await manager.refreshBalance(true);
    expect(lamports).toBe(0n);
    expect(manager.isBalanceAvailable()).toBe(true);
    expect(manager.isInitializedState()).toBe(true);
    expect(manager.isVerifiedZeroBalance()).toBe(true);

    const state = manager.getBalanceDisplayState();
    expect(state.isAvailable).toBe(true);
    expect(state.isVerifiedZero).toBe(true);
    expect(state.balanceLamports).toBe(0n);
    expect(state.balanceSol).toBe(0);
    expect(state.displayBalance).toBe('0.0000 SOL');
  });

  it('3. Successful non-zero balance fetch: sets initialized and formats display correctly', async () => {
    // 0.360023717 SOL = 360,023,717 lamports
    const onChainLamports = 360_023_717;
    vi.spyOn((manager as any).connection, 'getBalance').mockResolvedValue(onChainLamports);

    const lamports = await manager.refreshBalance(true);
    expect(lamports).toBe(BigInt(onChainLamports));
    expect(manager.isBalanceAvailable()).toBe(true);
    expect(manager.isInitializedState()).toBe(true);
    expect(manager.isVerifiedZeroBalance()).toBe(false);
    expect(manager.getLastFetchError()).toBeNull();

    const state = manager.getBalanceDisplayState();
    expect(state.isAvailable).toBe(true);
    expect(state.balanceLamports).toBe(360_023_717n);
    expect(state.balanceSol).toBeCloseTo(0.36, 2);
    expect(state.displayBalance).toBe('0.3600 SOL');
    // Reserve is 0.02 SOL, spendable should be ~0.3400 SOL
    expect(state.spendableSol).toBeCloseTo(0.34, 2);
  });

  it('4. RPC failure on uninitialized state: records error and fails closed', async () => {
    vi.spyOn((manager as any).connection, 'getBalance').mockRejectedValue(new Error('RPC 429 Too Many Requests'));

    await expect(manager.refreshBalance(true)).rejects.toThrow('Failed to query on-chain balance');

    expect(manager.isBalanceAvailable()).toBe(false);
    expect(manager.isInitializedState()).toBe(false);
    expect(manager.getLastFetchError()).toContain('RPC 429 Too Many Requests');

    const state = manager.getBalanceDisplayState();
    expect(state.isAvailable).toBe(false);
    expect(state.displayBalance).toBe('Balance unavailable / RPC syncing');
  });

  it('5. TTL Caching and In-Flight Request Coalescing: concurrent calls share a single promise', async () => {
    let rpcCallCount = 0;
    vi.spyOn((manager as any).connection, 'getBalance').mockImplementation(async () => {
      rpcCallCount++;
      await new Promise((r) => setTimeout(r, 20));
      return 360_000_000;
    });

    // Fire 5 concurrent refreshBalance requests simultaneously
    const results = await Promise.all([
      manager.refreshBalance(false, 15000),
      manager.refreshBalance(false, 15000),
      manager.refreshBalance(false, 15000),
      manager.refreshBalance(false, 15000),
      manager.refreshBalance(false, 15000),
    ]);

    // All return the exact same balance
    expect(results).toEqual([360_000_000n, 360_000_000n, 360_000_000n, 360_000_000n, 360_000_000n]);
    // Exactly 1 network RPC call occurred
    expect(rpcCallCount).toBe(1);

    // Immediate subsequent call within TTL does not hit RPC again
    const cachedResult = await manager.refreshBalance(false, 15000);
    expect(cachedResult).toBe(360_000_000n);
    expect(rpcCallCount).toBe(1);
  });

  it('6. checkSpendable fails closed with BALANCE_UNAVAILABLE if balance is uninitialized or stale', () => {
    // Uninitialized
    const uninitializedCheck = manager.checkSpendable(10_000_000n);
    expect(uninitializedCheck.allowed).toBe(false);
    expect(uninitializedCheck.reason).toContain('BALANCE_UNAVAILABLE');
    expect(uninitializedCheck.balanceSol).toBe(0);

    // Stale (> 60s)
    (manager as any).isInitialized = true;
    (manager as any).cachedBalanceLamports = 360_000_000n;
    (manager as any).lastBalanceFetchTime = Date.now() - 70000; // 70s ago

    const staleCheck = manager.checkSpendable(10_000_000n);
    expect(staleCheck.allowed).toBe(false);
    expect(staleCheck.reason).toContain('BALANCE_UNAVAILABLE');

    // Fresh balance allows spendable check
    (manager as any).lastBalanceFetchTime = Date.now() - 5000; // 5s ago
    const freshCheck = manager.checkSpendable(10_000_000n);
    expect(freshCheck.allowed).toBe(true);
    expect(freshCheck.balanceSol).toBeCloseTo(0.36, 2);
  });

  it('7. liveEngine arming fails closed when execution wallet balance is unavailable', async () => {
    (config as any).EXECUTION_MODE = 'LIVE';
    (config as any).LIVE_TRADING_ACK = CANONICAL_LIVE_TRADING_ACK;

    const { executionWalletManager: singletonManager } = await import('../src/execution/wallet-manager.js');
    vi.spyOn(singletonManager, 'isReady').mockReturnValue(true);
    vi.spyOn(singletonManager, 'refreshBalance').mockRejectedValue(new Error('RPC network timeout'));
    vi.spyOn(singletonManager, 'isBalanceAvailable').mockReturnValue(false);
    vi.spyOn(singletonManager, 'getLastFetchError').mockReturnValue('RPC network timeout');

    const armResult = await liveEngine.evaluateArmStatus();
    expect(armResult.armed).toBe(false);
    expect(armResult.reason).toContain('Arming blocked');
  });

  it('8. Background polling can be started and cleanly stopped', () => {
    expect((manager as any).backgroundPollTimer).toBeNull();
    manager.startBackgroundPolling(10000);
    expect((manager as any).backgroundPollTimer).not.toBeNull();

    // Calling start again is idempotent
    const timer1 = (manager as any).backgroundPollTimer;
    manager.startBackgroundPolling(10000);
    expect((manager as any).backgroundPollTimer).toBe(timer1);

    // Stop cleans up
    manager.stopBackgroundPolling();
    expect((manager as any).backgroundPollTimer).toBeNull();
  });
});
