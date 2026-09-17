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

  const getEnrichedPositions = async () => {
    const allowedWallets = new Set(config.WATCHED_WALLETS);
    const open = db.getOpenPositions().filter((pos) => {
      const mint = pos.tokenMint || '';
      const isAllowed = allowedWallets.has(pos.targetWallet);
      const isNotDummy = !mint.toLowerCase().includes('tokenmint') && !mint.toLowerCase().includes('paper1111') && !mint.toLowerCase().includes('test');
      return isAllowed && isNotDummy;
    });

    const solPriceUsd = 100.0;
    return Promise.all(
      open.map(async (pos) => {
        const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
        const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;
        const currentPriceUsd = meta?.priceUsd && meta.priceUsd > 0 ? meta.priceUsd : (currentPriceSol * solPriceUsd);

        // SPL pump.fun tokens have 6 decimals: raw / 1e6 = tokens
        const tokenQty = Number(pos.qtyRaw) / 1e6;
        const costBasisSol = Number(pos.costBasisLamports) / 1e9;
        const currentValueSol = tokenQty * currentPriceSol;
        const currentValueUsd = currentValueSol * solPriceUsd;

        const unrealizedPnlSol = currentValueSol - costBasisSol;
        const unrealizedPnlPct = costBasisSol > 0 ? (unrealizedPnlSol / costBasisSol) * 100 : 0;
        const unrealizedPnlLamports = Math.round(unrealizedPnlSol * 1e9).toString();

        try {
          db.updateUnrealizedPnl(pos.id, unrealizedPnlLamports);
        } catch {
          // ignore
        }

        return {
          ...pos,
          metadata: meta,
          currentPriceSol,
          currentPriceUsd,
          currentValueSol: Number(currentValueSol.toFixed(4)),
          currentValueUsd: Number(currentValueUsd.toFixed(2)),
          unrealizedPnlSol: Number(unrealizedPnlSol.toFixed(4)),
          unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(2)),
          unrealizedPnlLamports,
        };
      })
    );
  };

  // REST APIs for Dashboard
  app.get('/api/telemetry', async (_req: Request, res: Response) => {
    const telemetry = db.getSystemTelemetry();
    telemetry.circuitBreakerTripped = riskEngine.isTripped();

    // Dynamically calculate live floating PnL from active positions
    const open = await getEnrichedPositions();
    const liveFloatingSol = open.reduce((acc, p) => acc + (p.unrealizedPnlSol || 0), 0);
    telemetry.totalUnrealizedPnlSol = Number(liveFloatingSol.toFixed(4));
    telemetry.totalNetPnlSol = Number((telemetry.totalRealizedPnlSol + liveFloatingSol).toFixed(4));
    telemetry.currentPaperBalanceSol = Number((telemetry.initialPaperBalanceSol + telemetry.totalNetPnlSol).toFixed(4));
    telemetry.totalPaperBalanceUsd = Number((telemetry.currentPaperBalanceSol * telemetry.solPriceUsd).toFixed(2));
    telemetry.totalNetPnlUsd = Number((telemetry.totalNetPnlSol * telemetry.solPriceUsd).toFixed(2));
    telemetry.roiPercent = Number(((telemetry.totalNetPnlSol / telemetry.initialPaperBalanceSol) * 100).toFixed(2));

    res.json(telemetry);
  });

  app.get('/api/positions', async (_req: Request, res: Response) => {
    const enriched = await getEnrichedPositions();
    res.json(enriched);
  });

  app.post('/api/positions/:id/sell', async (req: Request, res: Response) => {
    try {
      const positionId = req.params.id;
      const fraction = typeof req.body?.fraction === 'number' ? req.body.fraction : 1.0;
      const result = await signalManager.executeManualExit(positionId, fraction);
      const safeData = JSON.parse(
        JSON.stringify({ success: true, ...result }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
      );
      res.json(safeData);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to execute manual sell' });
    }
  });

  app.post('/api/positions/:id/close', async (req: Request, res: Response) => {
    try {
      const positionId = req.params.id;
      const result = await signalManager.executeManualExit(positionId, 1.0);
      const safeData = JSON.parse(
        JSON.stringify({ success: true, ...result }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
      );
      res.json(safeData);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to close position' });
    }
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
        const hasMeasuredTargetPrice = Boolean(order.target_price && order.target_price > 0);
        const traderPrice = hasMeasuredTargetPrice ? order.target_price : (followerPrice > 0 ? followerPrice * 0.985 : 0);

        const totalSupply = 1_000_000_000;
        const followerMarketCap = followerPrice * totalSupply * solPriceUsd;
        const traderMarketCap = traderPrice > 0
          ? traderPrice * totalSupply * solPriceUsd
          : (followerMarketCap > 0 ? followerMarketCap * 0.9975 : 0);

        const isBuy = order.side === 'BUY';
        const hasMeasuredTargetSpend = Boolean(isBuy ? order.target_in_raw : order.target_out_raw);
        const followerSpentSol = isBuy
          ? (Number(order.in_amount_raw || 0) / 1e9)
          : (Number(order.out_amount_raw || 0) / 1e9);

        const traderSpentSol = hasMeasuredTargetSpend
          ? (isBuy ? Number(order.target_in_raw) / 1e9 : Number(order.target_out_raw) / 1e9)
          : (followerSpentSol > 0 ? followerSpentSol / (config.COPY_RATIO || 0.05) : 0);

        const hasMeasuredLatency = Boolean(order.l_decision_ms && order.l_decision_ms > 0);
        const entryGapPct = traderPrice > 0 && followerPrice > 0
          ? ((followerPrice - traderPrice) / traderPrice) * 100
          : 0;

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
            reactionLatencyMs: hasMeasuredLatency ? Number(order.l_decision_ms.toFixed(2)) : null,
            targetWallet: order.target_wallet || config.WATCHED_WALLETS[0],
            isTargetPriceEstimated: !hasMeasuredTargetPrice,
            isTargetSpentEstimated: !hasMeasuredTargetSpend,
            isLatencyEstimated: !hasMeasuredLatency,
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

  app.get('/api/risk', (_req: Request, res: Response) => {
    res.json({
      circuitBreakerTripped: riskEngine.isTripped(),
      consecutiveErrors: riskEngine.getConsecutiveErrors(),
      consecutiveErrorLimit: config.CONSECUTIVE_ERROR_LIMIT,
      dailyLossSol: Number(riskEngine.getDailyLossLamports()) / 1e9,
      dailyLossLimitSol: config.DAILY_LOSS_LIMIT_SOL,
      maxTotalExposureSol: config.MAX_TOTAL_EXPOSURE_SOL,
      minSolReserveSol: config.MIN_SOL_RESERVE_SOL,
      maxSignalAgeMs: config.MAX_SIGNAL_AGE_MS,
      maxEntryGapBps: config.MAX_ENTRY_GAP_BPS,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      mintBlacklist: riskEngine.getMintBlacklist(),
      defaultSizingMode: config.DEFAULT_SIZING_MODE,
      fixedBuySol: config.FIXED_BUY_SOL,
      copyRatio: config.COPY_RATIO,
      maxBuySol: config.MAX_BUY_SOL,
    });
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
      try {
        const safeJson = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        res.write(`event: ${event}\ndata: ${safeJson}\n\n`);
      } catch (e) {
        // Avoid crashing stream on serialization edge-cases
      }
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

    // Fast telemetry & positions live tick every 2 seconds for real-time sub-second charts
    const tickInterval = setInterval(async () => {
      try {
        const telemetry = db.getSystemTelemetry();
        telemetry.circuitBreakerTripped = riskEngine.isTripped();
        const positions = await getEnrichedPositions();
        const liveFloatingSol = positions.reduce((acc, p) => acc + (p.unrealizedPnlSol || 0), 0);
        telemetry.totalUnrealizedPnlSol = Number(liveFloatingSol.toFixed(4));
        telemetry.totalNetPnlSol = Number((telemetry.totalRealizedPnlSol + liveFloatingSol).toFixed(4));
        telemetry.currentPaperBalanceSol = Number((telemetry.initialPaperBalanceSol + telemetry.totalNetPnlSol).toFixed(4));
        telemetry.totalPaperBalanceUsd = Number((telemetry.currentPaperBalanceSol * telemetry.solPriceUsd).toFixed(2));
        telemetry.totalNetPnlUsd = Number((telemetry.totalNetPnlSol * telemetry.solPriceUsd).toFixed(2));
        telemetry.roiPercent = Number(((telemetry.totalNetPnlSol / telemetry.initialPaperBalanceSol) * 100).toFixed(2));

        sendEvent('telemetryTick', {
          time: Date.now(),
          telemetry,
          positions,
        });
      } catch {
        // ignore
      }
    }, 2000);

    // Heartbeat every 15 seconds
    const interval = setInterval(() => {
      sendEvent('ping', { time: Date.now() });
    }, 15000);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(tickInterval);
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
