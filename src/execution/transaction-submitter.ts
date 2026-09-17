import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  SendOptions,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config/index.js';

export interface SubmissionReceipt {
  signature: string;
  status: 'SUBMITTED' | 'PROCESSED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';
  slot?: number;
  submittedAt: bigint;
  confirmedAt?: bigint;
  error?: string;
}

export class TransactionSubmitter {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 20000,
    });
  }

  /**
   * High-speed submission with monotonic timer tracking and fail-safe confirmation.
   * STRICT GUARD: NEVER blindly retries with a new transaction upon ambiguous timeouts.
   */
  public async submitAndConfirm(
    transaction: VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
    signature: string
  ): Promise<SubmissionReceipt> {
    const rawTx = transaction.serialize();
    const submittedAt = process.hrtime.bigint();

    const sendOptions: SendOptions = {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'processed',
    };

    try {
      // Submit through configured RPC endpoint
      await this.connection.sendRawTransaction(rawTx, sendOptions);
    } catch (sendErr: any) {
      // Ambiguous error check: The transaction might have still reached leaders!
      console.warn(`[Submitter] Initial send returned error for ${signature}: ${sendErr.message}. Checking on-chain status...`);
    }

    // Await confirmation or reconcile status
    return await this.reconcileStatus(signature, latestBlockhash, submittedAt);
  }

  /**
   * Reconciles transaction status against Solana validators.
   * If timeout or ambiguous result occurs, queries signature status directly before deciding.
   */
  public async reconcileStatus(
    signature: string,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
    submittedAt: bigint,
    timeoutMs: number = 25000
  ): Promise<SubmissionReceipt> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const { value: statuses } = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });

        const status = statuses?.[0];
        if (status) {
          if (status.err) {
            return {
              signature,
              status: 'FAILED',
              slot: status.slot,
              submittedAt,
              error: JSON.stringify(status.err),
            };
          }

          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            return {
              signature,
              status: 'CONFIRMED',
              slot: status.slot,
              submittedAt,
              confirmedAt: process.hrtime.bigint(),
            };
          }

          if (status.confirmationStatus === 'processed') {
            return {
              signature,
              status: 'PROCESSED',
              slot: status.slot,
              submittedAt,
              confirmedAt: process.hrtime.bigint(),
            };
          }
        }

        // Check if blockhash has expired on-chain
        const currentBlockHeight = await this.connection.getBlockHeight('processed');
        if (currentBlockHeight > latestBlockhash.lastValidBlockHeight) {
          // Double-check one final time before declaring EXPIRED
          const finalCheck = await this.connection.getSignatureStatuses([signature]);
          if (finalCheck.value?.[0] && !finalCheck.value[0].err) {
            return {
              signature,
              status: 'CONFIRMED',
              slot: finalCheck.value[0].slot,
              submittedAt,
              confirmedAt: process.hrtime.bigint(),
            };
          }

          return {
            signature,
            status: 'EXPIRED',
            submittedAt,
            error: `Blockhash expired. Current height ${currentBlockHeight} > ${latestBlockhash.lastValidBlockHeight}`,
          };
        }
      } catch (err: any) {
        // Transient network delay: do NOT throw or retry a new trade; continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    // Timeout exceeded: final status check
    try {
      const finalCheck = await this.connection.getSignatureStatuses([signature]);
      const st = finalCheck.value?.[0];
      if (st && !st.err) {
        return {
          signature,
          status: 'CONFIRMED',
          slot: st.slot,
          submittedAt,
          confirmedAt: process.hrtime.bigint(),
        };
      }
    } catch {}

    return {
      signature,
      status: 'FAILED',
      submittedAt,
      error: 'Transaction confirmation polling timed out without on-chain proof of execution.',
    };
  }
}

export const transactionSubmitter = new TransactionSubmitter();
