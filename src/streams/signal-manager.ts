import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { config, solToLamportsBigInt } from '../config/index.js';
import { db } from '../db/database.js';
import { dedupeEngine } from '../engine/dedupe.js';
import { positionEngine } from '../engine/position-engine.js';
import { riskEngine } from '../engine/risk-engine.js';
import { liveEngine } from '../execution/live-engine.js';
import { paperEngine } from '../execution/paper-engine.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { telegramNotifier } from '../notifications/telegram.js';
import { FastTransactionDecoder, ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';
import { tokenMetadataService } from '../services/token-metadata.js';
import { latencyTracker } from '../telemetry/latency-tracker.js';
import {
  FollowerPosition,
  MirrorIntent,
  MirrorOrder,
  SignalSource,
  SignalStage,
  SwapIntent,
  WatchedWallet,
} from '../types/index.js';

export class SignalManager extends EventEmitter {
  private watchedWallets: Map<string, WatchedWallet> = new Map();

  constructor() {
    super();
    this.refreshWallets();
  }

  public refreshWallets(): void {
    const list = db.getWatchedWallets();
    this.watchedWallets.clear();
    for (const w of list) {
      if (w.enabled) {
        this.watchedWallets.set(w.wallet, w);
      }
    }
    // Fallback: Also monitor any wallets configured in config.WATCHED_WALLETS
    for (const walletStr of config.WATCHED_WALLETS) {
      if (!this.watchedWallets.has(walletStr)) {
        this.watchedWallets.set(walletStr, {
          wallet: walletStr,
          label: 'Target Trader',
          enabled: true,
          buyMode: config.DEFAULT_SIZING_MODE,
          fixedBuyLamports: (config.FIXED_BUY_SOL * 1e9).toString(),
          copyRatio: config.COPY_RATIO,
          maxBuyLamports: (config.MAX_BUY_SOL * 1e9).toString(),
          createdAt: Date.now(),
        });
      }
    }
    this.emit('walletsUpdated', Array.from(this.watchedWallets.values()));
  }

  /**
   * Fast Hot Path Ingestion
   */
  public async handleIncomingTransaction(
    tx: ParsedTransactionEnvelope,
    source: SignalSource = 'HELIUS_PRECONFIRMATION',
    stage: SignalStage = 'SEEN_PRECONF'
  ): Promise<{ intent: SwapIntent | null; order: MirrorOrder | null }> {
    const observedAt = tx.observedAt || process.hrtime.bigint();

    // 1. Signature Deduplication Check
    const { shouldAct } = dedupeEngine.registerEvent(tx.signature, stage, source);
    if (!shouldAct) {
      return { intent: null, order: null };
    }

    // 2. Check if any watched target wallet is in the accounts
    let matchedWallet: WatchedWallet | null = null;
    for (const account of tx.accountKeys) {
      if (this.watchedWallets.has(account)) {
        matchedWallet = this.watchedWallets.get(account)!;
        break;
      }
    }

    if (!matchedWallet) {
      return { intent: null, order: null };
    }

    // 3. Fast Transaction Intent Decoding
    const swapIntent = FastTransactionDecoder.decodeTransaction(tx, matchedWallet.wallet);
    if (!swapIntent) {
      console.info(`[DECODER SKIP] Transaction ${tx.signature.slice(0, 8)}... had no swap intent for target ${matchedWallet.wallet.slice(0, 8)}...`);
      return { intent: null, order: null };
    }

    console.info(`[SWAP DETECTED] ${swapIntent.side} ${swapIntent.tokenMint.slice(0, 8)}... by ${matchedWallet.wallet.slice(0, 8)}... (venue: ${swapIntent.venue}, estPrice: ${swapIntent.estimatedPrice.toExponential(4)} SOL)`);

    // 4. Pre-trade Risk Check & Sizing Decision (ULTRA-FAST IN-MEMORY HOT PATH)
    const currentSolBalance =
      config.EXECUTION_MODE === 'LIVE'
        ? executionWalletManager.getCachedBalanceLamports()
        : solToLamportsBigInt(10.0);
    const totalExposure = positionEngine.getTotalOpenExposureLamports();

    const riskResult = riskEngine.evaluateIntent(
      swapIntent,
      currentSolBalance,
      totalExposure
    );

    const decisionAt = process.hrtime.bigint();

    // 5. Prepare Mirror Intent (IN-MEMORY HOT PATH)
    const mirrorIntent = positionEngine.prepareMirrorIntent(
      swapIntent,
      matchedWallet,
      riskResult.decision,
      riskResult.reason
    );

    // Save target event & emit asynchronously off the critical execution hot path
    setImmediate(() => {
      try {
        db.saveTargetEvent(swapIntent, stage, 'PROCESSED');
        this.emit('targetEvent', swapIntent);
        this.emit('mirrorIntent', mirrorIntent);
      } catch {}
    });

    if (!riskResult.approved) {
      console.info(`[RISK REJECTED] ${riskResult.decision}: ${riskResult.reason}`);
      telegramNotifier.notifyTargetDetected(swapIntent, 'RISK_REJECTED', riskResult.reason);
      return { intent: swapIntent, order: null };
    }

    // Skip SELL orders if follower wallet holds 0 balance of this token
    if (swapIntent.side === 'SELL' && BigInt(mirrorIntent.requestedInAmountRaw || '0') <= 0n) {
      console.info(`[SKIP SELL] Follower holds 0 balance of token ${swapIntent.tokenMint}. Skipping unheld sell.`);
      telegramNotifier.notifyTargetDetected(swapIntent, 'RISK_REJECTED', 'No balance held in wallet to sell');
      return { intent: swapIntent, order: null };
    }

    // Mark as acted to prevent duplicate execution across feeds
    dedupeEngine.markActed(tx.signature);

    if (swapIntent.side === 'BUY') {
      riskEngine.markInFlight(swapIntent.tokenMint);
    }

    // 6. Execution Gateway (Paper or Live)
    let order: MirrorOrder;
    try {
      if (config.EXECUTION_MODE === 'LIVE') {
        const liveStatus = liveEngine.getStatus();
        if (!liveStatus.isArmed) {
          riskEngine.clearInFlightBuy(swapIntent.tokenMint);
          console.warn(`[LIVE EXECUTION DISARMED] Order skipped: ${liveStatus.disarmReason}`);
          telegramNotifier.notifyTargetDetected(swapIntent, 'DISARMED_SKIP', liveStatus.disarmReason);
          return { intent: swapIntent, order: null };
        }
        order = await liveEngine.executeLiveTrade(swapIntent, mirrorIntent);
      } else {
        order = await paperEngine.executePaperTrade(swapIntent, mirrorIntent);
      }
    } catch (err: any) {
      riskEngine.clearInFlightBuy(swapIntent.tokenMint);
      const isNormalRiskRejection = 
        err.message?.includes('Entry price gap') || 
        err.message?.includes('REJECTED') ||
        err.message?.includes('tolerance');
      if (!isNormalRiskRejection) {
        riskEngine.recordError(err.message || 'Execution error');
      }
      console.error('[Execution Error]:', err);
      telegramNotifier.notifyTargetDetected(swapIntent, 'EXECUTION_FAILED', err.message || 'Execution error');
      return { intent: swapIntent, order: null };
    }

    if (swapIntent.side === 'BUY') {
      riskEngine.recordBuy(swapIntent.tokenMint);
    }
    riskEngine.recordSuccess();

    // 7. Latency Telemetry Recording
    const quoteDoneAt = order.quotedAt;
    const submittedAt = order.submittedAt || quoteDoneAt;
    const mirrorProcessedAt = order.landedAt;

    const latencyMetric = latencyTracker.recordSample({
      targetSignature: tx.signature,
      source,
      observedAt,
      decisionAt,
      quoteDoneAt,
      submittedAt,
      targetProcessedAt: undefined, // Ground truth latency (no synthetic +180ms injection)
      mirrorProcessedAt,
      targetPrice: swapIntent.estimatedPrice,
      mirrorPrice: order.effectivePrice,
    });

    // Emit live updates to UI and notifications
    this.emit('mirrorOrder', order);
    this.emit('latencySample', latencyMetric);

    const position = db.getPosition(matchedWallet.wallet, order.tokenMint);
    if (position) {
      this.emit('positionUpdate', position);
    }

    // 8. Async Telegram Notification
    telegramNotifier.notifyTradeFilled(order, position || undefined);

    return { intent: swapIntent, order };
  }

  /**
   * Manual Take Profit / Emergency Exit for open positions
   */
  public async executeManualExit(
    positionIdOrMint: string,
    fraction: number = 1.0
  ): Promise<{ order: MirrorOrder; position: FollowerPosition | null }> {
    const openPositions = db.getOpenPositions();
    let pos = openPositions.find(
      (p) => p.id === positionIdOrMint || p.tokenMint.toLowerCase() === positionIdOrMint.toLowerCase()
    );

    if (!pos && config.EXECUTION_MODE === 'LIVE') {
      try {
        const onChainBal = await executionWalletManager.getTokenBalanceRaw(positionIdOrMint);
        if (onChainBal !== null && onChainBal > 0n) {
          const dynamicPos: FollowerPosition = {
            id: `onchain_${positionIdOrMint}`,
            targetWallet: 'On-Chain Wallet',
            tokenMint: positionIdOrMint,
            qtyRaw: onChainBal.toString(),
            costBasisLamports: '0',
            avgEntryPriceSol: 0,
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
          pos = dynamicPos;
        }
      } catch {}
    }

    if (!pos) {
      throw new Error(`Open position not found for "${positionIdOrMint}"`);
    }

    const activePos: FollowerPosition = pos;

    if (config.EXECUTION_MODE === 'LIVE') {
      const onChainBal = await executionWalletManager.getTokenBalanceRaw(pos.tokenMint);
      if (onChainBal !== null && onChainBal <= 0n) {
        pos.state = 'CLOSED';
        pos.qtyRaw = '0';
        pos.closedAt = Date.now();
        pos.updatedAt = Date.now();
        db.savePosition(pos);
        this.emit('positionUpdate', pos);
        throw new Error(`Position already closed: Wallet holds 0 tokens of ${pos.tokenMint.substring(0, 6)}... on-chain.`);
      } else if (onChainBal !== null && onChainBal > 0n) {
        pos.qtyRaw = onChainBal.toString();
      }
    }

    const currentQty = BigInt(pos.qtyRaw);
    if (currentQty <= 0n) {
      throw new Error(`Position has 0 balance`);
    }

    const clampedFraction = Math.min(1.0, Math.max(0.01, fraction));
    const tokensToSell = BigInt(Math.floor(Number(currentQty) * clampedFraction));
    const actualSellQty = tokensToSell > 0n ? tokensToSell : currentQty;

    // Fetch latest market price
    const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
    const estimatedPrice = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;

    const intentId = randomUUID();
    const manualSig = `manual_exit_${Date.now()}`;

    const swapIntent: SwapIntent = {
      targetSignature: manualSig,
      slot: 0,
      targetWallet: pos.targetWallet,
      venue: 'PUMPFUN',
      side: 'SELL',
      tokenMint: pos.tokenMint,
      inputMint: pos.tokenMint,
      outputMint: 'So11111111111111111111111111111111111111112',
      inputAmountRaw: actualSellQty.toString(),
      outputAmountRaw: '0',
      estimatedPrice,
      targetPreBalanceToken: pos.qtyRaw,
      observedAt: process.hrtime.bigint(),
      timestampMs: Date.now(),
      rawProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      confidence: 1.0,
    };

    const mirrorIntent: MirrorIntent = {
      id: intentId,
      targetSignature: manualSig,
      targetWallet: pos.targetWallet,
      side: 'SELL',
      tokenMint: pos.tokenMint,
      inputMint: pos.tokenMint,
      outputMint: 'So11111111111111111111111111111111111111112',
      requestedInAmountRaw: actualSellQty.toString(),
      expectedOutAmountRaw: '0',
      sellFraction: clampedFraction,
      riskDecision: 'APPROVED',
      createdAt: process.hrtime.bigint(),
    };

    db.saveMirrorIntent(mirrorIntent);

    let order: MirrorOrder;
    if (config.EXECUTION_MODE === 'LIVE') {
      order = await liveEngine.executeLiveTrade(swapIntent, mirrorIntent);
    } else {
      order = await paperEngine.executePaperTrade(swapIntent, mirrorIntent);
    }

    this.emit('mirrorOrder', order);
    const updatedPosition = db.getPosition(pos.targetWallet, pos.tokenMint);
    if (updatedPosition) {
      this.emit('positionUpdate', updatedPosition);
    }

    telegramNotifier.notifyManualExit(order, updatedPosition || pos, clampedFraction, meta || undefined);

    return { order, position: updatedPosition || pos };
  }
}

export const signalManager = new SignalManager();
