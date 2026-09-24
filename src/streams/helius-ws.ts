import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';

export interface HeliusWsCallbacks {
  onTransaction: (tx: ParsedTransactionEnvelope) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
}

let activeWsStream: HeliusWebSocketStream | null = null;

export function isRealTimeStreamConnected(): boolean {
  return activeWsStream !== null && activeWsStream.isConnected();
}

export class HeliusWebSocketStream {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private callbacks: HeliusWsCallbacks;
  private url: string;
  private connection: Connection;
  private recentSigs: Set<string> = new Set();
  private reconnectAttempts: number = 0;
  private activeFetches: number = 0;
  private readonly maxConcurrentFetches: number = 2;
  private pendingQueue: Array<{ signature: string; observedAt: bigint }> = [];

  constructor(callbacks: HeliusWsCallbacks) {
    this.callbacks = callbacks;
    activeWsStream = this;
    if (config.HELIUS_WSS_URL && config.HELIUS_WSS_URL.startsWith('wss://') && !config.HELIUS_WSS_URL.endsWith('=')) {
      this.url = config.HELIUS_WSS_URL;
    } else if (config.HELIUS_API_KEY) {
      this.url = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    } else {
      this.url = config.SOLANA_RPC_URL.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    }
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'processed',
      disableRetryOnRateLimit: true,
    });
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.url) {
      console.info('[WS Stream] No WebSocket URL supplied. Stream idle.');
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        console.info('[WS Stream] Connected to Real-Time WebSocket stream');
        this.subscribe();
        this.callbacks.onOpen?.();

        // 30-second ping heartbeat to prevent WebSocket dropping
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.ping();
            } catch {}
          }
        }, 30000);
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const observedAt = process.hrtime.bigint();
        try {
          const text = data.toString();
          const parsed = JSON.parse(text);

const SWAP_PROGRAMS_AND_KEYWORDS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H045', // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', // Moonshot
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Pools
  'Swap',
  'swap',
  'Buy',
  'buy',
  'Sell',
  'sell',
];

          // 1. Instant logsNotification (<50ms real-time event from Helius)
          if (parsed.method === 'logsNotification' && parsed.params?.result?.value) {
            const val = parsed.params.result.value;
            const signature = val.signature;
            if (!signature || val.err) return; // Skip failed on-chain transactions

            // Pre-filter: Check logs to ensure transaction involves a swap / DEX trade
            if (Array.isArray(val.logs) && val.logs.length > 0) {
              const logsText = val.logs.join(' ');
              const hasSwapIntent = SWAP_PROGRAMS_AND_KEYWORDS.some((kw) => logsText.includes(kw));
              if (!hasSwapIntent) {
                return; // Silently drop non-swap/spam logs before spending an RPC call!
              }
            }

            // In-flight deduplication check
            if (this.recentSigs.has(signature)) return;
            this.recentSigs.add(signature);
            if (this.recentSigs.size > 500) {
              const first = this.recentSigs.values().next().value;
              if (first) this.recentSigs.delete(first);
            }

            this.enqueueFetch(signature, observedAt);
            return;
          }

          // 2. Fallback for transactionSubscribe if available on paid tier
          if (parsed.params && parsed.params.result) {
            const result = parsed.params.result;
            const tx = this.transformResult(result, observedAt);
            if (tx) {
              this.callbacks.onTransaction(tx);
            }
          }
        } catch {
          // Skip unparseable heartbeats
        }
      });

      this.ws.on('error', (err) => {
        console.warn('[Helius WS Error]:', err.message);
        this.callbacks.onError?.(err);
      });

      this.ws.on('close', () => {
        this.reconnectAttempts++;
        const backoffSeconds = Math.min(30, 3 * Math.pow(1.5, Math.min(this.reconnectAttempts - 1, 5)));
        const delayMs = Math.round(backoffSeconds * 1000);
        console.info(`[Helius WS] Disconnected. Reconnecting in ${(delayMs / 1000).toFixed(0)} seconds (attempt #${this.reconnectAttempts})...`);
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        if (this.isRunning) {
          this.reconnectTimeout = setTimeout(() => this.connect(), delayMs);
        }
      });
    } catch (err) {
      console.warn('[Helius WS Connection Exception]:', err);
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
      }
    }
  }

  public async subscribe(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let dbWallets: string[] = [];
    try {
      dbWallets = db.getWatchedWallets().filter((w) => w.enabled).map((w) => w.wallet);
    } catch {
      // ignore
    }
    const allWallets = dbWallets.length > 0 ? dbWallets : config.WATCHED_WALLETS;

    for (const wallet of allWallets) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      // logsSubscribe: Universally supported on all plans with sub-50ms push notifications
      const msg = {
        jsonrpc: '2.0',
        id: Date.now() + Math.floor(Math.random() * 1000),
        method: 'logsSubscribe',
        params: [
          {
            mentions: [wallet],
          },
          {
            commitment: 'processed',
          },
        ],
      };
      this.ws.send(JSON.stringify(msg));
      if (allWallets.length > 1) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    console.info(`[Helius WS] Subscribed to ${allWallets.length} target wallet(s) via real-time logsSubscribe feed.`);
  }

  public resubscribe(): void {
    console.info('[Helius WS] Refreshing target wallet subscriptions...');
    this.subscribe().catch(() => {});
  }

  private enqueueFetch(signature: string, observedAt: bigint): void {
    if (this.pendingQueue.length > 20) {
      this.pendingQueue.shift(); // Drop oldest to avoid lag buildup
    }
    this.pendingQueue.push({ signature, observedAt });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeFetches >= this.maxConcurrentFetches || this.pendingQueue.length === 0) {
      return;
    }

    const item = this.pendingQueue.shift();
    if (!item) return;

    // Check age of signal - if older than 2.5s, it is already too stale to copy
    const ageMs = Number(process.hrtime.bigint() - item.observedAt) / 1e6;
    if (ageMs > 2500) {
      this.processQueue();
      return;
    }

    this.activeFetches++;
    try {
      await this.fetchAndDispatch(item.signature, item.observedAt);
    } catch {
      // ignore
    } finally {
      this.activeFetches--;
      setTimeout(() => this.processQueue(), 50);
    }
  }

  private async fetchParsedTxWithRetry(signature: string, maxRetries = 2, initialDelayMs = 50): Promise<any> {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const txRes = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed' as any,
        });
        if (txRes && txRes.transaction) {
          return txRes;
        }
      } catch (err: any) {
        if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests')) {
          return null;
        }
        if (attempt === maxRetries) return null;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 200);
    }
    return null;
  }

  private async fetchAndDispatch(signature: string, observedAt: bigint): Promise<void> {
    try {
      const txRes = await this.fetchParsedTxWithRetry(signature);
      if (!txRes || !txRes.transaction) return;
      if (txRes.meta && txRes.meta.err) return;

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

      console.info(`[Helius WS ⚡] REAL-TIME SIGNAL DETECTED (<50ms): ${signature}`);
      this.callbacks.onTransaction(envelope);
    } catch {
      // Ignore transient fetch error
    }
  }

  private transformResult(result: any, observedAt: bigint): ParsedTransactionEnvelope | null {
    if (!result.transaction) return null;
    const tx = result.transaction;
    const meta = result.meta;
    const message = tx.message || tx.transaction?.message;
    if (!message) return null;

    const accountKeys = (message.accountKeys || []).map((k: any) =>
      typeof k === 'string' ? k : k.pubkey
    );

    const signers = (message.accountKeys || [])
      .filter((k: any) => (typeof k === 'object' ? k.signer : false))
      .map((k: any) => k.pubkey);

    const instructions = (message.instructions || []).map((ix: any) => {
      const programId =
        typeof ix.programIdIndex === 'number'
          ? accountKeys[ix.programIdIndex]
          : ix.programId;
      const accounts = (ix.accounts || []).map((idx: number) => accountKeys[idx] || '');
      const data = Buffer.from(ix.data || '', 'base64');
      return { programId, accounts, data };
    });

    const innerInstructions: any[] = [];
    if (meta && meta.innerInstructions) {
      for (const group of meta.innerInstructions) {
        const mapped = (group.instructions || []).map((ix: any) => {
          const programId =
            typeof ix.programIdIndex === 'number'
              ? accountKeys[ix.programIdIndex]
              : ix.programId;
          const accounts = (ix.accounts || []).map((idx: number) => accountKeys[idx] || '');
          const data = Buffer.from(ix.data || '', 'base64');
          return { programId, accounts, data };
        });
        innerInstructions.push({ index: group.index, instructions: mapped });
      }
    }

    return {
      signature: result.signature || tx.signatures?.[0] || 'UNKNOWN_SIG',
      slot: result.slot || 0,
      signers: signers.length > 0 ? signers : [accountKeys[0] || ''],
      accountKeys,
      instructions,
      innerInstructions,
      observedAt,
    };
  }
}
