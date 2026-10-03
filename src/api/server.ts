import crypto from 'crypto';
import cors from 'cors';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { liveEngine } from '../execution/live-engine.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { tokenMetadataService } from '../services/token-metadata.js';
import { mintDecimalsService } from '../services/mint-decimals.js';
import { positionSyncService } from '../services/position-sync.js';
import { traderNamingService } from '../services/trader-naming.js';
import { signalManager } from '../streams/signal-manager.js';
import { WebhookReceiver } from '../streams/webhook-server.js';
import { SystemTelemetry, FollowerPosition } from '../types/index.js';
import {
  authFailureLimiter,
  mutatingControlLimiter,
  tradingExitLimiter,
  walletMutationLimiter,
  webhookRateLimiter,
} from './rate-limiter.js';

// Authentication middleware for state-modifying actions
export const requireControlAuth = (req: Request, res: Response, next: express.NextFunction) => {
  const clientIp = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.ip || req.socket?.remoteAddress || 'unknown';

  if (authFailureLimiter.isRateLimited(clientIp)) {
    return res.status(429).json({
      error: 'Too many failed authentication attempts. Please wait a minute before retrying.',
    });
  }

  const configuredToken = config.CONTROL_API_TOKEN ? config.CONTROL_API_TOKEN.trim() : '';

  // Fail-closed rule: Missing CONTROL_API_TOKEN must never silently make privileged routes public.
  if (!configuredToken) {
    if (config.ALLOW_UNAUTHENTICATED_CONTROL && config.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(401).json({
      error: 'Unauthorized: CONTROL_API_TOKEN is not configured on this server. State-modifying controls fail-closed.',
    });
  }

  const tokenHeader = req.headers['x-api-token'];
  const authHeader = req.headers.authorization;
  const provided = typeof tokenHeader === 'string' && tokenHeader.trim()
    ? tokenHeader.trim()
    : (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null);

  if (!provided) {
    authFailureLimiter.recordHit(clientIp);
    return res.status(401).json({ error: 'Unauthorized: Missing CONTROL_API_TOKEN' });
  }

  const expectedBuf = Buffer.from(configuredToken);
  const actualBuf = Buffer.from(provided);
  const isValid = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!isValid) {
    authFailureLimiter.recordHit(clientIp);
    return res.status(401).json({ error: 'Unauthorized: Invalid CONTROL_API_TOKEN' });
  }

  return next();
};

