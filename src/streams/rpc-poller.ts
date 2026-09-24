import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';
import { signalManager } from './signal-manager.js';
import { isRealTimeStreamConnected } from './helius-ws.js';

export class SolanaRpcPoller {
  private connection: Connection;
  private isRunning: boolean = false;
  private lastSignatureMap: Map<string, string> = new Map();
  private pollIntervalMs: number = 60000; // Backup poller every 60s (WebSocket handles instant hot path)
  private timer: NodeJS.Timeout | null = null;
  private isRateLimited: boolean = false;
  private lastRateLimitLogged: number = 0;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.info('[RPC Poller] Live mainnet polling backup active for watched target wallets...');
    // Give WebSocket 5 seconds to establish connection before running backup poller
    this.timer = setTimeout(() => this.pollLoop(), 5000);
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

    // Failover Redundancy: If WebSocket stream is actively connected, skip polling to avoid 429 rate limits!
    if (isRealTimeStreamConnected()) {
      if (this.isRunning) {
        this.timer = setTimeout(() => this.pollLoop(), 30000);
      }
      return;
    }

    try {
      const watched = db.getWatchedWallets().filter((w) => w.enabled);
      for (const target of watched) {
        if (!this.isRunning || this.isRateLimited) break;
        await this.checkWallet(target.wallet);
        if (this.isRateLimited) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      // Ignore network hiccup on polling
    }

    if (this.isRunning) {
      const interval = this.isRateLimited ? 45000 : this.pollIntervalMs;
      this.timer = setTimeout(() => {
        this.isRateLimited = false;
        this.pollLoop();
      }, interval);
    }
  }

  private async checkWallet(walletPubkeyStr: string): Promise<void> {
    try {
      const pubkey = new PublicKey(walletPubkeyStr);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 10 }, 'confirmed');
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

      // Collect all new signatures since lastKnown in chronological order (oldest to newest)
      const newSigs: typeof sigs = [];
      for (const s of sigs) {
        if (s.signature === lastKnown) break;
        newSigs.push(s);
      }

      // Advance pointer to newest signature
      this.lastSignatureMap.set(walletPubkeyStr, latestSig);

      // Process each transaction in chronological order so bursts and bundles are never missed
      for (const s of newSigs.reverse()) {
        if (s.err) {
          // Immediately skip on-chain failed transactions without wasting RPC calls
          continue;
        }
        await this.processSignature(walletPubkeyStr, s.signature);
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('429') || msg.includes('max usage')) {
        this.isRateLimited = true;
        const now = Date.now();
        if (now - this.lastRateLimitLogged > 60000) {
          this.lastRateLimitLogged = now;
          console.warn('[RPC Poller]: RPC rate limit (429) hit. Backing off for 45s...');
        }
      } else {
        this.isRateLimited = false;
        console.warn('[RPC Poller Error]:', msg);
      }
    }
  }

  private async fetchParsedTxWithRetry(signature: string, maxRetries = 5, initialDelayMs = 40): Promise<any> {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const commitment = (attempt <= 3 ? 'processed' : 'confirmed') as any;
        const txRes = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment,
        });
        if (txRes && txRes.transaction) {
          return txRes;
        }
      } catch (err: any) {
        if (attempt === maxRetries) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 500);
    }
    return null;
  }

  private async processSignature(walletPubkeyStr: string, signature: string): Promise<void> {
    try {
      console.info(`[RPC Poller ⚡] NEW LIVE ON-CHAIN TRANSACTION DETECTED for ${walletPubkeyStr}: ${signature}`);

      const observedAt = process.hrtime.bigint();
      const txRes = await this.fetchParsedTxWithRetry(signature);

      if (!txRes || !txRes.transaction) {
        console.warn(`[RPC Poller] Could not fetch parsed transaction after retries: ${signature}`);
        return;
      }

      // Skip failed on-chain transactions (e.g. slippage error 6042)
      if (txRes.meta && txRes.meta.err) {
        console.info(`[RPC Poller] Skipped failed on-chain target transaction: ${signature}`);
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
        signature,
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
      console.warn(`[RPC Poller] Error processing ${signature}:`, err?.message || err);
    }
  }
}

export const rpcPoller = new SolanaRpcPoller();
