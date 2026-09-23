import { BlockhashWithExpiryBlockHeight, Connection } from '@solana/web3.js';
import { config } from '../config/index.js';

export class BlockhashService {
  private connection: Connection;
  private cachedBlockhash: BlockhashWithExpiryBlockHeight | null = null;
  private lastFetchedAt: number = 0;
  private isRunning: boolean = false;
  private refreshIntervalMs: number = 10000; // Refreshes every 10s (saves ~78,000 RPC requests/day while staying fresh within Solana's ~60-90s blockhash lifetime)
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.refreshLoop();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async refreshLoop(): Promise<void> {
    try {
      const bh = await this.connection.getLatestBlockhash('confirmed');
      this.cachedBlockhash = bh;
      this.lastFetchedAt = Date.now();
    } catch {
      // Ignore network hiccup on polling
    }

    if (this.isRunning) {
      this.timer = setTimeout(() => this.refreshLoop(), this.refreshIntervalMs);
    }
  }

  public async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    // If cached within 30 seconds, return immediately (0ms latency!)
    if (this.cachedBlockhash && Date.now() - this.lastFetchedAt < 30000) {
      return this.cachedBlockhash;
    }

    // Fallback: fetch fresh
    const bh = await this.connection.getLatestBlockhash('confirmed');
    this.cachedBlockhash = bh;
    this.lastFetchedAt = Date.now();
    return bh;
  }
}

export const blockhashService = new BlockhashService();
