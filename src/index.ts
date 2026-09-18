import { createApiServer } from './api/server.js';
import { config } from './config/index.js';
import { db } from './db/database.js';
import { autoExitManager } from './engine/auto-exit-manager.js';
import { riskEngine } from './engine/risk-engine.js';
import { liveEngine } from './execution/live-engine.js';
import { executionWalletManager } from './execution/wallet-manager.js';
import { telegramNotifier } from './notifications/telegram.js';
import { HeliusWebSocketStream } from './streams/helius-ws.js';
import { rpcPoller } from './streams/rpc-poller.js';
import { signalManager } from './streams/signal-manager.js';

async function bootstrap() {
  // Startup self-test for execution wallet (prints ONLY public key)
  executionWalletManager.logStartupStatus();

  // STRICT: LIVE mode starts DISARMED by default. Requires explicit operator arming via /api/live/arm
  const liveStatus = liveEngine.getStatus();

  const walletPubkey = executionWalletManager.getPublicKeyBase58();
  const walletBalSol = executionWalletManager.getCachedBalanceSol();
  const spendableSol = Math.max(0, walletBalSol - config.MIN_SOL_RESERVE_SOL);

  console.log(`
  =============================================================
     ⚡ LOW-LATENCY SOLANA COPY-TRADING BOT (MVP 2026) ⚡
  =============================================================
  - Mode:               [${config.EXECUTION_MODE}] ${config.EXECUTION_MODE === 'LIVE' ? (liveStatus.isArmed ? '● BOT ACTIVATED' : '○ BOT DEACTIVATED') : '(Paper Simulation)'}
  - Execution Wallet:   ${walletPubkey || 'None (PAPER mode)'}
  - Wallet Balance:     ${walletBalSol.toFixed(4)} SOL (Reserve: ${config.MIN_SOL_RESERVE_SOL} SOL | Spendable: ${spendableSol.toFixed(4)} SOL)
  - Jupiter Engine:     Swap API V2 (/order + /execute)
  - Pump.fun Engine:    Adaptive (On-Chain Reserves + Jupiter V2 Graduation Router)
  - Preflight Sim:      ${config.LIVE_REQUIRE_SIMULATION ? 'ENABLED (Safety Enforced)' : 'DISABLED'}
  - Smoke-Test Mode:    ${config.MAINNET_SMOKE_TEST_MODE ? 'ENABLED (1-trade auto-disarm safety)' : 'DISABLED'}
  - Helius Sender:      Mode: ${config.HELIUS_SENDER_MODE} | Tip: ${config.HELIUS_SENDER_TIP_LAMPORTS} lamports
  - Default Sizing:     ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL)
  - Watched Wallets:    ${config.WATCHED_WALLETS.length} registered (${config.WATCHED_WALLETS[0]})
  - Max Entry Gap:      ${config.MAX_ENTRY_GAP_BPS} bps
  - Max Slippage:       ${config.MAX_SLIPPAGE_BPS} bps
  - Signal Max Age:     ${config.MAX_SIGNAL_AGE_MS} ms
  - REST & SSE Server:  http://localhost:${config.API_PORT}
  - Web Dashboard:      http://localhost:${config.DASHBOARD_PORT}
  =============================================================
  `);

  // Start API server for Dashboard & Webhooks
  const app = createApiServer();
  const server = app.listen(config.API_PORT, () => {
    console.info(`[API Server] Running on http://localhost:${config.API_PORT}`);
  });

  // Attach SignalManager to Telegram bot and start interactive command listener
  telegramNotifier.setSignalManager(signalManager);
  telegramNotifier.startInteractivePolling();

  // Register any held SPL tokens into RiskEngine's Lifetime Never-Rebuy Lock
  try {
    const heldMints = await executionWalletManager.getHeldTokenMints();
    for (const m of heldMints) {
      riskEngine.addLifetimeLockedToken(m);
    }
    if (heldMints.length > 0) {
      console.info(`[Risk Engine] Registered ${heldMints.length} held token(s) into Lifetime Never-Rebuy Lock.`);
    }
  } catch {}

  // Start Live Ingestion Feeds
  const heliusWs = new HeliusWebSocketStream({
    onTransaction: (tx) => {
      signalManager.handleIncomingTransaction(tx, 'HELIUS_PRECONFIRMATION', 'SEEN_PRECONF');
    },
    onOpen: () => {
      console.info('[Stream] Hot path signal ingestion active via Helius LaserStream');
    },
    onError: (err) => {
      console.warn('[Stream Warning]:', err.message);
    },
  });

  heliusWs.start();

  // Dynamically update WebSocket subscriptions whenever a wallet is added/removed
  signalManager.on('walletsUpdated', () => {
    heliusWs.resubscribe();
  });

  // Start live mainnet RPC poller in parallel for 100% failover redundancy
  rpcPoller.start();

  // Start Automated Take-Profit & Stop-Loss Engine
  autoExitManager.start(signalManager);

  // Graceful shutdown
  const shutdown = () => {
    console.info('\n[Shutdown] Stopping bot cleanly...');
    autoExitManager.stop();
    heliusWs.stop();
    rpcPoller.stop();
    server.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
