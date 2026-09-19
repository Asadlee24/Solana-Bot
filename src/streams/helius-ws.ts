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

export class HeliusWebSocketStream {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private callbacks: HeliusWsCallbacks;
  private url: string;
  private connection: Connection;
  private recentSigs: Set<string> = new Set();

  constructor(callbacks: HeliusWsCallbacks) {
    this.callbacks = callbacks;
    this.url = config.HELIUS_WSS_URL.includes('api-key=') && !config.HELIUS_WSS_URL.endsWith('=')
      ? config.HELIUS_WSS_URL
      : `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    this.connection = new Connection(config.SOLANA_RPC_URL, 'processed');
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
    if (!config.HELIUS_API_KEY) {
      console.info('[Helius WS] No HELIUS_API_KEY supplied. WebSocket live stream idle (use Replay Stream or supply key in .env).');
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.info('[Helius WS] Connected to Helius Real-Time WebSocket stream');
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

          // 1. Instant logsNotification (<50ms real-time event from Helius)
          if (parsed.method === 'logsNotification' && parsed.params?.result?.value) {
            const val = parsed.params.result.value;
            const signature = val.signature;
            if (!signature || val.err) return; // Skip failed on-chain transactions

            // In-flight deduplication check
            if (this.recentSigs.has(signature)) return;
            this.recentSigs.add(signature);
            if (this.recentSigs.size > 500) {
              const first = this.recentSigs.values().next().value;
              if (first) this.recentSigs.delete(first);
            }

            this.fetchAndDispatch(signature, observedAt);
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
        console.info('[Helius WS] Disconnected. Reconnecting in 3 seconds...');
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        if (this.isRunning) {
          this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
        }
      });
    } catch (err) {
      console.warn('[Helius WS Connection Exception]:', err);
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
      }
    }
  }

  public subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let dbWallets: string[] = [];
    try {
      dbWallets = db.getWatchedWallets().filter((w) => w.enabled).map((w) => w.wallet);
    } catch {
      // ignore
    }
    const allWallets = dbWallets.length > 0 ? dbWallets : config.WATCHED_WALLETS;

    for (const wallet of allWallets) {
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
    }
    console.info(`[Helius WS] Subscribed to ${allWallets.length} target wallet(s) via real-time logsSubscribe feed.`);
  }

  public resubscribe(): void {
    console.info('[Helius WS] Refreshing target wallet subscriptions...');
    this.subscribe();
  }

  private async fetchAndDispatch(signature: string, observedAt: bigint): Promise<void> {
    try {
      const txRes = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });
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
