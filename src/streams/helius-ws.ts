import WebSocket from 'ws';
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
  private callbacks: HeliusWsCallbacks;
  private url: string;

  constructor(callbacks: HeliusWsCallbacks) {
    this.callbacks = callbacks;
    this.url = config.HELIUS_WSS_URL.includes('api-key=') && !config.HELIUS_WSS_URL.endsWith('=')
      ? config.HELIUS_WSS_URL
      : `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
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
        console.info('[Helius WS] Connected to Helius LaserStream / WebSocket feed');
        this.subscribe();
        this.callbacks.onOpen?.();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const observedAt = process.hrtime.bigint();
        try {
          const text = data.toString();
          const parsed = JSON.parse(text);

          // Handle subscription responses or transaction notifications
          if (parsed.params && parsed.params.result) {
            const result = parsed.params.result;
            const tx = this.transformResult(result, observedAt);
            if (tx) {
              this.callbacks.onTransaction(tx);
            }
          }
        } catch (err) {
          // Skip unparseable heartbeats
        }
      });

      this.ws.on('error', (err) => {
        console.warn('[Helius WS Error]:', err.message);
        this.callbacks.onError?.(err);
      });

      this.ws.on('close', () => {
        console.info('[Helius WS] Disconnected. Reconnecting in 3 seconds...');
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
    const allWallets = Array.from(new Set([...config.WATCHED_WALLETS, ...dbWallets]));

    for (const wallet of allWallets) {
      // Standard transactionSubscribe / logsSubscribe
      const msg = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            mentions: [wallet],
            failed: false,
          },
          {
            commitment: 'processed',
            encoding: 'json',
            transactionDetails: 'full',
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  public resubscribe(): void {
    console.info('[Helius WS] Refreshing target wallet subscriptions...');
    this.subscribe();
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
