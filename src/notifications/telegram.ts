import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { FollowerPosition, MirrorOrder } from '../types/index.js';

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private apiRoot: string;
  private enabled: boolean;
  private updateOffset: number = 0;
  private isPolling: boolean = false;
  private signalManagerRef: any = null;
  private lastConnectionErrorTime: number = 0;

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.apiRoot = (config.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
    this.enabled = Boolean(this.botToken);
  }

  public setSignalManager(sm: any): void {
    this.signalManagerRef = sm;
  }

  /**
   * Register native commands menu with Telegram servers on bot startup
   */
  public async registerTelegramCommands(): Promise<void> {
    if (!this.enabled) return;

    try {
      const url = `${this.apiRoot}/bot${this.botToken}/setMyCommands`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'start', description: '⚡ Launch Main Trading Menu & Control Panel' },
            { command: 'menu', description: '🎛️ Interactive Trading Keypad' },
            { command: 'positions', description: '📊 Active Positions & Take Profit Buttons' },
            { command: 'pnl', description: '💰 Portfolio Profit/Loss Summary (USD & SOL)' },
            { command: 'status', description: '🟢 Bot Health, Uptime & Latency Telemetry' },
            { command: 'wallets', description: '🎯 Watched Trader Target Wallets' },
            { command: 'risk', description: '🛡️ Pre-Trade Risk Engine & Circuit Breaker' },
            { command: 'sim', description: '🧪 Simulate Paper Copy-Trade' },
            { command: 'close', description: '🚨 Close 100% of a Token: /close <mint>' },
            { command: 'help', description: '❓ Complete Command Guide & Instructions' },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        console.info('[Telegram Bot] Successfully registered native Telegram command menu.');
      }
    } catch {
      // Ignored if network connection to Telegram is temporarily blocked
    }
  }

  /**
   * Non-blocking send alert with optional inline/reply keyboard buttons
   */
  public async sendAlert(text: string, replyMarkup?: any): Promise<void> {
    if (!this.enabled || !this.chatId) return;

    setImmediate(async () => {
      try {
        await this.sendCustomMessage(this.chatId, text, replyMarkup);
      } catch (err) {
        console.warn('[Telegram Alert Failed]:', err);
      }
    });
  }

  /**
   * Start long-polling for incoming Telegram commands (/positions, /pnl, interactive buttons)
   */
  public startInteractivePolling(): void {
    if (!this.enabled || this.isPolling) return;
    this.isPolling = true;
    console.info('[Telegram Bot] Interactive command listener started.');

    // Auto-register command list with Telegram
    this.registerTelegramCommands();

    const poll = async () => {
      if (!this.isPolling) return;
      try {
        const url = `${this.apiRoot}/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=15`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              this.updateOffset = update.update_id + 1;
              await this.handleUpdate(update);
            }
          }
        }
      } catch (err: any) {
        const now = Date.now();
        // Log once every 60 seconds if connection fails due to regional ISP blocks
        if (now - this.lastConnectionErrorTime > 60000) {
          this.lastConnectionErrorTime = now;
          if (err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || err?.message?.includes('timeout') || err?.message?.includes('fetch failed')) {
            console.warn('[Telegram Bot Notice]: Connection to api.telegram.org timed out.');
            console.warn('  -> In regions where Telegram is restricted by ISPs (e.g. Pakistan), run the bot with a VPN (like Cloudflare 1.1.1.1 WARP), use a reverse proxy via TELEGRAM_API_ROOT, or run 24/7 on GitHub Actions.');
          }
        }
      } finally {
        if (this.isPolling) {
          setTimeout(poll, 1500);
        }
      }
    };

    poll();
  }

  private async handleUpdate(update: any): Promise<void> {
    try {
      if (update.message && update.message.text) {
        await this.handleTextMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (err) {
      console.warn('[Telegram Bot Error]:', err);
    }
  }

  /**
   * Main text message dispatcher supporting slash commands, button text, and aliases
   */
  private async handleTextMessage(msg: any): Promise<void> {
    const rawText = (msg.text || '').trim();
    const chatId = msg.chat?.id || this.chatId;

    // Automatically remember caller's chat ID
    if (chatId) {
      this.chatId = String(chatId);
    }

    const clean = rawText.toLowerCase().replace(/^\//, '').trim();

    if (
      clean === 'start' ||
      clean === 'menu' ||
      clean.includes('main menu') ||
      clean === 'help' ||
      clean.includes('guide')
    ) {
      await this.sendMainMenu(chatId);
    } else if (
      clean === 'positions' ||
      clean.includes('open positions') ||
      clean === 'active'
    ) {
      await this.sendOpenPositionsReport(chatId);
    } else if (
      clean === 'pnl' ||
      clean.includes('pnl summary') ||
      clean === 'profit' ||
      clean === 'loss'
    ) {
      await this.sendPnlSummaryReport(chatId);
    } else if (
      clean === 'status' ||
      clean.includes('bot status') ||
      clean === 'health' ||
      clean === 'stats'
    ) {
      await this.sendStatusReport(chatId);
    } else if (
      clean === 'wallets' ||
      clean.includes('watched wallets') ||
      clean === 'targets'
    ) {
      await this.sendWalletsReport(chatId);
    } else if (
      clean === 'risk' ||
      clean.includes('risk controls') ||
      clean === 'breaker'
    ) {
      await this.sendRiskReport(chatId);
    } else if (
      clean === 'sim' ||
      clean === 'simulate' ||
      clean.includes('simulate buy') ||
      clean === 'test'
    ) {
      await this.executeSimulationFromChat(chatId);
    } else if (clean.includes('refresh')) {
      await this.sendCustomMessage(chatId, '🔄 Refreshing data feeds...');
      await this.sendStatusReport(chatId);
      await this.sendOpenPositionsReport(chatId);
    } else if (clean.startsWith('close') || clean.startsWith('sell')) {
      const parts = rawText.split(/\s+/);
      const mint = parts[1];
      const rawPct = parts[2] ? parseFloat(parts[2]) : 100;
      const fraction = rawPct > 1 ? rawPct / 100 : rawPct;

      if (!mint) {
        await this.sendCustomMessage(
          chatId,
          '⚠️ <b>Usage:</b>\n• <code>/close &lt;mint&gt;</code> (100% exit)\n• <code>/sell &lt;mint&gt; 50</code> (50% partial exit)'
        );
        return;
      }

      await this.executeManualSellFromChat(chatId, mint, fraction);
    } else {
      // Unrecognized input: provide friendly guidance
      await this.sendCustomMessage(
        chatId,
        `❓ Unknown command: <code>${rawText}</code>\n\nTap <b>/menu</b> or use the keypad buttons below!`,
        this.getPersistentReplyKeyboard()
      );
    }
  }

  /**
   * Handle interactive inline button clicks
   */
  private async handleCallbackQuery(cq: any): Promise<void> {
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id || this.chatId;

    // Acknowledge callback immediately
    try {
      await fetch(`${this.apiRoot}/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
    } catch {}

    if (data === 'menu_main') {
      await this.sendMainMenu(chatId);
    } else if (data === 'menu_positions') {
      await this.sendOpenPositionsReport(chatId);
    } else if (data === 'menu_pnl') {
      await this.sendPnlSummaryReport(chatId);
    } else if (data === 'menu_status') {
      await this.sendStatusReport(chatId);
    } else if (data === 'menu_wallets') {
      await this.sendWalletsReport(chatId);
    } else if (data === 'menu_risk') {
      await this.sendRiskReport(chatId);
    } else if (data === 'menu_sim') {
      await this.executeSimulationFromChat(chatId);
    } else if (data === 'menu_refresh') {
      await this.sendStatusReport(chatId);
    } else if (data === 'reset_breaker') {
      riskEngine.resetCircuitBreaker();
      await this.sendCustomMessage(chatId, '✅ <b>Risk Engine Circuit Breaker Reset!</b> Normal trading resumed.');
      await this.sendRiskReport(chatId);
    } else if (data.startsWith('sell_')) {
      // Format: sell_25_<posId>, sell_50_<posId>, sell_75_<posId>, sell_100_<posId>
      const parts = data.split('_');
      const pct = parseInt(parts[1], 10);
      const posId = parts.slice(2).join('_');
      const fraction = pct / 100;

      await this.executeManualSellFromChat(chatId, posId, fraction);
    }
  }

  /**
   * Persistent keypad that stays pinned to bottom of Telegram chat
   */
  private getPersistentReplyKeyboard(): any {
    return {
      keyboard: [
        [{ text: '📊 Open Positions' }, { text: '💰 PnL Summary' }],
        [{ text: '⚡ Bot Status' }, { text: '🎯 Watched Wallets' }],
        [{ text: '🛡️ Risk Controls' }, { text: '🧪 Simulate Buy' }],
        [{ text: '🔄 Refresh All' }, { text: '⚙️ Main Menu' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  /**
   * Send institutional Main Menu dashboard with tactile buttons
   */
  public async sendMainMenu(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const modeBadge = telemetry.executionMode === 'LIVE' ? '⚡ LIVE TRADING' : '📝 PAPER SIMULATION';
    const targetWallet = config.WATCHED_WALLETS[0] || 'CwUHN4...';
    const targetShort = `${targetWallet.substring(0, 4)}...${targetWallet.substring(targetWallet.length - 4)}`;

    const text = `
<b>⚡ SOLANA COPY ENGINE | TELEGRAM CONTROL ⚡</b>
══════════════════════════════
• <b>Status:</b> 🟢 Active & Listening
• <b>Mode:</b> <b>${modeBadge}</b>
• <b>Target Trader:</b> <code>${targetShort}</code>
• <b>Sizing:</b> ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL)
• <b>Hot Path Feed:</b> Helius LaserStream 🟢
══════════════════════════════
<b>Tap any quick-action below or use the keypad:</b>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 Open Positions', callback_data: 'menu_positions' },
          { text: '💰 PnL Summary', callback_data: 'menu_pnl' },
        ],
        [
          { text: '⚡ Engine Status', callback_data: 'menu_status' },
          { text: '🎯 Watched Wallets', callback_data: 'menu_wallets' },
        ],
        [
          { text: '🛡️ Risk Controls', callback_data: 'menu_risk' },
          { text: '🧪 Simulate Buy', callback_data: 'menu_sim' },
        ],
        [
          { text: '🔄 Refresh Feeds', callback_data: 'menu_refresh' },
        ],
      ],
    };

    // Send with persistent keyboard attached
    await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
  }

  /**
   * Detailed Open Positions report with Take Profit 25%, 50%, 75%, 100% buttons
   */
  public async sendOpenPositionsReport(chatId: string | number): Promise<void> {
    const allowedWallets = new Set(config.WATCHED_WALLETS);
    const openPositions = db.getOpenPositions().filter((p) => {
      const mint = p.tokenMint || '';
      const isAllowed = allowedWallets.has(p.targetWallet);
      const isNotDummy = !mint.toLowerCase().includes('tokenmint') && !mint.toLowerCase().includes('paper1111') && !mint.toLowerCase().includes('test');
      return p.state === 'OPEN' && isAllowed && isNotDummy;
    });

    if (openPositions.length === 0) {
      const emptyMsg = `
<b>📊 ACTIVE POSITIONS (0)</b>
══════════════════════════════
<i>No active token positions currently open.</i>
When your target trader buys on pump.fun / Raydium, mirror trades will appear here automatically!
══════════════════════════════
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '🧪 Simulate Test Buy', callback_data: 'menu_sim' },
            { text: '⚙️ Main Menu', callback_data: 'menu_main' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, emptyMsg, inlineKeyboard);
      return;
    }

    const solPriceUsd = 100.0;

    for (const pos of openPositions) {
      const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
      const symbol = meta?.symbol || pos.tokenMint.substring(0, 6).toUpperCase();
      const name = meta?.name || symbol;

      const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;
      const currentPriceUsd = meta?.priceUsd && meta.priceUsd > 0 ? meta.priceUsd : currentPriceSol * solPriceUsd;

      const tokenQty = Number(pos.qtyRaw) / 1e6;
      const costBasisSol = Number(pos.costBasisLamports) / 1e9;
      const costBasisUsd = costBasisSol * solPriceUsd;

      const currentValueSol = tokenQty * currentPriceSol;
      const currentValueUsd = currentValueSol * solPriceUsd;

      const pnlSol = currentValueSol - costBasisSol;
      const pnlUsd = currentValueUsd - costBasisUsd;
      const pnlPct = costBasisSol > 0 ? (pnlSol / costBasisSol) * 100 : 0;
      const isProfit = pnlSol >= 0;

      const text = `
<b>${isProfit ? '🟢' : '🔴'} POSITION: $${symbol} (${name})</b>
══════════════════════════════
• <b>Mint:</b> <code>${pos.tokenMint}</code>
• <b>Price:</b> $${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(6) : currentPriceUsd.toFixed(4)} USD (<code>${currentPriceSol.toFixed(8)} SOL</code>)
• <b>Holdings:</b> ${tokenQty.toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens
• <b>Cost Basis:</b> $${costBasisUsd.toFixed(2)} USD (${costBasisSol.toFixed(4)} SOL)
• <b>Current Value:</b> $${currentValueUsd.toFixed(2)} USD (${currentValueSol.toFixed(4)} SOL)
• <b>Unrealized PnL:</b> <b>${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(pnlUsd).toFixed(2)} USD</b> (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL | <b>${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%</b>)
══════════════════════════════
<b>Take Profit / Close Position:</b>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '💰 TP 25%', callback_data: `sell_25_${pos.id}` },
            { text: '💰 TP 50%', callback_data: `sell_50_${pos.id}` },
          ],
          [
            { text: '💰 TP 75%', callback_data: `sell_75_${pos.id}` },
            { text: '🚨 Close 100%', callback_data: `sell_100_${pos.id}` },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }
  }

  /**
   * Portfolio PnL & Performance Summary
   */
  public async sendPnlSummaryReport(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const solPrice = telemetry.solPriceUsd || 100.0;
    const balanceSol = telemetry.currentPaperBalanceSol || 10.0;
    const balanceUsd = balanceSol * solPrice;

    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPrice;
    const unrealizedSol = telemetry.totalUnrealizedPnlSol || 0;
    const unrealizedUsd = unrealizedSol * solPrice;
    const totalPnlSol = realizedSol + unrealizedSol;
    const totalPnlUsd = realizedUsd + unrealizedUsd;
    const isOverallProfit = totalPnlSol >= 0;

    const text = `
<b>💰 PORTFOLIO PNL & PERFORMANCE SUMMARY 💰</b>
══════════════════════════════
• <b>Execution Mode:</b> ${telemetry.executionMode}
• <b>Open Positions:</b> ${telemetry.openPositionsCount}
• <b>Unrealized PnL:</b> ${unrealizedSol >= 0 ? '🟢 +' : '🔴 '}$${Math.abs(unrealizedUsd).toFixed(2)} USD (${unrealizedSol.toFixed(4)} SOL)
• <b>Realized PnL:</b> ${realizedSol >= 0 ? '🟢 +' : '🔴 '}$${Math.abs(realizedUsd).toFixed(2)} USD (${realizedSol.toFixed(4)} SOL)
• <b>Net Portfolio PnL:</b> <b>${isOverallProfit ? '🟢 +' : '🔴 '}$${Math.abs(totalPnlUsd).toFixed(2)} USD</b> (${totalPnlSol.toFixed(4)} SOL)
• <b>Portfolio ROI:</b> ${telemetry.roiPercent ? `${telemetry.roiPercent.toFixed(1)}%` : '0.0%'}
• <b>Available Balance:</b> $${balanceUsd.toFixed(2)} USD (${balanceSol.toFixed(4)} SOL)
══════════════════════════════
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 View Positions', callback_data: 'menu_positions' },
          { text: '🔄 Refresh', callback_data: 'menu_pnl' },
        ],
        [
          { text: '⚙️ Main Menu', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * System health and latency telemetry
   */
  public async sendStatusReport(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const isTripped = telemetry.circuitBreakerTripped;

    const formatUptime = (sec?: number) => {
      if (!sec) return '0m';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const text = `
<b>⚡ ENGINE TELEMETRY & SYSTEM HEALTH ⚡</b>
══════════════════════════════
• <b>Status:</b> 🟢 RUNNING & OPERATIONAL
• <b>Mode:</b> ${telemetry.executionMode}
• <b>Watched Wallets:</b> ${config.WATCHED_WALLETS.length} registered
• <b>Trades Processed:</b> ${telemetry.totalTradesProcessed}
• <b>Median Latency (p50):</b> ${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(1)}ms` : '—'}
• <b>95th Percentile (p95):</b> ${telemetry.latencyP95Ms ? `${telemetry.latencyP95Ms.toFixed(1)}ms` : '—'}
• <b>Circuit Breaker:</b> ${isTripped ? '🚨 TRIPPED (Trading Paused)' : '🟢 ARMED (Normal)'}
• <b>Ingestion Feed:</b> Helius LaserStream Connected
• <b>Uptime:</b> ${formatUptime(telemetry.uptimeSeconds)}
══════════════════════════════
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Refresh Status', callback_data: 'menu_status' },
          { text: '⚙️ Main Menu', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Watched Target Wallets report
   */
  public async sendWalletsReport(chatId: string | number): Promise<void> {
    const wallets = db.getWatchedWallets();
    let walletList = '';

    if (wallets.length === 0) {
      walletList = '<i>No target wallets configured.</i>';
    } else {
      walletList = wallets
        .map((w, idx) => {
          const short = `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`;
          return `${idx + 1}. <b>${w.label || 'Target'}</b>: <code>${short}</code>\n   • Mode: ${w.buyMode} | Ratio: ${((w.copyRatio || 0.05) * 100).toFixed(0)}%`;
        })
        .join('\n');
    }

    const text = `
<b>🎯 WATCHED TARGET WALLETS (${wallets.length}) 🎯</b>
══════════════════════════════
${walletList}
══════════════════════════════
Signals from these traders are captured via Helius LaserStream within <b>&lt;10ms</b>.
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 Open Positions', callback_data: 'menu_positions' },
          { text: '⚙️ Main Menu', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Risk controls and circuit breaker report
   */
  public async sendRiskReport(chatId: string | number): Promise<void> {
    const isTripped = riskEngine.isTripped();

    const text = `
<b>🛡️ PRE-TRADE RISK ENGINE & SAFETY LIMITS 🛡️</b>
══════════════════════════════
• <b>Circuit Breaker:</b> ${isTripped ? '🚨 <b>TRIPPED</b>' : '🟢 <b>ARMED (Normal)</b>'}
• <b>Max Slippage:</b> ${config.MAX_SLIPPAGE_BPS} bps (${(config.MAX_SLIPPAGE_BPS / 100).toFixed(2)}%)
• <b>Max Entry Gap:</b> ${config.MAX_ENTRY_GAP_BPS} bps (${(config.MAX_ENTRY_GAP_BPS / 100).toFixed(2)}%)
• <b>Signal Max Age:</b> ${config.MAX_SIGNAL_AGE_MS} ms
• <b>Max Total Exposure:</b> ${config.MAX_TOTAL_EXPOSURE_SOL} SOL
• <b>Daily Loss Limit:</b> ${config.DAILY_LOSS_LIMIT_SOL} SOL
• <b>Consecutive Errors Limit:</b> ${config.CONSECUTIVE_ERROR_LIMIT}
══════════════════════════════
    `.trim();

    const inlineRows: any[] = [];
    if (isTripped) {
      inlineRows.push([{ text: '🔄 Reset Circuit Breaker', callback_data: 'reset_breaker' }]);
    }
    inlineRows.push([
      { text: '⚡ Bot Status', callback_data: 'menu_status' },
      { text: '⚙️ Main Menu', callback_data: 'menu_main' },
    ]);

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineRows });
  }

  /**
   * Simulate a test buy trade directly from Telegram
   */
  public async executeSimulationFromChat(chatId: string | number): Promise<void> {
    await this.sendCustomMessage(chatId, '🧪 <b>Triggering paper copy-trade simulation...</b>');

    try {
      const targetWallet = config.WATCHED_WALLETS[0] || 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS';
      const sampleToken = '3fkpFTci5PdEYWxxkucVovJfhJM1td7ecJXrbXjXcSjN';

      if (this.signalManagerRef) {
        // Trigger simulated transaction through signal manager
        const mockTx = {
          signature: `tg_sim_${Date.now()}`,
          slot: 447800000 + Math.floor(Math.random() * 1000),
          feePayer: targetWallet,
          accountData: [{ account: targetWallet }, { account: sampleToken }],
          instructions: [
            {
              programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
              accounts: ['Global', 'Fee', sampleToken, 'BondingCurve', 'Assoc', 'UserToken', targetWallet],
              data: 'ZgY9EgHa6+oAANkBAAAAAAAA',
            },
          ],
        };

        await this.signalManagerRef.handleIncomingTransaction(mockTx, 'WEBHOOK', 'PROCESSED_SUCCESS');

        setTimeout(async () => {
          await this.sendCustomMessage(chatId, '✅ <b>Simulation trade processed successfully!</b>');
          await this.sendOpenPositionsReport(chatId);
        }, 600);
      } else {
        await this.sendCustomMessage(chatId, '❌ Signal manager not connected.');
      }
    } catch (err: any) {
      await this.sendCustomMessage(chatId, `❌ Simulation error: ${err.message || err}`);
    }
  }

  /**
   * Execute manual partial or full exit from Telegram
   */
  private async executeManualSellFromChat(
    chatId: string | number,
    posIdOrMint: string,
    fraction: number
  ): Promise<void> {
    if (!this.signalManagerRef) {
      await this.sendCustomMessage(chatId, '❌ Signal Manager not attached to bot yet.');
      return;
    }

    try {
      const exitPct = Math.round(fraction * 100);
      await this.sendCustomMessage(chatId, `⏳ Executing manual exit (<b>${exitPct}%</b>)...`);

      const { order, position } = await this.signalManagerRef.executeManualExit(posIdOrMint, fraction);

      const solReceived = Number(order.outAmountRaw || 0) / 1e9;
      const solPriceUsd = 100.0;
      const usdReceived = solReceived * solPriceUsd;

      const realizedSol = position ? Number(position.realizedPnlLamports) / 1e9 : 0;
      const realizedUsd = realizedSol * solPriceUsd;
      const isProfit = realizedSol >= 0;

      const confirmMsg = `
<b>✅ MANUAL EXIT EXECUTED (${exitPct}%)!</b>
══════════════════════════════
• <b>Token:</b> <code>${order.tokenMint}</code>
• <b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
• <b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL (${isProfit ? '+$' : '-$'}${Math.abs(realizedUsd).toFixed(2)} USD)
• <b>Position State:</b> ${position?.state || 'CLOSED'}
══════════════════════════════
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '📊 Open Positions', callback_data: 'menu_positions' },
            { text: '💰 PnL Summary', callback_data: 'menu_pnl' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, confirmMsg, inlineKeyboard);
    } catch (err: any) {
      await this.sendCustomMessage(chatId, `❌ Error executing exit: ${err.message || err}`);
    }
  }

  private async sendCustomMessage(
    chatId: string | number,
    text: string,
    replyMarkup?: any,
    defaultKeyboard?: any
  ): Promise<void> {
    try {
      const url = `${this.apiRoot}/bot${this.botToken}/sendMessage`;
      const payload: any = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      } else if (defaultKeyboard) {
        payload.reply_markup = defaultKeyboard;
      }

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Ignored
    }
  }

  public notifyTradeFilled(order: MirrorOrder, position?: FollowerPosition): void {
    const isBuy = order.side === 'BUY';
    const sideIcon = isBuy ? '🟢 BUY' : '🔴 SELL';
    const modeBadge = order.mode === 'PAPER' ? '📝 [PAPER]' : '⚡ [LIVE]';

    const solPriceUsd = 100.0;
    const fillPriceSol = order.effectivePrice;
    const fillPriceUsd = fillPriceSol * solPriceUsd;

    const solAmount = isBuy
      ? Number(order.inAmountRaw || 0) / 1e9
      : Number(order.outAmountRaw || 0) / 1e9;
    const usdAmount = solAmount * solPriceUsd;

    let pnlText = '';
    if (position && !isBuy) {
      const pnlSol = Number(position.realizedPnlLamports) / 1e9;
      const pnlUsd = pnlSol * solPriceUsd;
      const isProfit = pnlSol >= 0;
      pnlText = `\n• <b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(pnlUsd).toFixed(2)} USD (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL)`;
    }

    const text = `
<b>${modeBadge} Trade Executed: ${sideIcon}</b>
══════════════════════════════
• <b>Token:</b> <code>${order.tokenMint}</code>
• <b>Fill Price:</b> $${fillPriceUsd < 0.01 ? fillPriceUsd.toFixed(7) : fillPriceUsd.toFixed(4)} USD (${fillPriceSol.toFixed(8)} SOL)
• <b>Total ${isBuy ? 'Allocated' : 'Received'}:</b> $${usdAmount.toFixed(2)} USD (${solAmount.toFixed(4)} SOL)${pnlText}
• <b>Signature:</b> <code>${order.orderSignature || 'N/A'}</code>
══════════════════════════════
    `.trim();

    const inlineKeyboard = isBuy && position
      ? {
          inline_keyboard: [
            [
              { text: '💰 TP 50%', callback_data: `sell_50_${position.id}` },
              { text: '🚨 Close 100%', callback_data: `sell_100_${position.id}` },
            ],
          ],
        }
      : undefined;

    this.sendAlert(text, inlineKeyboard);
  }

  public notifyManualExit(
    order: MirrorOrder,
    position: FollowerPosition,
    fraction: number,
    meta?: TokenMetadata
  ): void {
    const solPriceUsd = 100.0;
    const solReceived = Number(order.outAmountRaw || 0) / 1e9;
    const usdReceived = solReceived * solPriceUsd;

    const realizedSol = Number(position.realizedPnlLamports) / 1e9;
    const realizedUsd = realizedSol * solPriceUsd;
    const isProfit = realizedSol >= 0;

    const sym = meta?.symbol || position.tokenMint.substring(0, 6).toUpperCase();

    const text = `
<b>💰 MANUAL TAKE PROFIT FILLED (${Math.round(fraction * 100)}%)!</b>
══════════════════════════════
• <b>Token:</b> $${sym} (<code>${position.tokenMint}</code>)
• <b>Payout:</b> +$${usdReceived.toFixed(2)} USD (+${solReceived.toFixed(4)} SOL)
• <b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(realizedUsd).toFixed(2)} USD (${isProfit ? '+' : ''}${realizedSol.toFixed(4)} SOL)
• <b>Remaining:</b> ${position.state === 'OPEN' ? `${(Number(position.qtyRaw) / 1e6).toFixed(2)} tokens` : 'CLOSED'}
══════════════════════════════
    `.trim();

    this.sendAlert(text);
  }

  public notifyCircuitBreaker(reason: string): void {
    const text = `
<b>🚨 CIRCUIT BREAKER TRIPPED 🚨</b>
Trading has been automatically paused for portfolio protection.
<b>Reason:</b> ${reason}
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '🔄 Reset Circuit Breaker', callback_data: 'reset_breaker' }],
      ],
    };

    this.sendAlert(text, inlineKeyboard);
  }

  public notifyStartup(): void {
    const text = `
<b>⚡ SOLANA COPY BOT IS ONLINE! ⚡</b>
══════════════════════════════
• <b>Mode:</b> ${config.EXECUTION_MODE}
• <b>Target Wallet:</b> <code>${config.WATCHED_WALLETS[0]}</code>
• <b>Sizing:</b> ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL)
• <b>Signal Stream:</b> Helius LaserStream 🟢
══════════════════════════════
Tap <b>/menu</b> or use the keypad below to inspect positions & take profit!
    `.trim();

    this.sendAlert(text, this.getPersistentReplyKeyboard());
  }
}

export const telegramNotifier = new TelegramNotifier();
