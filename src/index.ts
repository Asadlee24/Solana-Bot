import { createApiServer } from './api/server.js';
import { config } from './config/index.js';
import { db } from './db/database.js';
import { telegramNotifier } from './notifications/telegram.js';
import { HeliusWebSocketStream } from './streams/helius-ws.js';
import { rpcPoller } from './streams/rpc-poller.js';
import { signalManager } from './streams/signal-manager.js';

async function bootstrap() {
  console.log(`
  =============================================================
     ⚡ LOW-LATENCY SOLANA COPY-TRADING BOT (MVP 2026) ⚡
  =============================================================
  - Mode:               [${config.EXECUTION_MODE}]
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

  // Start Live Ingestion Feeds
  const heliusWs = new HeliusWebSocketStream({
    onTransaction: (tx) => {
      signalManager.handleIncomingTransaction(tx, 'HELIUS_PRECONFIRMATION', 'SEEN_PRECONF');
    },
    onOpen: () => {
      console.info('[Stream] Hot path signal ingestion active via Helius LaserStream');
      telegramNotifier.notifyStartup();
    },
    onError: (err) => {
      console.warn('[Stream Warning]:', err.message);
    },
  });

  heliusWs.start();

  // If no Helius key, start live mainnet RPC poller as fallback so target wallet is monitored live!
  if (!config.HELIUS_API_KEY) {
    rpcPoller.start();
  }

  // Graceful shutdown
  const shutdown = () => {
    console.info('\n[Shutdown] Stopping bot cleanly...');
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
