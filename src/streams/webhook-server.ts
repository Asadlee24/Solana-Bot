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
    // Verify Helius webhook authentication secret if configured
    if (config.HELIUS_WEBHOOK_SECRET && config.HELIUS_WEBHOOK_SECRET.trim() !== '') {
      const authHeader = req.headers.authorization;
      if (authHeader !== config.HELIUS_WEBHOOK_SECRET) {
        console.warn('[Webhook Security] Blocked unauthenticated webhook payload.');
        res.status(401).send('Unauthorized');
        return;
      }
    }

    const observedAt = process.hrtime.bigint();
    res.status(200).send('OK'); // Acknowledge promptly to prevent Helius delivery timeouts

    const payload = req.body;
    if (!Array.isArray(payload)) return;

    for (const item of payload) {
      try {
        const envelope = this.transformWebhookItem(item, observedAt);
        if (envelope) {
          this.callbacks.onTransaction(envelope);
        }
      } catch (err) {
        console.warn('[Webhook Transform Error]:', err);
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
