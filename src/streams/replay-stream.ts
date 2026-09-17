import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';

export interface ReplayOptions {
  speedMultiplier?: number; // 1 = real-time, 0 = instant, 2 = 2x speed
  fixedDelayMs?: number; // fixed delay between events
  loop?: boolean;
}

export class ReplayStream {
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  public async replay(
    transactions: ParsedTransactionEnvelope[],
    onTransaction: (tx: ParsedTransactionEnvelope) => Promise<void> | void,
    options: ReplayOptions = { fixedDelayMs: 50 }
  ): Promise<void> {
    this.isRunning = true;

    for (let i = 0; i < transactions.length; i++) {
      if (!this.isRunning) break;

      const tx = transactions[i];
      // Attach fresh monotonic timestamp
      tx.observedAt = process.hrtime.bigint();

      await onTransaction(tx);

      if (options.fixedDelayMs && options.fixedDelayMs > 0 && i < transactions.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.fixedDelayMs));
      }
    }

    this.isRunning = false;
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