export function createApiServer() {
  const app = express();

  const allowedOrigins = config.CORS_ALLOWED_ORIGINS
    ? config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  app.use(
    cors({
      origin: (origin, callback) => {
        // 1. Same-origin or direct server-to-server/curl without Origin header
        if (!origin) {
          return callback(null, true);
        }

        // 2. Explicitly allowed configured origins
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        // 3. Local development relaxed logic (only when NOT in production)
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        if (config.NODE_ENV !== 'production' && isLocalhost) {
          return callback(null, true);
        }

        // 4. In production or unapproved cross-origin: reject
        callback(new Error('Blocked by CORS policy'));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    next(err);
  });

  // Serve static web dashboard build if available
  const distPath = path.resolve('dashboard/dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
  }

  // Webhook Receiver with rate limiter
  const webhookReceiver = new WebhookReceiver({
    onTransaction: (tx) => {
      signalManager.handleIncomingTransaction(tx, 'WEBHOOK', 'PROCESSED_SUCCESS');
    },
  });
  app.post('/webhook/helius', webhookRateLimiter.middleware, webhookReceiver.handleHeliusWebhook);

  const getEnrichedPositions = async () => {
    const dbWallets = db.getWatchedWallets().map((w) => w.wallet);
    const allowedWallets = new Set([...config.WATCHED_WALLETS, ...dbWallets]);
    const rawOpen = db.getOpenPositions().filter((pos) => {
      const mint = pos.tokenMint || '';
      const isAllowed = allowedWallets.size === 0 || allowedWallets.has(pos.targetWallet) || !pos.targetWallet;
      const isNotDummy = !mint.toLowerCase().includes('tokenmint') && !mint.toLowerCase().includes('paper1111') && !mint.toLowerCase().includes('test');
      return isAllowed && isNotDummy;
    });

    const open: any[] = [];
    const knownMints = new Set<string>();

    for (const pos of rawOpen) {
      if (config.EXECUTION_MODE === 'LIVE') {
        try {
          const onChainBal = await executionWalletManager.getTokenBalanceRaw(pos.tokenMint);
          if (onChainBal <= 0n) {
            pos.state = 'CLOSED';
            pos.qtyRaw = '0';
            pos.closedAt = Date.now();
            pos.updatedAt = Date.now();
            db.savePosition(pos);
            continue;
          } else {
            pos.qtyRaw = onChainBal.toString();
          }
        } catch {}
      }
      open.push(pos);
      knownMints.add(pos.tokenMint);
    }

    // IN LIVE MODE: Directly scan on-chain wallet tokens so dashboard is 100% in sync with wallet
    if (config.EXECUTION_MODE === 'LIVE') {
      try {
        const held = await executionWalletManager.getHeldTokensWithAmounts();
        for (const item of held) {
          if (!knownMints.has(item.mint)) {
            if (
              item.mint === '9aaDsN9KkSy9q3LmAwhXiJF75veH4wsbEFkJXqMH54VW' ||
              item.mint === 'So11111111111111111111111111111111111111112'
            ) {
              continue;
            }

            const decimals = await mintDecimalsService.getDecimals(item.mint, { allowUnverifiedDisplay: true });
            const meta = await tokenMetadataService.getTokenMetadata(item.mint);
            const priceSol = meta?.priceSol || 0;
            const liveSol = (await tokenMetadataService.getSolPriceUsd()) || (config.SOL_PRICE_USD || 0);
            const priceUsd = meta?.priceUsd || (liveSol > 0 ? priceSol * liveSol : 0);
            const tokenQty = Number(item.amountRaw) / (10 ** decimals);
            const estValueUsd = tokenQty * priceUsd;

            if (priceUsd <= 0 || estValueUsd < 0.05) continue;

            const orders = db.getRecentOrders(100);
            const buyOrder = orders.find(
              (o) => o.token_mint === item.mint && o.side === 'BUY' && (o.status === 'FILLED' || o.status === 'LANDED' || o.status === 'CONFIRMED')
            );
            let costBasisLamports = Math.round((config.FIXED_BUY_SOL || 0.05) * 1e9).toString();
            let avgEntryPriceSol = tokenQty > 0 ? (Number(costBasisLamports) / 1e9) / tokenQty : priceSol;
            if (buyOrder) {
              costBasisLamports = buyOrder.actualInAmountRaw || buyOrder.in_amount_raw || costBasisLamports;
              avgEntryPriceSol = buyOrder.actualExecutionPrice || buyOrder.effective_price || avgEntryPriceSol;
            }

            const targetTrader = traderNamingService.findTargetWalletByMint(item.mint) || config.WATCHED_WALLETS[0] || 'Target Trader';

            const dynamicPos: FollowerPosition = {
              id: `onchain_${item.mint}`,
              targetWallet: targetTrader,
              tokenMint: item.mint,
              qtyRaw: item.amountRaw,
              costBasisLamports,
              avgEntryPriceSol,
              realizedPnlLamports: '0',
              unrealizedPnlLamports: '0',
              state: 'OPEN',
              openedAt: Date.now(),
              updatedAt: Date.now(),
              closedAt: undefined,
              tp1Triggered: false,
              peakPnlPct: 0,
            };
            db.savePosition(dynamicPos);
            open.push(dynamicPos);
            knownMints.add(item.mint);
          }
        }
      } catch (err: any) {
        console.warn('[API Server] Error scanning on-chain tokens for positions API:', err?.message || err);
      }
    }

    const solPriceUsd = (await tokenMetadataService.getSolPriceUsd()) || (config.SOL_PRICE_USD || 0);

    return Promise.all(
      open.map(async (pos) => {
        const decimals = await mintDecimalsService.getDecimals(pos.tokenMint, { allowUnverifiedDisplay: true });
        const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
        const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;
        const currentPriceUsd = meta?.priceUsd && meta.priceUsd > 0
          ? meta.priceUsd
          : (solPriceUsd > 0 ? currentPriceSol * solPriceUsd : 0);

        const tokenQty = Number(pos.qtyRaw) / (10 ** decimals);
        let costBasisLamports = BigInt(pos.costBasisLamports || '0');
        if (costBasisLamports === 0n) {
          costBasisLamports = BigInt(Math.round((config.FIXED_BUY_SOL || 0.05) * 1e9));
        }
        const costBasisSol = Number(costBasisLamports) / 1e9;
        const costBasisUsd = solPriceUsd > 0 ? costBasisSol * solPriceUsd : 0;

        const currentValueSol = tokenQty * currentPriceSol;
        const currentValueUsd = solPriceUsd > 0 ? currentValueSol * solPriceUsd : 0;

        const unrealizedPnlSol = currentValueSol - costBasisSol;
        const unrealizedPnlPct = costBasisSol > 0 ? (unrealizedPnlSol / costBasisSol) * 100 : 0;
        const unrealizedPnlLamports = Math.round(unrealizedPnlSol * 1e9).toString();

        try {
          db.updateUnrealizedPnl(pos.id, unrealizedPnlLamports);
        } catch {}

        const traderInfo = traderNamingService.getTraderInfo(pos.targetWallet || pos.tokenMint);

        const effectivePeak = Math.max(pos.peakPnlPct || 0, unrealizedPnlPct);
        const isBreakevenLocked = config.TRAILING_SL_ENABLED && effectivePeak >= config.BREAKEVEN_TRIGGER_PCT;
        const trailingFloorPct = config.TRAILING_SL_ENABLED && effectivePeak >= 30
          ? Number((effectivePeak - config.TRAILING_SL_CUSHION_PCT).toFixed(1))
          : (isBreakevenLocked ? config.BREAKEVEN_LOCK_PCT : null);

        return {
          ...pos,
          targetWallet: traderInfo.address,
          traderLabel: traderInfo.label,
          traderShort: traderInfo.short,
          traderDisplay: traderInfo.displayName,
          traderSolscanUrl: traderInfo.solscanUrl,
          traderGmgnUrl: traderInfo.gmgnUrl,
          metadata: meta,
          decimals,
          solPriceUsd: solPriceUsd > 0 ? solPriceUsd : null,
          currentPriceSol,
          currentPriceUsd: solPriceUsd > 0 ? currentPriceUsd : null,
          currentValueSol: Number(currentValueSol.toFixed(4)),
          currentValueUsd: solPriceUsd > 0 ? Number(currentValueUsd.toFixed(2)) : null,
          costBasisSol: Number(costBasisSol.toFixed(4)),
          costBasisUsd: solPriceUsd > 0 ? Number(costBasisUsd.toFixed(2)) : null,
          unrealizedPnlSol: Number(unrealizedPnlSol.toFixed(4)),
          unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(2)),
          unrealizedPnlLamports,
          peakPnlPct: Number(effectivePeak.toFixed(1)),
          trailingFloorPct,
          isBreakevenLocked,
        };
      })
    );
  };

  const buildTelemetrySnapshot = async (): Promise<SystemTelemetry> => {
    const telemetry = db.getSystemTelemetry();
    telemetry.circuitBreakerTripped = riskEngine.isTripped();

    // Derived strictly from settled trade positions ledger (never contaminated by deposits or withdrawals)
    const accounting = db.getAccountingSummary();
    telemetry.totalRealizedPnlSol = Number(accounting.realizedPnlSol.toFixed(4));
    telemetry.totalTradesClosed = accounting.totalTradesClosed;
    telemetry.winRatePct = accounting.winRatePct;

    try {
      const liveSolPrice = await tokenMetadataService.getSolPriceUsd();
      if (liveSolPrice > 0) {
        telemetry.solPriceUsd = liveSolPrice;
        telemetry.totalRealizedPnlUsd = Number((telemetry.totalRealizedPnlSol * liveSolPrice).toFixed(2));
      }
    } catch {}

    // Dynamically calculate live floating PnL from active positions
    const open = await getEnrichedPositions();
    const liveFloatingSol = open.reduce((acc, p) => acc + (p.unrealizedPnlSol || 0), 0);
    telemetry.totalUnrealizedPnlSol = Number(liveFloatingSol.toFixed(4));
    telemetry.totalNetPnlSol = Number((telemetry.totalRealizedPnlSol + liveFloatingSol).toFixed(4));
    telemetry.currentPaperBalanceSol = Number((telemetry.initialPaperBalanceSol + telemetry.totalNetPnlSol).toFixed(4));

    if (telemetry.solPriceUsd && telemetry.solPriceUsd > 0) {
      telemetry.totalPaperBalanceUsd = Number((telemetry.currentPaperBalanceSol * telemetry.solPriceUsd).toFixed(2));
      telemetry.totalNetPnlUsd = Number((telemetry.totalNetPnlSol * telemetry.solPriceUsd).toFixed(2));
      telemetry.totalRealizedPnlUsd = Number((telemetry.totalRealizedPnlSol * telemetry.solPriceUsd).toFixed(2));
    }

    telemetry.roiPercent = telemetry.initialPaperBalanceSol > 0
      ? Number(((telemetry.totalNetPnlSol / telemetry.initialPaperBalanceSol) * 100).toFixed(2))
      : 0;

    telemetry.isLiveMode = config.EXECUTION_MODE === 'LIVE';
    if (config.EXECUTION_MODE === 'LIVE') {
      const walletStatus = executionWalletManager.getStatus();
      telemetry.liveWalletPublicKey = walletStatus.publicKey || undefined;
      telemetry.liveWalletBalanceSol = walletStatus.balanceSol;
      telemetry.liveWalletReserveSol = walletStatus.reserveSol;
      telemetry.liveWalletSpendableSol = walletStatus.spendableSol;
      telemetry.liveEngineArmed = liveEngine.getStatus().isArmed;

      const initialCapital = config.LIVE_INITIAL_BALANCE_SOL || 0.2610;
      telemetry.roiPercent = initialCapital > 0
        ? Number(((telemetry.totalNetPnlSol / initialCapital) * 100).toFixed(2))
        : 0;
    }

    return telemetry;
  };

  // REST APIs for Dashboard
  app.get('/api/telemetry', async (_req: Request, res: Response) => {
    const telemetry = await buildTelemetrySnapshot();
    res.json(telemetry);
  });

  app.get('/api/positions', async (_req: Request, res: Response) => {
    const enriched = await getEnrichedPositions();
    res.json(enriched);
  });

  // Input validation schemas
  const SellInputSchema = z.object({
    fraction: z.number().positive().max(1.0, 'fraction must be <= 1.0').default(1.0),
  });

  const WatchedWalletInputSchema = z.object({
    wallet: z.string().refine((val) => {
      try {
        new PublicKey(val);
        return true;
      } catch {
        return false;
      }
    }, { message: 'Invalid Solana base58 public key' }),
    label: z.string().min(1).max(64).default('Target Trader'),
    enabled: z.boolean().default(true),
    buyMode: z.enum(['FIXED_SIZE', 'TARGET_NOTIONAL_SCALAR', 'CAPPED_PROPORTIONAL_HYBRID']).default('FIXED_SIZE'),
    fixedBuyLamports: z.string().regex(/^\d+$/, 'fixedBuyLamports must be integer lamports').default('100000000'),
    copyRatio: z.number().positive().max(10, 'copyRatio cannot exceed 10x').default(0.05),
    maxBuyLamports: z.string().regex(/^\d+$/, 'maxBuyLamports must be integer lamports').default('1000000000'),
    configJson: z.string().optional(),
    createdAt: z.number().default(() => Date.now()),
  });

  app.post('/api/positions/:id/sell', requireControlAuth, tradingExitLimiter.middleware, async (req: Request, res: Response) => {
    try {
      const positionId = req.params.id;
      const parseResult = SellInputSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.errors[0]?.message || 'Invalid sell parameters' });
      }
      const fraction = parseResult.data.fraction;
      const result = await signalManager.executeManualExit(positionId, fraction);

      db.logAudit({
        timestamp: Date.now(),
        actor: 'OPERATOR_API',
        action: 'MANUAL_SELL',
        details: { positionId, fraction },
        ipAddress: req.ip,
      });

      const safeData = JSON.parse(
        JSON.stringify({ success: true, ...result }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
      );
      res.json(safeData);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to execute manual sell' });
    }
  });

  app.post('/api/positions/:id/close', requireControlAuth, tradingExitLimiter.middleware, async (req: Request, res: Response) => {
    try {
      const positionId = req.params.id;
      const result = await signalManager.executeManualExit(positionId, 1.0);

      db.logAudit({
        timestamp: Date.now(),
        actor: 'OPERATOR_API',
        action: 'MANUAL_CLOSE',
        details: { positionId },
        ipAddress: req.ip,
      });

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
    const liveSol = await tokenMetadataService.getSolPriceUsd();
    const solPriceUsd = liveSol > 0 ? liveSol : (config.SOL_PRICE_USD || 0);

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const meta = await tokenMetadataService.getTokenMetadata(order.token_mint);

        const followerPrice = order.effective_price || 0;
        const hasMeasuredTargetPrice = Boolean(order.target_price && order.target_price > 0);
        const traderPrice = hasMeasuredTargetPrice ? order.target_price : (followerPrice > 0 ? followerPrice * 0.985 : 0);

        const isMarketCapEstimated = true;
        const estimatedTotalSupply = 1_000_000_000;
        const followerMarketCap = meta?.fdvUsd && meta.fdvUsd > 0
          ? meta.fdvUsd
          : (solPriceUsd > 0 ? followerPrice * estimatedTotalSupply * solPriceUsd : 0);
        const traderMarketCap = traderPrice > 0 && solPriceUsd > 0
          ? traderPrice * estimatedTotalSupply * solPriceUsd
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
            traderPriceUsd: solPriceUsd > 0 ? traderPrice * solPriceUsd : null,
            followerPriceSol: followerPrice,
            followerPriceUsd: solPriceUsd > 0 ? followerPrice * solPriceUsd : null,
            traderMarketCapUsd: Math.round(traderMarketCap),
            followerMarketCapUsd: Math.round(followerMarketCap),
            traderSpentSol: Number(traderSpentSol.toFixed(4)),
            traderSpentUsd: solPriceUsd > 0 ? Math.round(traderSpentSol * solPriceUsd) : null,
            followerSpentSol: Number(followerSpentSol.toFixed(4)),
            followerSpentUsd: solPriceUsd > 0 ? Number((followerSpentSol * solPriceUsd).toFixed(2)) : null,
            entryGapPct: Number(entryGapPct.toFixed(2)),
            entryGapBps: Math.round(entryGapPct * 100),
            reactionLatencyMs: hasMeasuredLatency ? Number(order.l_decision_ms.toFixed(2)) : null,
            targetWallet: order.target_wallet || config.WATCHED_WALLETS[0] || 'Target Trader',
            isTargetPriceEstimated: !hasMeasuredTargetPrice,
            isTargetSpentEstimated: !hasMeasuredTargetSpend,
            isLatencyEstimated: !hasMeasuredLatency,
            isMarketCapEstimated,
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

  app.post('/api/wallets', requireControlAuth, walletMutationLimiter.middleware, (req: Request, res: Response) => {
    const raw = req.body || {};
    // Normalize snake_case and camelCase parameters gracefully
    const normalized = {
      wallet: raw.wallet,
      label: raw.label || 'Target Trader',
      enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : true,
      buyMode: raw.buyMode || raw.buy_mode || 'FIXED_SIZE',
      fixedBuyLamports:
        raw.fixedBuyLamports ||
        raw.fixed_buy_raw ||
        (raw.fixedBuySol ? Math.round(Number(raw.fixedBuySol) * 1e9).toString() : '100000000'),
      copyRatio:
        typeof raw.copyRatio === 'number'
          ? raw.copyRatio
          : typeof raw.copy_ratio === 'number'
          ? raw.copy_ratio
          : 0.05,
      maxBuyLamports:
        raw.maxBuyLamports ||
        raw.max_buy_raw ||
        (raw.maxBuySol ? Math.round(Number(raw.maxBuySol) * 1e9).toString() : '1000000000'),
      configJson: raw.configJson || raw.config_json,
    };

    const parseResult = WatchedWalletInputSchema.safeParse(normalized);
    if (!parseResult.success) {
      return res.status(400).json({
        error: parseResult.error.errors[0]?.message || 'Invalid wallet parameters',
        details: parseResult.error.errors,
      });
    }

    const validated = parseResult.data;
    db.upsertWatchedWallet(validated);
    signalManager.refreshWallets();

    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'WALLET_ADD',
      details: { wallet: validated.wallet, label: validated.label, buyMode: validated.buyMode },
      ipAddress: req.ip,
    });

    res.json({ success: true, wallet: validated });
  });

  app.delete('/api/wallets/:wallet', requireControlAuth, walletMutationLimiter.middleware, (req: Request, res: Response) => {
    const wallet = req.params.wallet;
    if (!wallet) {
      return res.status(400).json({ error: 'Missing wallet public key' });
    }
    try {
      new PublicKey(wallet);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana base58 public key' });
    }

    const deleted = db.deleteWatchedWallet(wallet);
    signalManager.refreshWallets();

    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'WALLET_DELETE',
      details: { wallet },
      ipAddress: req.ip,
    });

    res.json({ success: true, deleted });
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

  app.post('/api/risk/reset', requireControlAuth, mutatingControlLimiter.middleware, (req: Request, res: Response) => {
    riskEngine.resetCircuitBreaker();
    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'CIRCUIT_BREAKER_RESET',
      details: { endpoint: '/api/risk/reset' },
      ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Circuit breaker reset. Normal trading resumed.' });
  });

  app.post('/api/circuit-breaker/reset', requireControlAuth, mutatingControlLimiter.middleware, (req: Request, res: Response) => {
    riskEngine.resetCircuitBreaker();
    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'CIRCUIT_BREAKER_RESET',
      details: { endpoint: '/api/circuit-breaker/reset' },
      ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Circuit breaker reset. Normal trading resumed.' });
  });

  // Operator Audit Logs API
  app.get('/api/audit-logs', requireControlAuth, (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const logs = db.getAuditLogs(limit);
    res.json(logs);
  });

  // Live Engine Safety & Status Endpoints
  app.get('/api/live/status', async (_req: Request, res: Response) => {
    if (config.EXECUTION_MODE === 'LIVE') {
      await executionWalletManager.refreshBalance().catch(() => {});
    }
    const liveStatus = liveEngine.getStatus();
    const walletStatus = executionWalletManager.getStatus();

    res.json({
      executionMode: config.EXECUTION_MODE,
      isArmed: liveStatus.isArmed,
      disarmReason: liveStatus.disarmReason,
      liveTradingAckConfigured: config.LIVE_TRADING_ACK === 'I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK',
      wallet: {
        isConfigured: walletStatus.isConfigured,
        publicKey: walletStatus.publicKey,
        balanceSol: walletStatus.balanceSol,
        reserveSol: walletStatus.reserveSol,
        spendableSol: walletStatus.spendableSol,
      },
      limits: {
        fixedBuySol: config.FIXED_BUY_SOL,
        maxBuySol: config.MAX_BUY_SOL,
        maxExposureSol: config.MAX_TOTAL_EXPOSURE_SOL,
        dailyLossLimitSol: config.DAILY_LOSS_LIMIT_SOL,
        minReserveSol: config.MIN_SOL_RESERVE_SOL,
      },
    });
  });

  app.post('/api/live/kill', requireControlAuth, mutatingControlLimiter.middleware, (req: Request, res: Response) => {
    liveEngine.kill('Operator triggered Emergency Kill Switch via Dashboard/API');
    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'LIVE_KILL',
      details: { reason: 'Operator Emergency Kill Switch' },
      ipAddress: req.ip,
    });
    res.json({ success: true, isArmed: false, message: 'Live execution DISARMED immediately.' });
  });

  app.post('/api/live/arm', requireControlAuth, mutatingControlLimiter.middleware, async (req: Request, res: Response) => {
    const result = await liveEngine.arm();
    db.logAudit({
      timestamp: Date.now(),
      actor: 'OPERATOR_API',
      action: 'LIVE_ARM',
      details: { armed: result.armed, reason: result.reason },
      ipAddress: req.ip,
    });
    res.json({
      success: result.armed,
      isArmed: result.armed,
      reason: result.reason,
    });
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
        const [telemetry, positions] = await Promise.all([
          buildTelemetrySnapshot(),
          getEnrichedPositions(),
        ]);

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
