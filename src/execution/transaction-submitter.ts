import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  PublicKey,
  SendOptions,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { config, validateHeliusSenderTip } from '../config/index.js';

export type LandingProvider =
  | 'STANDARD_RPC'
  | 'HELIUS_SWQOS'
  | 'HELIUS_SENDER_MAX'
  | 'JUPITER_EXECUTE';

export const HELIUS_SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
];

export interface SubmissionReceipt {
  signature: string;
  status: 'SUBMITTED' | 'PROCESSED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'DROPPED';
  provider: LandingProvider;
  slot?: number;
  submittedAt: bigint;
  confirmedAt?: bigint;
  error?: string;
}

export class TransactionSubmitter {
  private connection: Connection;

  constructor(connection?: Connection) {
    this.connection =
      connection ||
      new Connection(config.SOLANA_RPC_URL, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 20000,
      });
  }

  /**
   * Helper to build a verified Helius Sender tip transfer instruction.
   */
  public createTipInstruction(
    payer: PublicKey,
    tipLamports: bigint = BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
    accountIndex: number = 0
  ): TransactionInstruction {
    const tipAccount = new PublicKey(
      HELIUS_SENDER_TIP_ACCOUNTS[accountIndex % HELIUS_SENDER_TIP_ACCOUNTS.length]
    );
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });
  }

  /**
   * Resolves the real landing provider and endpoint URL based on active configuration.
   * STRICT GUARD: Never labels standard RPC as Helius Sender.
   */
  public resolveLandingProvider(): { provider: LandingProvider; endpointUrl: string } {
    if (config.HELIUS_API_KEY || config.HELIUS_SENDER_URL) {
      const mode = config.HELIUS_SENDER_MODE;
      const provider: LandingProvider = mode === 'MAX' ? 'HELIUS_SENDER_MAX' : 'HELIUS_SWQOS';

      if (config.HELIUS_SENDER_URL) {
        return { provider, endpointUrl: config.HELIUS_SENDER_URL.trim() };
      }

      const swqosOnly = mode === 'SWQOS' ? 'true' : 'false';
      const endpointUrl = `https://sender.helius-rpc.com/fast?api-key=${config.HELIUS_API_KEY.trim()}&swqos_only=${swqosOnly}`;
      return { provider, endpointUrl };
    }

    return { provider: 'STANDARD_RPC', endpointUrl: config.SOLANA_RPC_URL };
  }

  /**
   * High-speed submission with preflight simulation, real Helius Sender / Standard RPC routing,
   * monotonic latency timer tracking, and fail-safe confirmation.
   */
  public async submitAndConfirm(
    transaction: VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
    signature: string
  ): Promise<SubmissionReceipt> {
    const { provider, endpointUrl } = this.resolveLandingProvider();

    // 1. Validate Helius Sender tip compliance if using Helius Sender
    if (provider === 'HELIUS_SWQOS' || provider === 'HELIUS_SENDER_MAX') {
      const tipValidation = validateHeliusSenderTip(
        config.HELIUS_SENDER_MODE,
        config.HELIUS_SENDER_TIP_LAMPORTS
      );
      if (!tipValidation.valid) {
        console.warn(`[Helius Sender Tip Warning] ${tipValidation.error}`);
      }
    }

    // 2. Preflight Simulation Check (Required for live smoke test safety)
    if (config.LIVE_REQUIRE_SIMULATION) {
      const simResult = await this.connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: false,
      });

      if (simResult.value.err) {
        const errorLogs = simResult.value.logs?.slice(-4).join('; ') || 'No logs available';
        const simErrMsg = `Preflight simulation rejected: ${JSON.stringify(simResult.value.err)} | Logs: ${errorLogs}`;
        console.error(`[SIMULATION REJECTED] ${simErrMsg}`);
        return {
          signature,
          status: 'FAILED',
          provider,
          submittedAt: process.hrtime.bigint(),
          error: simErrMsg,
        };
      }
    }

    const rawTx = transaction.serialize();
    const submittedAt = process.hrtime.bigint();

    // 3. Dispatch through resolved provider
    try {
      if (provider === 'HELIUS_SWQOS' || provider === 'HELIUS_SENDER_MAX') {
        // Send via official Helius Sender HTTP JSON-RPC endpoint
        const txBase64 = Buffer.from(rawTx).toString('base64');
        const payload = {
          jsonrpc: '2.0',
          id: `helius-sender-${Date.now()}`,
          method: 'sendTransaction',
          params: [
            txBase64,
            {
              encoding: 'base64',
              skipPreflight: true,
              maxRetries: 0,
              preflightCommitment: 'processed',
            },
          ],
        };

        const res = await fetch(endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[Helius Sender HTTP ${res.status}] ${errText}. Checking on-chain status...`);
        } else {
          const data = (await res.json()) as any;
          if (data.error) {
            console.warn(`[Helius Sender RPC Error] ${JSON.stringify(data.error)}. Checking on-chain status...`);
          }
        }
      } else {
        // Standard RPC dispatch
        const sendOptions: SendOptions = {
          skipPreflight: true,
          maxRetries: 2,
          preflightCommitment: 'processed',
        };
        await this.connection.sendRawTransaction(rawTx, sendOptions);
      }
    } catch (sendErr: any) {
      console.warn(
        `[Submitter] Initial send returned error for ${signature} via ${provider}: ${sendErr.message}. Checking on-chain status...`
      );
    }

    // 4. Await strict on-chain confirmation (PROCESSED does NOT equal CONFIRMED)
    return await this.reconcileStatus(signature, latestBlockhash, submittedAt, provider);
  }

  /**
   * Reconciles transaction status against Solana validators.
   * STRICT GUARD: PROCESSED status is NOT sufficient for fill.
   * Continues polling until CONFIRMED or blockhash expiration.
   */
  public async reconcileStatus(
    signature: string,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
    submittedAt: bigint,
    provider: LandingProvider = 'STANDARD_RPC',
    timeoutMs: number = 30000
  ): Promise<SubmissionReceipt> {
    const startTime = Date.now();
    let seenProcessed = false;
    let processedSlot: number | undefined = undefined;

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
              provider,
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
              provider,
              slot: status.slot,
              submittedAt,
              confirmedAt: process.hrtime.bigint(),
            };
          }

          if (status.confirmationStatus === 'processed') {
            seenProcessed = true;
            processedSlot = status.slot;
            // DO NOT RETURN EARLY! Keep polling until confirmed or expired.
          }
        }

        // Check if blockhash has expired on-chain
        const currentBlockHeight = await this.connection.getBlockHeight('processed');
        if (currentBlockHeight > latestBlockhash.lastValidBlockHeight) {
          // Double-check one final time before declaring EXPIRED
          const finalCheck = await this.connection.getSignatureStatuses([signature]);
          const finalStatus = finalCheck.value?.[0];
          if (
            finalStatus &&
            !finalStatus.err &&
            (finalStatus.confirmationStatus === 'confirmed' ||
              finalStatus.confirmationStatus === 'finalized')
          ) {
            return {
              signature,
              status: 'CONFIRMED',
              provider,
              slot: finalStatus.slot,
              submittedAt,
              confirmedAt: process.hrtime.bigint(),
            };
          }

          return {
            signature,
            status: 'EXPIRED',
            provider,
            slot: processedSlot,
            submittedAt,
            error: `Blockhash expired. Current height ${currentBlockHeight} > ${latestBlockhash.lastValidBlockHeight}`,
          };
        }
      } catch (err: any) {
        // Transient network error: continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    // Timeout reached without confirmation
    try {
      const finalCheck = await this.connection.getSignatureStatuses([signature]);
      const st = finalCheck.value?.[0];
      if (
        st &&
        !st.err &&
        (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
      ) {
        return {
          signature,
          status: 'CONFIRMED',
          provider,
          slot: st.slot,
          submittedAt,
          confirmedAt: process.hrtime.bigint(),
        };
      }
    } catch {}

    if (seenProcessed) {
      return {
        signature,
        status: 'DROPPED',
        provider,
        slot: processedSlot,
        submittedAt,
        error: 'Transaction was seen as PROCESSED but failed to confirm within timeout.',
      };
    }

    return {
      signature,
      status: 'FAILED',
      provider,
      submittedAt,
      error: 'Transaction confirmation polling timed out without on-chain proof of execution.',
    };
  }
}

export const transactionSubmitter = new TransactionSubmitter();
