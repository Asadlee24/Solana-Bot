import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58Module from 'bs58';
import { config } from '../config/index.js';

// Resolve bs58 decoder function across ESM / CJS module bundlers
const bs58Decode = (typeof bs58Module.decode === 'function'
  ? bs58Module.decode
  : (bs58Module as any).default?.decode) as (input: string) => Uint8Array;

export interface WalletStatus {
  isConfigured: boolean;
  publicKey: string | null;
  balanceLamports: bigint;
  balanceSol: number;
  reserveSol: number;
  spendableSol: number;
  lastUpdated: number;
}

export class ExecutionWalletManager {
  private keypair: Keypair | null = null;
  private connection: Connection;
  private cachedBalanceLamports: bigint = 0n;
  private lastBalanceFetchTime: number = 0;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 15000,
    });
    this.loadKeypair();
  }

  /**
   * Cryptographically loads FOLLOWER_PRIVATE_KEY supporting JSON byte arrays and Base58.
   * Strictly avoids hex buffer decode and validates keypair integrity.
   */
  public loadKeypair(): boolean {
    const rawKey = config.FOLLOWER_PRIVATE_KEY ? config.FOLLOWER_PRIVATE_KEY.trim() : '';
    if (!rawKey) {
      this.keypair = null;
      return false;
    }

    try {
      let secretBytes: Uint8Array;

      if (rawKey.startsWith('[') && rawKey.endsWith(']')) {
        // JSON byte-array format: [123, 45, ...]
        const parsed = JSON.parse(rawKey);
        if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
          throw new Error(`Invalid JSON private key array length: expected 64 (or 32), got ${parsed.length}`);
        }
        secretBytes = Uint8Array.from(parsed);
      } else {
        // Base58 encoded secret key (standard Phantom / Solflare export)
        if (!bs58Decode) {
          throw new Error('bs58 decoder module is unavailable');
        }
        secretBytes = bs58Decode(rawKey);
      }

      if (secretBytes.length === 64) {
        this.keypair = Keypair.fromSecretKey(secretBytes);
      } else if (secretBytes.length === 32) {
        this.keypair = Keypair.fromSeed(secretBytes);
      } else {
        throw new Error(`Unexpected decoded secret length: ${secretBytes.length} bytes`);
      }

      return true;
    } catch (err: any) {
      console.error('[Execution Wallet] Failed to load private key safely:', err.message);
      this.keypair = null;
      return false;
    }
  }

  public isReady(): boolean {
    return this.keypair !== null;
  }

  public getKeypair(): Keypair | null {
    return this.keypair;
  }

  public getPublicKey(): PublicKey | null {
    return this.keypair ? this.keypair.publicKey : null;
  }

  public getPublicKeyBase58(): string | null {
    return this.keypair ? this.keypair.publicKey.toBase58() : null;
  }

  /**
   * Startup self-test: Prints ONLY the public key. Never prints private key or secret bytes.
   */
  public logStartupStatus(): void {
    if (this.keypair) {
      console.info(`[Execution Wallet] Configured Public Key: ${this.keypair.publicKey.toBase58()}`);
    } else {
      console.warn('[Execution Wallet] Not configured. Live execution is disarmed.');
    }
  }

  /**
   * Fetches real on-chain SOL balance for the execution hot wallet.
   */
  public async refreshBalance(): Promise<bigint> {
    if (!this.keypair) {
      this.cachedBalanceLamports = 0n;
      return 0n;
    }

    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey, 'confirmed');
      this.cachedBalanceLamports = BigInt(lamports);
      this.lastBalanceFetchTime = Date.now();
      return this.cachedBalanceLamports;
    } catch (err: any) {
      console.warn('[Execution Wallet] Failed to query on-chain balance:', err.message);
      return this.cachedBalanceLamports;
    }
  }

  /**
   * Queries the follower's on-chain SPL token balance for a specific mint.
   */
  public async getTokenBalanceRaw(mint: string): Promise<bigint> {
    if (!this.keypair) return 0n;
    try {
      const parsed = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(mint) },
        'confirmed'
      );
      if (!parsed.value || parsed.value.length === 0) return 0n;

      let total = 0n;
      for (const item of parsed.value) {
        const rawAmt = item.account.data.parsed?.info?.tokenAmount?.amount || '0';
        total += BigInt(rawAmt);
      }
      return total;
    } catch {
      return 0n;
    }
  }

  /**
   * Queries all SPL token mints currently held with positive balance in the follower wallet.
   */
  public async getHeldTokenMints(): Promise<string[]> {
    if (!this.keypair) return [];
    try {
      const parsed = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        'confirmed'
      );
      const held: string[] = [];
      for (const item of parsed.value || []) {
        const rawAmt = item.account.data.parsed?.info?.tokenAmount?.amount || '0';
        if (BigInt(rawAmt) > 0n) {
          const mint = item.account.data.parsed?.info?.mint;
          if (mint) held.push(mint);
        }
      }
      return held;
    } catch {
      return [];
    }
  }

  public getCachedBalanceLamports(): bigint {
    return this.cachedBalanceLamports;
  }

  public getCachedBalanceSol(): number {
    return Number(this.cachedBalanceLamports) / LAMPORTS_PER_SOL;
  }

  public getSpendableBalanceSol(): number {
    const total = this.getCachedBalanceSol();
    return Math.max(0, total - config.MIN_SOL_RESERVE_SOL);
  }

  /**
   * Validates whether a proposed buy trade complies with minimum SOL reserve floor.
   * Clearly distinguishes fee units:
   * - computeUnitPriceMicroLamports (in micro-lamports per CU, 10^-6 lamports)
   * - computeUnitLimit (number of compute units)
   * - estimatedPriorityFeeLamports = (computeUnitPriceMicroLamports * computeUnitLimit) / 1,000,000
   * - baseFeeLamports (5,000 lamports standard Solana base fee)
   * - senderTipLamports (Helius/Jito tip in lamports)
   * 
   * walletBalance - requestedTrade - baseFee - priorityFee - senderTip >= MIN_SOL_RESERVE_SOL
   */
  public checkSpendable(
    requestedTradeLamports: bigint,
    computeUnitPriceMicroLamports: bigint = BigInt(config.PRIORITY_FEE_MICRO_LAMPORTS),
    computeUnitLimit: bigint = 250_000n,
    senderTipLamports: bigint = BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
    baseFeeLamports: bigint = 5_000n
  ): {
    allowed: boolean;
    reason?: string;
    balanceSol: number;
    reserveSol: number;
    spendableSol: number;
    feeBreakdown: {
      computeUnitPriceMicroLamports: bigint;
      computeUnitLimit: bigint;
      estimatedPriorityFeeLamports: bigint;
      baseFeeLamports: bigint;
      senderTipLamports: bigint;
      totalDeductionLamports: bigint;
    };
  } {
    const balanceSol = this.getCachedBalanceSol();
    const reserveSol = config.MIN_SOL_RESERVE_SOL;
    const spendableSol = Math.max(0, balanceSol - reserveSol);

    // 1 lamport = 1,000,000 micro-lamports
    const estimatedPriorityFeeLamports = (computeUnitPriceMicroLamports * computeUnitLimit) / 1_000_000n;
    const totalDeductionLamports =
      requestedTradeLamports + baseFeeLamports + estimatedPriorityFeeLamports + senderTipLamports;

    const feeBreakdown = {
      computeUnitPriceMicroLamports,
      computeUnitLimit,
      estimatedPriorityFeeLamports,
      baseFeeLamports,
      senderTipLamports,
      totalDeductionLamports,
    };

    const minReserveLamports = BigInt(Math.floor(reserveSol * LAMPORTS_PER_SOL));

    if (this.cachedBalanceLamports < totalDeductionLamports) {
      return {
        allowed: false,
        reason: `INSUFFICIENT_BALANCE: Balance (${balanceSol.toFixed(4)} SOL) is lower than total trade outlay (${(Number(totalDeductionLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
        balanceSol,
        reserveSol,
        spendableSol,
        feeBreakdown,
      };
    }

    const postTradeBalanceLamports = this.cachedBalanceLamports - totalDeductionLamports;
    if (postTradeBalanceLamports < minReserveLamports) {
      return {
        allowed: false,
        reason: `INSUFFICIENT_BALANCE: Trade would breach minimum SOL reserve floor (${reserveSol} SOL). Post-trade balance would be ${(Number(postTradeBalanceLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        balanceSol,
        reserveSol,
        spendableSol,
        feeBreakdown,
      };
    }

    return {
      allowed: true,
      balanceSol,
      reserveSol,
      spendableSol,
      feeBreakdown,
    };
  }

  /**
   * Diagnostic summary for REST API and Dashboard
   */
  public getStatus(): WalletStatus {
    const balanceSol = this.getCachedBalanceSol();
    const reserveSol = config.MIN_SOL_RESERVE_SOL;
    const spendableSol = Math.max(0, balanceSol - reserveSol);

    return {
      isConfigured: this.isReady(),
      publicKey: this.getPublicKeyBase58(),
      balanceLamports: this.cachedBalanceLamports,
      balanceSol,
      reserveSol,
      spendableSol,
      lastUpdated: this.lastBalanceFetchTime,
    };
  }
}

export const executionWalletManager = new ExecutionWalletManager();
