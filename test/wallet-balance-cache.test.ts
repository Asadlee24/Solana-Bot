import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionWalletManager, executionWalletManager } from '../src/execution/wallet-manager.js';
import { config, CANONICAL_LIVE_TRADING_ACK } from '../src/config/index.js';
import { LiveExecutionEngine } from '../src/execution/live-engine.js';

describe('Execution Wallet Balance Cache & Availability Verification Suite', () => {
  let walletManager: ExecutionWalletManager;
  const mockKeypair = Keypair.generate();

  beforeEach(() => {
    walletManager = new ExecutionWalletManager();
    // Inject mock keypair for test isolation
    (walletManager as any).keypair = mockKeypair;
  });

  afterEach(() => {
    walletManager.stopBackgroundPolling();
    vi.restoreAllMocks();
  });

  it('1. Startup uninitialized state never treats balance as real 0 SOL and reports unavailable', () => {
    expect(walletManager.isInitializedState()).toBe(false);
    expect(walletManager.isVerifiedZeroBalance()).toBe(false);
    expect(walletManager.getLastFetchError()).toBeNull();
    expect(walletManager.isBalanceAvailable()).toBe(false);

    const displayState = walletManager.getBalanceDisplayState();
    expect(displayState.isAvailable).toBe(false);
    expect(displayState.isInitialized).toBe(false);
    expect(displayState.isVerifiedZero).toBe(false);
    expect(displayState.displayBalance).toBe('Balance unavailable / RPC syncing');

    const status = walletManager.getStatus();
    expect(status.isAvailable).toBe(false);
    expect(status.displayBalance).toBe('Balance unavailable / RPC syncing');
  });

  it('2. Successful non-zero balance fetch sets initialized=true, verifiedZero=false, and displays correct SOL', async () => {
    const lamports = 360_023_717n; // 0.360023717 SOL
    vi.spyOn((walletManager as any).connection, 'getBalance').mockResolvedValue(Number(lamports));

    const result = await walletManager.refreshBalance(true);
    expect(result).toBe(lamports);
    expect(walletManager.isInitializedState()).toBe(true);
    expect(walletManager.isVerifiedZeroBalance()).toBe(false);
    expect(walletManager.isBalanceAvailable()).toBe(true);
    expect(walletManager.getLastFetchError()).toBeNull();

    const displayState = walletManager.getBalanceDisplayState();
    expect(displayState.isAvailable).toBe(true);
    expect(displayState.balanceLamports).toBe(lamports);
    expect(displayState.balanceSol).toBeCloseTo(0.360023717, 6);
    expect(displayState.displayBalance).toBe('0.3600 SOL');
  });

  it('3. Genuine verified zero balance (0 lamports) correctly displays 0.0000 SOL, distinct from unavailable', async () => {
    vi.spyOn((walletManager as any).connection, 'getBalance').mockResolvedValue(0);

    const result = await walletManager.refreshBalance(true);
    expect(result).toBe(0n);
    expect(walletManager.isInitializedState()).toBe(true);
    expect(walletManager.isVerifiedZeroBalance()).toBe(true);
    expect(walletManager.isBalanceAvailable()).toBe(true);
    expect(walletManager.getLastFetchError()).toBeNull();

    const displayState = walletManager.getBalanceDisplayState();
    expect(displayState.isAvailable).toBe(true);
    expect(displayState.isVerifiedZero).toBe(true);
    expect(displayState.balanceSol).toBe(0);
    expect(displayState.displayBalance).toBe('0.0000 SOL');
  });

  it('4. RPC failure when uninitialized throws, records error, keeps initialized=false, and displays Unavailable', async () => {
    vi.spyOn((walletManager as any).connection, 'getBalance').mockRejectedValue(new Error('RPC rate limited 429'));

    await expect(walletManager.refreshBalance(true)).rejects.toThrow('Failed to query on-chain balance: RPC rate limited 429');

    expect(walletManager.isInitializedState()).toBe(false);
    expect(walletManager.isVerifiedZeroBalance()).toBe(false);
    expect(walletManager.isBalanceAvailable()).toBe(false);
    expect(walletManager.getLastFetchError()).toContain('RPC rate limited 429');

    const displayState = walletManager.getBalanceDisplayState();
    expect(displayState.isAvailable).toBe(false);
    expect(displayState.displayBalance).toBe('Balance unavailable / RPC syncing');
  });

  it('5. TTL cache prevents redundant RPC requests within maxAgeMs', async () => {
    const getBalanceSpy = vi.spyOn((walletManager as any).connection, 'getBalance').mockResolvedValue(500_000_000);

    // First fetch
    await walletManager.getFreshBalance(20000);
    expect(getBalanceSpy).toHaveBeenCalledTimes(1);

    // Second fetch within 20s TTL should hit cache
    const secondState = await walletManager.getFreshBalance(20000);
    expect(getBalanceSpy).toHaveBeenCalledTimes(1);
    expect(secondState.isAvailable).toBe(true);
    expect(secondState.displayBalance).toBe('0.5000 SOL');
  });

  it('6. Coalesces concurrent in-flight refresh requests into a single RPC query', async () => {
    let callCount = 0;
    vi.spyOn((walletManager as any).connection, 'getBalance').mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return 1_000_000_000;
    });

    const [res1, res2, res3] = await Promise.all([
      walletManager.refreshBalance(true),
      walletManager.refreshBalance(true),
      walletManager.refreshBalance(true),
    ]);

    expect(res1).toBe(1_000_000_000n);
    expect(res2).toBe(1_000_000_000n);
    expect(res3).toBe(1_000_000_000n);
    expect(callCount).toBe(1); // Exactly 1 RPC request fired
  });

  it('7. LIVE engine arm is blocked when balance query fails or is unavailable (fails closed)', async () => {
    const liveEngine = new LiveExecutionEngine();
    const origMode = config.EXECUTION_MODE;
    const origAck = config.LIVE_TRADING_ACK;
    (config as any).EXECUTION_MODE = 'LIVE';
    (config as any).LIVE_TRADING_ACK = CANONICAL_LIVE_TRADING_ACK;

    // Ensure wallet is ready so it reaches the balance query
    vi.spyOn(executionWalletManager, 'isReady').mockReturnValue(true);

    // Simulate RPC failure on balance refresh
    vi.spyOn(executionWalletManager, 'refreshBalance').mockRejectedValue(new Error('Connection timed out'));

    const result = await liveEngine.arm();

    expect(result.armed).toBe(false);
    expect(result.reason).toContain('RPC balance check failed');
    expect(liveEngine.getStatus().isArmed).toBe(false);

    (config as any).EXECUTION_MODE = origMode;
    (config as any).LIVE_TRADING_ACK = origAck;
  });

  it('8. checkSpendable fails closed with BALANCE_UNAVAILABLE when balance is uninitialized or stale', () => {
    expect(walletManager.isBalanceAvailable()).toBe(false);

    const spendCheck = walletManager.checkSpendable(10_000_000n);
    expect(spendCheck.allowed).toBe(false);
    expect(spendCheck.reason).toContain('BALANCE_UNAVAILABLE');
  });

  it('9. Existing capital reservation & reserve floor remains intact when balance is fresh', async () => {
    // 0.05 SOL on chain
    vi.spyOn((walletManager as any).connection, 'getBalance').mockResolvedValue(50_000_000);
    await walletManager.refreshBalance(true);

    // FIXED_BUY_SOL = 0.01 SOL (10,000,000 lamports), MIN_RESERVE = 0.02 SOL (20,000,000 lamports)
    // 50,000,000 - 10,000,000 trade - ~5000 fees > 20,000,000 reserve => Allowed
    const validTrade = walletManager.checkSpendable(10_000_000n);
    expect(validTrade.allowed).toBe(true);

    // Large trade 40,000,000 lamports => remaining < 20,000,000 reserve => Rejected
    const breachTrade = walletManager.checkSpendable(40_000_000n);
    expect(breachTrade.allowed).toBe(false);
    expect(breachTrade.reason).toContain('INSUFFICIENT_BALANCE');
  });

  it('10. Unconfigured wallet (keypair=null as in PAPER mode) reports isAvailable=false safely without throwing', () => {
    (walletManager as any).keypair = null;

    expect(walletManager.isBalanceAvailable()).toBe(false);
    const displayState = walletManager.getBalanceDisplayState();
    expect(displayState.isAvailable).toBe(false);
    expect(displayState.displayBalance).toBe('Balance unavailable / RPC syncing');

    const status = walletManager.getStatus();
    expect(status.isConfigured).toBe(false);
    expect(status.isAvailable).toBe(false);
  });
});
