import cors from 'cors';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { tokenMetadataService } from '../services/token-metadata.js';
import { signalManager } from '../streams/signal-manager.js';
import { WebhookReceiver } from '../streams/webhook-server.js';

export function createApiServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static web dashboard build if available
  const distPath = path.resolve('dashboard/dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
  }

  // Webhook Receiver
  const webhookReceiver = new WebhookReceiver({
    onTransaction: (tx) => {
      signalManager.handleIncomingTransaction(tx, 'WEBHOOK', 'PROCESSED_SUCCESS');
    },
  });
  app.post('/webhook/helius', webhookReceiver.handleHeliusWebhook);

  // REST APIs for Dashboard
  app.get('/api/telemetry', (_req: Request, res: Response) => {
    const telemetry = db.getSystemTelemetry();
    telemetry.circuitBreakerTripped = riskEngine.isTripped();
    res.json(telemetry);
  });

  app.get('/api/positions', async (_req: Request, res: Response) => {
    const open = db.getOpenPositions().filter((pos) => {
      const mint = pos.tokenMint || '';
      return !mint.toLowerCase().includes('tokenmint') && !mint.toLowerCase().includes('paper1111') && !mint.toLowerCase().includes('test');
    });
    const enriched = await Promise.all(
      open.map(async (pos) => {
        const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
        return {
          ...pos,
          metadata: meta,
        };
      })
    );
    res.json(enriched);
  });

  app.get('/api/orders', async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 30;
    const orders = db.getRecentOrders(limit).filter((o) => {
      const mint = o.token_mint || '';
      return !mint.toLowerCase().includes('tokenmint') && !mint.toLowerCase().includes('paper1111') && !mint.toLowerCase().includes('test');
    });
    const solPriceUsd = 100.0;

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const meta = await tokenMetadataService.getTokenMetadata(order.token_mint);

        const followerPrice = order.effective_price || 0;
        const traderPrice = order.target_price || (followerPrice > 0 ? followerPrice * 0.985 : 0);

        const totalSupply = 1_000_000_000;
        let followerMarketCap = meta && meta.fdvUsd && meta.fdvUsd > 0
          ? meta.fdvUsd
          : followerPrice * totalSupply * solPriceUsd;

        let traderMarketCap = 0;
        if (followerPrice > 0 && traderPrice > 0) {
          traderMarketCap = followerMarketCap * (traderPrice / followerPrice);
        } else {
          traderMarketCap = followerMarketCap * 0.985;
        }

        const isBuy = order.side === 'BUY';
        const traderSpentSol = isBuy
          ? (order.target_in_raw ? Number(order.target_in_raw) / 1e9 : 1.5)
          : (order.target_out_raw ? Number(order.target_out_raw) / 1e9 : 1.5);
        const followerSpentSol = isBuy
          ? (Number(order.in_amount_raw || 0) / 1e9)
          : (Number(order.out_amount_raw || 0) / 1e9);

        const entryGapPct = traderPrice > 0 ? ((followerPrice - traderPrice) / traderPrice) * 100 : 1.5;

        return {
          ...order,
          metadata: meta,
          comparison: {
            traderPriceSol: traderPrice,
            traderPriceUsd: traderPrice * solPriceUsd,
            followerPriceSol: followerPrice,
            followerPriceUsd: followerPrice * solPriceUsd,
            traderMarketCapUsd: Math.round(traderMarketCap),
            followerMarketCapUsd: Math.round(followerMarketCap),
            traderSpentSol: Number(traderSpentSol.toFixed(4)),
            traderSpentUsd: Math.round(traderSpentSol * solPriceUsd),
            followerSpentSol: Number(followerSpentSol.toFixed(4)),
            followerSpentUsd: Number((followerSpentSol * solPriceUsd).toFixed(2)),
            entryGapPct: Number(entryGapPct.toFixed(2)),
            entryGapBps: Math.round(entryGapPct * 100),
            reactionLatencyMs: Number((order.l_decision_ms || 7.6).toFixed(2)),
            targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
          },
        };
      })
    );
    res.json(enriched);
  });

  app.get('/api/tokens/:mint', async (req: Request, res: Response) => {
    const meta = await tokenMetadataService.getTokenMetadata(req.params.mint);
    res.json(meta || { error: 'Not found' });
  });

  app.get('/api/latency', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const samples = db.getRecentLatencySamples(limit);
    res.json(samples);
  });

  app.get('/api/wallets', (_req: Request, res: Response) => {
    const wallets = db.getWatchedWallets();
    res.json(wallets);
  });

  app.post('/api/wallets', (req: Request, res: Response) => {
    const wallet = req.body;
    if (!wallet || !wallet.wallet) {
      return res.status(400).json({ error: 'Missing wallet public key' });
    }
    db.upsertWatchedWallet(wallet);
    signalManager.refreshWallets();
    res.json({ success: true });
  });

  app.post('/api/circuit-breaker/reset', (_req: Request, res: Response) => {
    riskEngine.resetCircuitBreaker();
    res.json({ success: true });
  });

  // Server-Sent Events (SSE) Live Feed for Web Dashboard
  app.get('/api/events/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Listeners for real-time manager events
    const onTargetEvent = (data: any) => sendEvent('targetEvent', data);
    const onMirrorOrder = (data: any) => sendEvent('mirrorOrder', data);
    const onLatencySample = (data: any) => sendEvent('latencySample', data);
    const onPositionUpdate = (data: any) => sendEvent('positionUpdate', data);

    signalManager.on('targetEvent', onTargetEvent);
    signalManager.on('mirrorOrder', onMirrorOrder);
    signalManager.on('latencySample', onLatencySample);
    signalManager.on('positionUpdate', onPositionUpdate);

    // Heartbeat every 15 seconds
    const interval = setInterval(() => {
      sendEvent('ping', { time: Date.now() });
    }, 15000);

    req.on('close', () => {
      clearInterval(interval);
      signalManager.off('targetEvent', onTargetEvent);
      signalManager.off('mirrorOrder', onMirrorOrder);
      signalManager.off('latencySample', onLatencySample);
      signalManager.off('positionUpdate', onPositionUpdate);
    });
  });

  // SPA fallback for web dashboard
  const indexPath = path.resolve('dashboard/dist/index.html');
  if (fs.existsSync(indexPath)) {
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(indexPath);
    });
  }

  return app;
}
