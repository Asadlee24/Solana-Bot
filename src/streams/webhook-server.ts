import crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from '../config/index.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';

export interface WebhookHandlerCallbacks {
  onTransaction: (tx: ParsedTransactionEnvelope) => void;
}

export class WebhookReceiver {
  private callbacks: WebhookHandlerCallbacks;

  constructor(callbacks: WebhookHandlerCallbacks) {
    this.callbacks = callbacks;
  }

  public handleHeliusWebhook = (req: Request, res: Response): void => {
    // 1. Fail-closed secret verification: Reject if secret is not configured
    const configuredSecret = config.HELIUS_WEBHOOK_SECRET ? config.HELIUS_WEBHOOK_SECRET.trim() : '';
    if (!configuredSecret) {
      if (config.ALLOW_UNAUTHENTICATED_WEBHOOK && config.NODE_ENV !== 'production') {
        console.warn('[Webhook Security Warning] ALLOW_UNAUTHENTICATED_WEBHOOK=true in dev mode; accepting unauthenticated webhook.');
      } else {
        console.warn('[Webhook Security] Webhook rejected: HELIUS_WEBHOOK_SECRET is not configured.');
        res.status(503).json({ error: 'Webhook ingestion is disabled: HELIUS_WEBHOOK_SECRET is not configured' });
        return;
      }
    } else {
      const authHeader = (req.headers.authorization || req.headers['x-webhook-secret']) as string | undefined;
      if (!authHeader) {
        console.warn('[Webhook Security] Blocked webhook: Missing authorization header.');
        res.status(401).json({ error: 'Unauthorized: Missing webhook secret' });
        return;
      }

      const expectedBuf = Buffer.from(configuredSecret);
      const actualBuf = Buffer.from(authHeader.trim());
      const isValid = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!isValid) {
        console.warn('[Webhook Security] Blocked unauthenticated webhook payload (invalid secret).');
        res.status(401).json({ error: 'Unauthorized: Invalid webhook secret' });
        return;
      }
    }

    // 2. Minimum payload structure validation
    const payload = req.body;
    if (!Array.isArray(payload) || payload.length === 0) {
      res.status(400).json({ error: 'Bad Request: Expected non-empty JSON array of transaction objects' });
      return;
    }

    if (payload.length > 50) {
      res.status(400).json({ error: 'Bad Request: Batch payload exceeds maximum limit of 50 transactions' });
      return;
    }

    const observedAt = process.hrtime.bigint();
    const envelopes: ParsedTransactionEnvelope[] = [];

    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      try {
        const envelope = this.transformWebhookItem(item, observedAt);
        if (envelope) {
          envelopes.push(envelope);
        }
      } catch (err) {
        console.warn('[Webhook Transform Error]:', err);
      }
    }

    if (envelopes.length === 0) {
      res.status(400).json({ error: 'Bad Request: No valid transaction envelopes could be parsed from payload' });
      return;
    }

    // 3. Acknowledge promptly to prevent Helius delivery timeouts and dispatch
    res.status(200).json({ success: true, processed: envelopes.length });

    for (const env of envelopes) {
      try {
        this.callbacks.onTransaction(env);
      } catch (err) {
        console.warn('[Webhook Callback Error]:', err);
      }
    }
  };

  private transformWebhookItem(item: any, observedAt: bigint): ParsedTransactionEnvelope | null {
    const signature = item.signature || (item.transaction && item.transaction.signatures?.[0]);
    if (!signature) return null;

    const accountKeys = (item.accountData || []).map((a: any) => a.account);
    const instructions = (item.instructions || []).map((ix: any) => ({
      programId: ix.programId,
      accounts: ix.accounts || [],
      data: Buffer.from(ix.data || '', 'base64'),
    }));

    return {
      signature,
      slot: item.slot || 0,
      signers: [item.feePayer || ''],
      accountKeys,
      instructions,
      observedAt,
    };
  }
}
