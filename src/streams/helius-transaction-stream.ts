import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { config } from '../config/index.js';
import { ParsedTransactionEnvelope, RawInstruction } from '../parsers/fast-decoder.js';
import { HeliusWebSocketStream, HeliusWsCallbacks } from './helius-ws.js';

export class HeliusTransactionStream {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private isFallbackMode: boolean = false;
  private fallbackStream: HeliusWebSocketStream | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private callbacks: HeliusWsCallbacks;
  private url: string;
  private recentSignatures: Set<string> = new Set();
  private readonly maxRecentSignatures = 5000;
  private watchedWallets: string[] = [];
  private subscriptionId: number | null = null;
  private reconnectAttempts = 0;

  constructor(callbacks: HeliusWsCallbacks, watchedWallets: string[] = []) {
    this.callbacks = callbacks;
    this.watchedWallets = watchedWallets;

    if (
      config.HELIUS_WSS_URL &&
      config.HELIUS_WSS_URL.startsWith('wss://') &&
      !config.HELIUS_WSS_URL.endsWith('=')
    ) {
      this.url = config.HELIUS_WSS_URL;
    } else if (config.HELIUS_API_KEY) {
      // Helius LaserStream / Enhanced WebSockets dedicated gateway (Developer+ plans)
      this.url = `wss://atlas-mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    } else {
      this.url = config.SOLANA_RPC_URL.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    }
  }

  public isUsingTransactionFeed(): boolean {
    return !this.isFallbackMode && this.isConnected();
  }

  public isFallback(): boolean {
    return this.isFallbackMode;
  }

  public isConnected(): boolean {
    if (this.isFallbackMode && this.fallbackStream) {
      return this.fallbackStream.isConnected();
    }
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public updateWatchedWallets(wallets: string[]): void {
    this.watchedWallets = wallets;
    if (this.isFallbackMode) {
      // logsSubscribe stream handles wallet filtering internally
      return;
    }
    if (this.isConnected()) {
      this.subscribeTransactionFeed();
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // If configured to explicitly use LOGS feed, start fallback stream immediately
    if (config.HELIUS_TRANSACTION_FEED_MODE === 'LOGS_FALLBACK') {
      console.info('[HeliusStream] HELIUS_TRANSACTION_FEED_MODE=LOGS_FALLBACK. Using logsSubscribe feed.');
      this.startFallback();
      return;
    }

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
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (this.fallbackStream) {
      this.fallbackStream.stop();
      this.fallbackStream = null;
    }
  }

  private connect(): void {
    if (!this.url || !this.isRunning) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        console.info('[HeliusTransactionStream ⚡] Connected to Helius Full-Transaction WebSocket stream');
        this.subscribeTransactionFeed();
        this.callbacks.onOpen?.();

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

          // Handle subscription response
          if (parsed.id === 101) {
            if (parsed.error) {
              console.warn(
                `[HeliusTransactionStream] transactionSubscribe rejected: ${JSON.stringify(parsed.error)}. Initiating clean fallback to logsSubscribe.`
              );
              this.startFallback();
              return;
            }
            this.subscriptionId = parsed.result;
            console.info(`[HeliusTransactionStream ⚡] Subscribed to full transaction feed (subscription: ${this.subscriptionId})`);
            return;
          }

          // Handle transaction notification
          if (parsed.method === 'transactionNotification' && parsed.params?.result) {
            const envelope = this.transformNotification(parsed.params.result, observedAt);
            if (!envelope) return;

            // Duplicate signature deduplication
            if (this.recentSignatures.has(envelope.signature)) {
              return;
            }
            this.recentSignatures.add(envelope.signature);
            if (this.recentSignatures.size > this.maxRecentSignatures) {
              const firstKey = this.recentSignatures.values().next().value;
              if (firstKey) this.recentSignatures.delete(firstKey);
            }

            console.info(`[HeliusTransactionStream ⚡] Full transaction received without RPC fetch: ${envelope.signature.slice(0, 8)}...`);
            this.callbacks.onTransaction(envelope);
          }
        } catch (err: any) {
          console.error('[HeliusTransactionStream] Message processing error:', err.message);
        }
      });

      this.ws.on('error', (err: Error) => {
        console.warn(`[HeliusTransactionStream] WebSocket error: ${err.message}`);
        this.callbacks.onError?.(err);
      });

      this.ws.on('close', (code, reason) => {
        console.warn(`[HeliusTransactionStream] WebSocket closed (${code}: ${reason}). Scheduling reconnect...`);
        this.scheduleReconnect();
      });
    } catch (err: any) {
      console.warn(`[HeliusTransactionStream] Connection setup failed: ${err.message}. Starting fallback.`);
      this.startFallback();
    }
  }

  private subscribeTransactionFeed(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Filter accounts by watched wallets if available
    const accountFilter =
      this.watchedWallets.length > 0 ? { accountInclude: this.watchedWallets } : {};

    const req = {
      jsonrpc: '2.0',
      id: 101,
      method: 'transactionSubscribe',
      params: [
        {
          ...accountFilter,
          vote: false,
          failed: false,
        },
        {
          commitment: 'processed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    try {
      this.ws.send(JSON.stringify(req));
    } catch (err: any) {
      console.error('[HeliusTransactionStream] Failed to send subscription:', err);
    }
  }

  private startFallback(): void {
    if (this.isFallbackMode) return;
    this.isFallbackMode = true;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    if (!config.FAST_PATH_FALLBACK_ENABLED) {
      console.warn('[HeliusStream] Fallback disabled by FAST_PATH_FALLBACK_ENABLED=false');
      return;
    }

    console.info('[HeliusStream] Starting fallback HeliusWebSocketStream (logsSubscribe)...');
    this.fallbackStream = new HeliusWebSocketStream(this.callbacks);
    this.fallbackStream.start();
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.isFallbackMode) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      console.info(`[HeliusTransactionStream] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();
    }, delay);
  }

  /**
   * Transforms incoming full transaction notification to ParsedTransactionEnvelope in microsecond time
   */
  public transformNotification(result: any, observedAt: bigint): ParsedTransactionEnvelope | null {
    if (!result || !result.transaction) return null;
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

    const instructions: RawInstruction[] = (message.instructions || []).map((ix: any) => {
      const programId =
        typeof ix.programIdIndex === 'number'
          ? accountKeys[ix.programIdIndex]
          : ix.programId;
      const accounts = (ix.accounts || []).map((idx: number) => accountKeys[idx] || '');
      const data = Buffer.from(ix.data || '', 'base64');
      return { programId, accounts, data };
    });

    const innerInstructions: Array<{ index: number; instructions: RawInstruction[] }> = [];
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

    const envelopeMeta = meta
      ? {
          err: meta.err,
          fee: meta.fee ?? 0,
          preBalances: meta.preBalances || [],
          postBalances: meta.postBalances || [],
          preTokenBalances: meta.preTokenBalances || [],
          postTokenBalances: meta.postTokenBalances || [],
          loadedAddresses: meta.loadedAddresses,
        }
      : undefined;

    return {
      signature: result.signature || tx.signatures?.[0] || 'UNKNOWN_SIG',
      slot: result.slot || 0,
      signers: signers.length > 0 ? signers : [accountKeys[0] || ''],
      accountKeys,
      instructions,
      innerInstructions,
      meta: envelopeMeta,
      observedAt,
    };
  }
}
