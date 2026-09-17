import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';

export class MintDecimalsService {
  private connection: Connection;
  private cache: Map<string, number> = new Map();

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
    // Known standard mints pre-seeded
    this.cache.set('So11111111111111111111111111111111111111112', 9); // WSOL
    this.cache.set('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6); // USDC
    this.cache.set('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6); // USDT
  }

  /**
   * Resolves the on-chain decimals for any SPL Token or Token-2022 mint.
   * Caches results in memory for zero latency on subsequent lookups.
   */
  public async getDecimals(mintAddress: string): Promise<number> {
    if (this.cache.has(mintAddress)) {
      return this.cache.get(mintAddress)!;
    }

    try {
      const pubkey = new PublicKey(mintAddress);
      const info = await this.connection.getParsedAccountInfo(pubkey, 'confirmed');

      if (info.value && 'parsed' in info.value.data) {
        const decimals = info.value.data.parsed?.info?.decimals;
        if (typeof decimals === 'number') {
          this.cache.set(mintAddress, decimals);
          return decimals;
        }
      }
    } catch (err: any) {
      console.warn(`[Decimals] Failed to query decimals for mint ${mintAddress}: ${err.message}`);
    }

    // Default fallback if unresolvable on-chain (most Pump.fun / memecoins are 6 decimals)
    const fallback = 6;
    this.cache.set(mintAddress, fallback);
    return fallback;
  }

  /**
   * Converts raw integer amount to human-readable UI number using exact decimals.
   * e.g. raw 1,000,000 with 6 decimals -> 1.0
   * e.g. raw 1,000,000,000 with 9 decimals -> 1.0
   */
  public rawToUi(rawAmount: bigint | string | number, decimals: number): number {
    const rawBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount.toString());
    const factor = 10 ** decimals;
    return Number(rawBig) / factor;
  }

  /**
   * Converts human-readable UI number to raw integer units using exact decimals.
   */
  public uiToRaw(uiAmount: number, decimals: number): bigint {
    const factor = 10 ** decimals;
    return BigInt(Math.floor(uiAmount * factor));
  }
}

export const mintDecimalsService = new MintDecimalsService();
