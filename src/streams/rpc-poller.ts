import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';
import { signalManager } from './signal-manager.js';

export class SolanaRpcPoller {
  private connection: Connection;
  private isRunning: boolean = false;
  private lastSignatureMap: Map<string, string> = new Map();
  private pollIntervalMs: number = 500; // Poll every 2 seconds on public RPC
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, 'processed');
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.info('[RPC Poller] Live mainnet polling active for watched target wallets...');
    this.pollLoop();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const watched = db.getWatchedWallets().filter((w) => w.enabled);
      for (const target of watched) {
        await this.checkWallet(target.wallet);
      }
    } catch (err) {
      // Ignore network hiccup on polling
    }

    if (this.isRunning) {
      this.timer = setTimeout(() => this.pollLoop(), this.pollIntervalMs);
    }
  }

  private async checkWallet(walletPubkeyStr: string): Promise<void> {
    try {
      const pubkey = new PublicKey(walletPubkeyStr);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 3 }, 'confirmed');
      if (!sigs || sigs.length === 0) return;

      const latestSig = sigs[0].signature;
      const lastKnown = this.lastSignatureMap.get(walletPubkeyStr);

      if (!lastKnown) {
        // First run: store latest signature so we only trigger on NEW trades
        this.lastSignatureMap.set(walletPubkeyStr, latestSig);
        return;
      }

      if (latestSig === lastKnown) {
        // No new trade
        return;
      }

      // New trade detected!
      this.lastSignatureMap.set(walletPubkeyStr, latestSig);
      console.info(`[RPC Poller ⚡] NEW LIVE ON-CHAIN TRANSACTION DETECTED for ${walletPubkeyStr}: ${latestSig}`);

      const observedAt = process.hrtime.bigint();
      const txRes = await this.connection.getParsedTransaction(latestSig, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });

      if (!txRes || !txRes.transaction) return;

      // Skip failed on-chain transactions (e.g. slippage error 6042)
      if (txRes.meta && txRes.meta.err) {
        console.info(`[RPC Poller] Skipped failed on-chain target transaction: ${latestSig}`);
        return;
      }

      const message = txRes.transaction.message;
      const accountKeys = message.accountKeys.map((k: any) =>
        typeof k === 'string' ? k : k.pubkey.toBase58()
      );
      const signers = message.accountKeys
        .filter((k: any) => (typeof k === 'object' ? k.signer : false))
        .map((k: any) => (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58()));

      const instructions = (message.instructions || []).map((ix: any) => {
        const programId = ix.programId ? ix.programId.toBase58() : ix.program || '';
        const accounts = (ix.accounts || []).map((a: any) =>
          typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a)
        );
        const data = Buffer.from(ix.data || '', 'base64');
        return { programId, accounts, data };
      });

      const envelope: ParsedTransactionEnvelope = {
        signature: latestSig,
        slot: txRes.slot,
        signers: signers.length > 0 ? signers : [accountKeys[0]],
        accountKeys,
        instructions,
        meta: txRes.meta
          ? {
              err: txRes.meta.err,
              fee: txRes.meta.fee,
              preBalances: txRes.meta.preBalances,
              postBalances: txRes.meta.postBalances,
              preTokenBalances: txRes.meta.preTokenBalances as any,
              postTokenBalances: txRes.meta.postTokenBalances as any,
            }
          : undefined,
        observedAt,
      };

      // Ingest live into hot path!
      await signalManager.handleIncomingTransaction(envelope, 'RPC_FALLBACK', 'CONFIRMED');
    } catch (err: any) {
      console.warn('[RPC Poller Error]:', err?.message || err);
    }
  }
}

export const rpcPoller = new SolanaRpcPoller();
