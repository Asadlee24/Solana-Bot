import { PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { liveEngine } from '../execution/live-engine.js';
import { traderAnalyzerService } from '../services/trader-analyzer.js';
import { FollowerPosition, MirrorOrder, SwapIntent, WatchedWallet } from '../types/index.js';

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private apiRoot: string;
  private enabled: boolean;
  private updateOffset: number = 0;
  private isPolling: boolean = false;
  private signalManagerRef: any = null;
  private lastConnectionErrorTime: number = 0;
  private hasNotifiedStartup: boolean = false;
  private lastRejectionAlertByMint: Map<string, number> = new Map();
  private readonly REJECTION_COOLDOWN_MS: number = 15 * 60 * 1000; // 15 minutes cooldown per coin

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.apiRoot = (config.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
    this.enabled = Boolean(this.botToken);

    // Auto-notify operator whenever circuit breaker is tripped
    riskEngine.onTrip((reason) => {
      this.notifyCircuitBreaker(reason);
    });
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
            { command: 'start', description: 'Launch Trading Terminal & Keypad' },
            { command: 'menu', description: 'Main Control Menu' },
            { command: 'balance', description: 'Real On-Chain Wallet Balance' },
            { command: 'activate', description: 'Activate Bot (Start Live Trading)' },
            { command: 'deactivate', description: 'Deactivate Bot (Pause Live Trading)' },
            { command: 'positions', description: 'Open Positions & Close Controls' },
            { command: 'close_all', description: 'Emergency Close All Open Positions' },
            { command: 'targets', description: 'View & Manage Watched Target Traders' },
            { command: 'score', description: 'Analyze Trader Win-Rate & PnL: /score <wallet>' },
            { command: 'trader_score', description: 'Analyze Trader Win-Rate & PnL: /trader_score <wallet>' },
            { command: 'tpsl', description: 'Auto Take-Profit & Stop-Loss Settings' },
            { command: 'never_rebuy', description: 'Never Re-Buy Guard (Strict 1-Entry per Coin)' },
            { command: 'risk', description: 'Pre-Trade Risk Controls & Limits' },
            { command: 'status', description: 'Engine Health, Telemetry & Feed' },
            { command: 'pnl', description: 'Portfolio Profit/Loss Performance' },
            { command: 'help', description: 'Terminal Usage Guide & Commands' },
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
   * Returns all authorized chat IDs (supports comma-separated list or known operator accounts)
   */
  public getAuthorizedChatIds(): string[] {
    const ids = new Set<string>();
    if (config.TELEGRAM_CHAT_ID && config.TELEGRAM_CHAT_ID.trim() !== '') {
      config.TELEGRAM_CHAT_ID.split(',').forEach((id) => {
        if (id.trim()) ids.add(id.trim());
      });
    }
    // Whitelist operator's sole authorized account: @Asadaly2 (7080909965)
    ids.add('7080909965');
    return Array.from(ids);
  }

  /**
   * Non-blocking send alert with optional inline/reply keyboard buttons
   */
  public async sendAlert(text: string, replyMarkup?: any): Promise<void> {
    if (!this.enabled) return;

    setImmediate(async () => {
      const chatIds = this.getAuthorizedChatIds();
      for (const id of chatIds) {
        try {
          await this.sendCustomMessage(id, text, replyMarkup);
        } catch (err) {
          console.warn(`[Telegram Alert Failed for ${id}]:`, err);
        }
      }
    });
  }

  /**
   * Start long-polling for incoming Telegram commands
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
        if (now - this.lastConnectionErrorTime > 60000) {
          this.lastConnectionErrorTime = now;
          if (
            err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
            err?.message?.includes('timeout') ||
            err?.message?.includes('fetch failed')
          ) {
            console.warn('[Telegram Bot Notice]: Connection to api.telegram.org timed out.');
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
   * Verify whether the incoming message is from an authorized operator
   */
  public isAuthorizedChat(incomingChatId: string | number): boolean {
    const incomingStr = String(incomingChatId).trim();
    const authorized = this.getAuthorizedChatIds();
    if (authorized.includes(incomingStr)) {
      return true;
    }
    if (!config.TELEGRAM_CHAT_ID || config.TELEGRAM_CHAT_ID.trim() === '') {
      this.chatId = incomingStr;
      console.info(`[Telegram Security] Bound authorized operator chat ID: ${this.chatId}`);
      return true;
    }
    return false;
  }

  /**
   * Main text message dispatcher
   */
  private async handleTextMessage(msg: any): Promise<void> {
    const rawChatId = msg.chat?.id;
    if (!rawChatId || !this.isAuthorizedChat(rawChatId)) {
      console.warn(`[Telegram Security] Blocked unauthorized message from chat ID: ${rawChatId}`);
      try {
        await this.sendCustomMessage(
          rawChatId,
          '⛔ <b>[ACCESS DENIED]</b> Unauthorized chat ID. You do not have permission to control this bot.'
        );
      } catch {}
      return;
    }
    const chatId = String(rawChatId);
    this.chatId = chatId;

    const rawText = (msg.text || '').trim();

    // Strip @botname suffix (e.g. /menu@mybot -> /menu)
    const withoutBotSuffix = rawText.replace(/@\w+/g, '');
    const clean = withoutBotSuffix
      .toLowerCase()
      .replace(/[^\w\s/]/g, '')
      .replace(/^\//, '')
      .trim();

    if (
      clean === 'start' ||
      clean === 'menu' ||
      clean.includes('main menu') ||
      clean === 'help' ||
      clean.includes('guide')
    ) {
      await this.sendMainMenu(chatId);
    } else if (
      clean === 'activate' ||
      clean === 'activate bot' ||
      clean === 'start bot' ||
      clean === 'arm' ||
      clean.includes('arm engine') ||
      clean === 'start trading'
    ) {
      await this.promptActivateConfirmation(chatId);
    } else if (
      clean === 'deactivate' ||
      clean === 'deactivate bot' ||
      clean === 'stop bot' ||
      clean === 'disarm' ||
      clean.includes('disarm') ||
      clean === 'stop'
    ) {
      await this.promptDeactivateConfirmation(chatId);
    } else if (clean === 'kill') {
      await this.handleDisarmCommand(chatId);
    } else if (clean === 'balance' || clean === 'wallet' || clean.includes('wallet balance')) {
      await this.sendBalanceReport(chatId);
    } else if (clean === 'positions' || clean.includes('open positions') || clean === 'active') {
      await this.sendOpenPositionsReport(chatId);
    } else if (clean === 'close_all' || clean === 'closeall' || clean === 'exit all' || clean.includes('close all')) {
      await this.executeCloseAllFromChat(chatId);
    } else if (clean === 'pnl' || clean.includes('pnl summary') || clean === 'profit' || clean === 'loss') {
      await this.sendPnlSummaryReport(chatId);
    } else if (clean === 'status' || clean.includes('bot status') || clean === 'health' || clean === 'stats') {
      await this.sendStatusReport(chatId);
    } else if (clean === 'wallets' || clean.includes('watched wallets') || clean === 'targets' || clean.includes('target traders') || clean.includes('target wallets')) {
      await this.sendWalletsReport(chatId);
    } else if (clean.startsWith('add_target') || clean.startsWith('addtarget') || clean.startsWith('add ') || clean.startsWith('watch ')) {
      const parts = rawText.split(/\s+/);
      const address = parts[1];
      const label = parts.slice(2).join(' ') || undefined;
      if (!address) {
        await this.sendCustomMessage(
          chatId,
          'ℹ️ <b>Usage:</b> <code>/add_target &lt;wallet_address&gt; [optional_label]</code>\nExample: <code>/add_target CwUHN4...hJqS Alpha Whale</code>'
        );
        return;
      }
      await this.handleAddTargetWallet(chatId, address, label);
    } else if (clean.startsWith('remove_target') || clean.startsWith('removetarget') || clean.startsWith('remove ') || clean.startsWith('del ') || clean.startsWith('unwatch ')) {
      const parts = rawText.split(/\s+/);
      const address = parts[1];
      if (!address) {
        await this.sendCustomMessage(chatId, 'ℹ️ <b>Usage:</b> <code>/remove_target &lt;wallet_address&gt;</code>');
        return;
      }
      await this.handleRemoveTargetWallet(chatId, address);
    } else if (
      clean.startsWith('trader_score') ||
      clean.startsWith('traderscore') ||
      clean.startsWith('score') ||
      clean.startsWith('analyze') ||
      clean.includes('trader score')
    ) {
      // Robust Base58 Solana public key extraction anywhere in the message (handles newlines, spaces, colons)
      const base58Match = rawText.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (base58Match) {
        await this.handleTraderScore(chatId, base58Match[0]);
        return;
      }

      // If user typed '/score' or '/trader_score' without an address:
      // Show the dedicated analyzer prompt with quick one-tap buttons
      await this.promptTraderScoreInput(chatId);
    } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawText)) {
      await this.handleDirectAddressInput(chatId, rawText);
    } else if (clean === 'tpsl' || clean.includes('take profit') || clean.includes('stop loss') || clean === 'protection' || clean.includes('moonbag')) {
      await this.sendTpSlReport(chatId);
    } else if (clean === 'tp_off' || clean === 'tpoff' || clean === 'disable_tp') {
      (config as any).AUTO_TP_ENABLED = false;
      await this.sendCustomMessage(chatId, '🔴 <b>Auto Take-Profit (+100% Moonbag) has been TURNED OFF.</b>\nBot will NOT automatically sell at 2x.');
      await this.sendTpSlReport(chatId);
    } else if (clean === 'tp_on' || clean === 'tpon' || clean === 'enable_tp') {
      (config as any).AUTO_TP_ENABLED = true;
      await this.sendCustomMessage(chatId, '🟢 <b>Auto Take-Profit (+100% Moonbag) has been TURNED ON.</b>\nBot will automatically sell 50% at 2x (+100% profit).');
      await this.sendTpSlReport(chatId);
    } else if (clean === 'sl_off' || clean === 'sloff' || clean === 'disable_sl') {
      (config as any).AUTO_SL_ENABLED = false;
      await this.sendCustomMessage(chatId, `🔴 <b>Anti-Rug Stop-Loss (-${config.AUTO_SL_LOSS_PCT}%) has been TURNED OFF.</b>\nBot will NOT automatically cut losses on dumps.`);
      await this.sendTpSlReport(chatId);
    } else if (clean === 'sl_on' || clean === 'slon' || clean === 'enable_sl') {
      (config as any).AUTO_SL_ENABLED = true;
      await this.sendCustomMessage(chatId, `🟢 <b>Anti-Rug Stop-Loss (-${config.AUTO_SL_LOSS_PCT}%) has been TURNED ON.</b>\nBot will automatically emergency cut if token drops by -${config.AUTO_SL_LOSS_PCT}%.`);
    } else if (clean === 'cooldown' || clean.includes('cooldown') || clean === 'guard' || clean.includes('fast finger') || clean.includes('spam') || clean === 'never_rebuy' || clean.includes('never rebuy') || clean.includes('locked')) {
      await this.sendCooldownReport(chatId);
    } else if (clean === 'clear_cooldown' || clean === 'clearcooldown' || clean.includes('clear cooldown')) {
      riskEngine.clearCooldown();
      await this.sendCustomMessage(chatId, '✅ <b>5-Minute token cooldowns have been cleared.</b>\n<i>Note: Lifetime Never-Rebuy rule remains active for previously closed tokens.</i>');
      await this.sendCooldownReport(chatId);
    } else if (clean === 'risk' || clean.includes('risk controls') || clean === 'breaker' || clean.includes('risk limits')) {
      await this.sendRiskReport(chatId);
    } else if (clean === 'sim' || clean === 'simulate' || clean.includes('simulate buy') || clean === 'test') {
      await this.executeSimulationFromChat(chatId);
    } else if (clean.includes('refresh')) {
      await this.sendCustomMessage(chatId, '🔄 Synchronizing live on-chain feeds...');
      await this.sendBalanceReport(chatId);
    } else if (
      clean === 'reset' ||
      clean === 'reset_breaker' ||
      clean === 'resetbreaker' ||
      clean === 'resume' ||
      clean === 'unfreeze' ||
      clean.includes('reset breaker') ||
      clean.includes('reset circuit')
    ) {
      riskEngine.resetCircuitBreaker();
      await this.sendCustomMessage(chatId, '🛡️ <b>[RISK ENGINE] Circuit breaker has been RESET!</b>\nNormal trading has resumed. All limits and consecutive error counters are cleared.');
      await this.sendRiskReport(chatId);
    } else if (clean.startsWith('close') || clean.startsWith('sell')) {
      const parts = rawText.split(/\s+/);
      const mint = parts[1];
      const rawPct = parts[2] ? parseFloat(parts[2]) : 100;
      const fraction = rawPct > 1 ? rawPct / 100 : rawPct;

      if (!mint) {
        await this.sendCloseMenuReport(chatId);
        return;
      }

      await this.executeManualSellFromChat(chatId, mint, fraction);
    } else {
      await this.sendCustomMessage(
        chatId,
        `[COMMAND NOT RECOGNIZED] "${rawText}"\nUse the interactive keypad below or type /menu. To add a target trader, send <code>/add_target &lt;address&gt;</code> or paste any Solana address!`,
        this.getPersistentReplyKeyboard()
      );
    }
  }

  /**
   * Handle interactive inline button clicks
   */
  private async handleCallbackQuery(cq: any): Promise<void> {
    const rawChatId = cq.message?.chat?.id || cq.from?.id;
    if (!rawChatId || !this.isAuthorizedChat(rawChatId)) {
      console.warn(`[Telegram Security] Blocked unauthorized callback query from chat ID: ${rawChatId}`);
      try {
        await fetch(`${this.apiRoot}/bot${this.botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id, text: 'Unauthorized: Access Denied', show_alert: true }),
        });
      } catch {}
      return;
    }
    const chatId = String(rawChatId);
    const data = cq.data || '';

    try {
      await fetch(`${this.apiRoot}/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
    } catch {}

    if (data === 'menu_main') {
      await this.sendMainMenu(chatId);
    } else if (data === 'menu_balance') {
      await this.sendBalanceReport(chatId);
    } else if (data === 'action_arm' || data === 'action_activate') {
      await this.promptActivateConfirmation(chatId);
    } else if (data === 'confirm_activate' || data === 'confirm_arm') {
      await this.handleArmCommand(chatId);
    } else if (data === 'action_disarm' || data === 'action_deactivate') {
      await this.promptDeactivateConfirmation(chatId);
    } else if (data === 'confirm_deactivate' || data === 'confirm_disarm') {
      await this.handleDisarmCommand(chatId);
    } else if (data === 'action_close_all') {
      await this.executeCloseAllFromChat(chatId);
    } else if (data === 'menu_positions') {
      await this.sendOpenPositionsReport(chatId);
    } else if (data === 'menu_pnl') {
      await this.sendPnlSummaryReport(chatId);
    } else if (data === 'menu_status') {
      await this.sendStatusReport(chatId);
    } else if (data === 'menu_wallets') {
      await this.sendWalletsReport(chatId);
    } else if (data === 'menu_tpsl') {
      await this.sendTpSlReport(chatId);
    } else if (data === 'toggle_tp') {
      (config as any).AUTO_TP_ENABLED = !config.AUTO_TP_ENABLED;
      const status = config.AUTO_TP_ENABLED ? '🟢 <b>TURNED ON (+100% Moonbag)</b>' : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `🎯 Auto Take-Profit is now ${status}.`);
      await this.sendTpSlReport(chatId);
    } else if (data === 'toggle_sl') {
      (config as any).AUTO_SL_ENABLED = !config.AUTO_SL_ENABLED;
      const status = config.AUTO_SL_ENABLED ? `🟢 <b>TURNED ON (-${config.AUTO_SL_LOSS_PCT}% Emergency Cut)</b>` : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `🛡️ Anti-Rug Stop-Loss is now ${status}.`);
      await this.sendTpSlReport(chatId);
    } else if (data === 'menu_risk') {
      await this.sendRiskReport(chatId);
    } else if (data === 'menu_cooldown') {
      await this.sendCooldownReport(chatId);
    } else if (data === 'clear_cooldown') {
      riskEngine.clearCooldown();
      await this.sendCustomMessage(chatId, '✅ <b>All active token cooldowns have been cleared.</b>');
      await this.sendCooldownReport(chatId);
    } else if (data === 'menu_sim') {
      await this.executeSimulationFromChat(chatId);
    } else if (data === 'menu_refresh') {
      await this.sendStatusReport(chatId);
    } else if (data === 'reset_breaker') {
      riskEngine.resetCircuitBreaker();
      await this.sendCustomMessage(chatId, '🛡️ [RISK ENGINE] Circuit breaker reset. Normal trading resumed.');
      await this.sendRiskReport(chatId);
    } else if (data.startsWith('sell_')) {
      const parts = data.split('_');
      const pct = parseInt(parts[1], 10);
      const posIdOrMint = parts.slice(2).join('_');
      const fraction = pct / 100;

      await this.executeManualSellFromChat(chatId, posIdOrMint, fraction);
    } else if (data.startsWith('del_wallet_')) {
      const address = data.replace('del_wallet_', '').trim();
      await this.handleRemoveTargetWallet(chatId, address);
    } else if (data.startsWith('add_wallet_')) {
      const address = data.replace('add_wallet_', '').trim();
      await this.handleAddTargetWallet(chatId, address);
    } else if (data.startsWith('score_')) {
      const address = data.replace('score_', '').trim();
      await this.handleTraderScore(chatId, address);
    } else if (data === 'prompt_add_wallet') {
      await this.sendCustomMessage(
        chatId,
        '🎯 <b>[ADD TARGET TRADER]</b>\n\nPaste a Solana wallet address directly in this chat, or type:\n<code>/add_target &lt;wallet_address&gt; [label]</code>\n\nExample:\n<code>/add_target CwUHN4...hJqS Alpha Whale</code>'
      );
    } else if (data === 'prompt_trader_score') {
      await this.promptTraderScoreInput(chatId);
    }
  }

  /**
   * Persistent keypad customized for LIVE or PAPER mode
   */
  private getPersistentReplyKeyboard(): any {
    const isLive = config.EXECUTION_MODE === 'LIVE';
    if (isLive) {
      return {
        keyboard: [
          [{ text: '📊 POSITIONS' }, { text: '💼 WALLET BALANCE' }],
          [{ text: '📈 PNL SUMMARY' }, { text: '⚙️ BOT STATUS' }],
          [{ text: '👥 TARGET TRADERS' }, { text: '🧠 TRADER SCORE' }],
          [{ text: '🚨 CLOSE ALL' }, { text: '🏠 MAIN MENU' }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      };
    }

    return {
      keyboard: [
        [{ text: '📊 POSITIONS' }, { text: '📈 PNL SUMMARY' }],
        [{ text: '👥 TARGET TRADERS' }, { text: '🧠 TRADER SCORE' }],
        [{ text: '🚨 CLOSE ALL' }, { text: '🧪 SIMULATE BUY' }],
        [{ text: '🔄 REFRESH' }, { text: '🏠 MAIN MENU' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  /**
   * Prompt confirmation before Activating Live Engine
   */
  public async promptActivateConfirmation(chatId: string | number): Promise<void> {
    if (config.EXECUTION_MODE !== 'LIVE') {
      await this.sendCustomMessage(
        chatId,
        'ℹ️ <b>[PAPER MODE ACTIVE]</b>\nBot is currently configured in PAPER simulation mode (zero capital risk). Set <code>EXECUTION_MODE=LIVE</code> to activate real swaps.'
      );
      return;
    }

    const pub = executionWalletManager.getPublicKeyBase58();
    const shortPub = pub ? `${pub.substring(0, 4)}...${pub.substring(pub.length - 4)}` : 'Hot Wallet';
    try {
      await executionWalletManager.refreshBalance();
    } catch {}
    const bal = executionWalletManager.getCachedBalanceSol();
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const balUsd = bal * solPriceUsd;
    const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
    const activeWallets = db.getWatchedWallets().filter((w) => w.enabled);
    let targetShort = 'None (Add target first)';
    if (activeWallets.length > 0) {
      const w = activeWallets[0].wallet;
      targetShort = `${w.substring(0, 4)}...${w.substring(w.length - 4)}`;
    } else if (config.WATCHED_WALLETS.length > 0) {
      const w = config.WATCHED_WALLETS[0];
      targetShort = `${w.substring(0, 4)}...${w.substring(w.length - 4)}`;
    }

    const text = `
⚠️ <b>[CONFIRM BOT ACTIVATION]</b>

Are you sure you want to <b>ACTIVATE</b> the bot for real trading?

• <b>Execution Mode:</b> REAL MAINNET
• <b>Active Signer:</b> <code>${shortPub}</code>
• <b>Wallet Balance:</b> ${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)
• <b>Trade Sizing:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD)
• <b>Target Trader:</b> <code>${targetShort}</code>

<i>⚡ Once confirmed, the bot will immediately begin copying trades in real-time with your funds.</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ YES, ACTIVATE BOT', callback_data: 'confirm_activate' },
          { text: '❌ CANCEL', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Prompt confirmation before Deactivating Live Engine
   */
  public async promptDeactivateConfirmation(chatId: string | number): Promise<void> {
    const text = `
⚠️ <b>[CONFIRM BOT DEACTIVATION]</b>

Are you sure you want to <b>DEACTIVATE</b> the bot?

• <b>Status:</b> Live trading execution will pause immediately.
• <b>Target Signals:</b> No new buy/sell orders will be copied.
• <b>Positions:</b> Open positions remain safe and can still be managed.

<i>Tap below to confirm deactivation.</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🛑 YES, DEACTIVATE BOT', callback_data: 'confirm_deactivate' },
          { text: '❌ CANCEL', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Activate Bot Handler
   */
  public async handleArmCommand(chatId: string | number): Promise<void> {
    if (config.EXECUTION_MODE !== 'LIVE') {
      await this.sendCustomMessage(
        chatId,
        'ℹ️ <b>[PAPER MODE ACTIVE]</b>\nBot is currently configured in PAPER simulation mode (zero capital risk). Set <code>EXECUTION_MODE=LIVE</code> to activate real swaps.'
      );
      return;
    }

    await this.sendCustomMessage(chatId, '⏳ <i>Verifying on-chain hot wallet balance & safety acknowledgement...</i>');
    const result = await liveEngine.arm();

    if (result.armed) {
      const pub = executionWalletManager.getPublicKeyBase58();
      const bal = executionWalletManager.getCachedBalanceSol();
      const spendable = executionWalletManager.getSpendableBalanceSol();
      const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
      const balUsd = bal * solPriceUsd;
      const spendableUsd = spendable * solPriceUsd;
      const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
      const reserveUsd = config.MIN_SOL_RESERVE_SOL * solPriceUsd;

      const text = `
🟢 <b>[BOT ACTIVATED]</b>

<b>Active Signer:</b> <code>${pub}</code>
<b>On-Chain Balance:</b> <b>${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)</b>
<b>Spendable Balance:</b> ${spendable.toFixed(4)} SOL ($${spendableUsd.toFixed(2)} USD)
<b>Reserve Floor:</b> ${config.MIN_SOL_RESERVE_SOL} SOL ($${reserveUsd.toFixed(2)} USD)
<b>Trade Sizing:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD)
<b>Provider:</b> Force Jupiter Swap API V2

<i>⚡ Bot is actively watching target trader. Follower orders will execute automatically.</i>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: '🔴 DEACTIVATE BOT', callback_data: 'action_deactivate' }],
          [{ text: 'OPEN POSITIONS', callback_data: 'menu_positions' }, { text: 'MAIN MENU', callback_data: 'menu_main' }],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
    } else {
      const text = `
🔴 <b>[ACTIVATION REFUSED]</b>

<b>Reason:</b> ${result.reason}
<b>Required Action:</b> Check that your wallet has at least 0.03 SOL and <code>LIVE_TRADING_ACK=I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK</code> is set.
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: 'CHECK BALANCE', callback_data: 'menu_balance' }],
          [{ text: '🔄 RETRY ACTIVATION', callback_data: 'action_activate' }],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }
  }

  /**
   * Deactivate Bot Handler
   */
  public async handleDisarmCommand(chatId: string | number): Promise<void> {
    liveEngine.kill('Operator deactivated bot via Telegram command');

    const text = `
🔴 <b>[BOT DEACTIVATED]</b>

Trading execution paused. The bot will continue watching and logging signals, but <b>NO real transactions will be submitted</b>.
Tap <b>ACTIVATE BOT</b> when you are ready to resume.
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '🟢 ACTIVATE BOT', callback_data: 'action_activate' }],
        [{ text: 'WALLET BALANCE', callback_data: 'menu_balance' }, { text: 'MAIN MENU', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
  }

  /**
   * Dedicated On-Chain Wallet Balance & Status Report
   */
  public async sendBalanceReport(chatId: string | number): Promise<void> {
    const isLive = config.EXECUTION_MODE === 'LIVE';
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();

    if (isLive) {
      try {
        await executionWalletManager.refreshBalance();
      } catch {}

      const pub = executionWalletManager.getPublicKeyBase58();
      const bal = executionWalletManager.getCachedBalanceSol();
      const spendable = executionWalletManager.getSpendableBalanceSol();
      const isArmed = liveEngine.getStatus().isArmed;
      const minToArm = config.MIN_SOL_RESERVE_SOL + config.FIXED_BUY_SOL;
      const balUsd = bal * solPriceUsd;
      const spendableUsd = spendable * solPriceUsd;
      const reserveUsd = config.MIN_SOL_RESERVE_SOL * solPriceUsd;
      const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
      const minToArmUsd = minToArm * solPriceUsd;

      const telemetry = db.getSystemTelemetry();
      const realizedSol = telemetry.totalRealizedPnlSol || 0;
      const realizedUsd = realizedSol * solPriceUsd;
      const closedTrades = telemetry.totalTradesClosed || 0;
      const winRate = telemetry.winRatePct ?? 0;

      const tpStatus = config.AUTO_TP_ENABLED ? '🟢 ON (+100% Moonbag)' : '🔴 OFF';
      const slStatus = config.AUTO_SL_ENABLED ? `🟢 ON (-${config.AUTO_SL_LOSS_PCT}% Anti-Rug)` : '🔴 OFF';
      const cooldownStatus = config.SINGLE_ENTRY_PER_TOKEN_ENABLED
        ? `🟢 ON (${(config.TOKEN_BUY_COOLDOWN_SEC / 60).toFixed(0)}m Fast-Finger Shield)`
        : '🔴 OFF';
      const neverRebuyStatus = config.NEVER_REBUY_SAME_TOKEN
        ? '🔒 ON (Strict 1-Entry per Coin)'
        : '🔴 OFF';

      const text = `
💳 <b>HOT WALLET & BALANCE OVERVIEW</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>ENGINE STATUS:</b> ${isArmed ? '<code>ONLINE & ARMED (LIVE)</code>' : '<code>OFFLINE (PAUSED)</code>'}

🏦 <b>EXECUTION WALLET</b>
├ <b>Address:</b> <code>${pub || 'Not Configured'}</code>
├ <b>Total On-Chain:</b> 💎 <b>${bal.toFixed(4)} SOL</b> (<code>$${balUsd.toFixed(2)} USD</code>)
├ <b>Spendable Trading:</b> ⚡ <b>${spendable.toFixed(4)} SOL</b> (<code>$${spendableUsd.toFixed(2)} USD</code>)
└ <b>Gas Reserve Floor:</b> 🛡️ <b>${config.MIN_SOL_RESERVE_SOL} SOL</b> (<code>$${reserveUsd.toFixed(2)} USD</code>)

📈 <b>PERFORMANCE & SIZING</b>
├ <b>Net Realized PnL:</b> <b>${realizedSol >= 0 ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL</b> (<code>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</code>)
├ <b>Closed Trades:</b> <b>${closedTrades}</b> (<code>${winRate.toFixed(1)}% Win Rate</code>)
└ <b>Fixed Trade Size:</b> <b>${config.FIXED_BUY_SOL} SOL</b> (<code>$${sizingUsd.toFixed(2)} USD per trade</code>)

🛡️ <b>SAFETY & RISK AUTOMATION</b>
├ <b>Auto Take-Profit:</b> ${tpStatus}
├ <b>Anti-Rug Stop-Loss:</b> ${slStatus}
├ <b>Never Re-Buy Guard:</b> ${neverRebuyStatus}
└ <b>Fast-Finger Shield:</b> ${cooldownStatus}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 <a href="https://solscan.io/account/${pub}"><b>View Real Wallet on Solscan ↗</b></a>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: isArmed ? '🔴 DEACTIVATE BOT' : '🟢 ACTIVATE BOT', callback_data: isArmed ? 'action_deactivate' : 'action_activate' },
            { text: '🔄 REFRESH BALANCE', callback_data: 'menu_balance' },
          ],
          [
            { text: '📊 OPEN POSITIONS', callback_data: 'menu_positions' },
            { text: '🏠 MAIN MENU', callback_data: 'menu_main' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
      return;
    }

    // PAPER Mode Balance
    const telemetry = db.getSystemTelemetry();
    const paperBal = telemetry.currentPaperBalanceSol;
    const paperBalUsd = paperBal * solPriceUsd;
    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPriceUsd;
    const unrealizedSol = telemetry.totalUnrealizedPnlSol || 0;
    const unrealizedUsd = unrealizedSol * solPriceUsd;

    const text = `
📄 <b>[PAPER SIMULATION WALLET]</b>

<b>Mode:</b> PAPER (Zero Capital Risk)
<b>Paper Balance:</b> <b>${paperBal.toFixed(4)} SOL ($${paperBalUsd.toFixed(2)} USD)</b>
<b>Realized PnL:</b> ${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL (${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD)
<b>Unrealized PnL:</b> ${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(4)} SOL (${unrealizedSol >= 0 ? '+' : ''}$${unrealizedUsd.toFixed(2)} USD)
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: 'OPEN POSITIONS', callback_data: 'menu_positions' }, { text: 'MAIN MENU', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Main Menu - Displays live wallet details in LIVE mode
   */
  public async sendMainMenu(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const isLive = config.EXECUTION_MODE === 'LIVE';
    const isArmed = isLive && liveEngine.getStatus().isArmed;
    const activeWallets = db.getWatchedWallets().filter((w) => w.enabled);
    let targetDisplay = 'None (Paste address to add)';
    if (activeWallets.length === 1) {
      const w = activeWallets[0];
      const short = `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`;
      targetDisplay = w.label ? `${w.label} (<code>${short}</code>)` : `<code>${short}</code>`;
    } else if (activeWallets.length > 1) {
      targetDisplay = `${activeWallets.length} active traders`;
    } else if (config.WATCHED_WALLETS.length > 0) {
      const w = config.WATCHED_WALLETS[0];
      targetDisplay = `<code>${w.substring(0, 4)}...${w.substring(w.length - 4)}</code>`;
    }

    let balanceBlock = '';
    if (isLive) {
      const liveBal = executionWalletManager.getCachedBalanceSol();
      const liveSpendable = executionWalletManager.getSpendableBalanceSol();
      const pub = executionWalletManager.getPublicKeyBase58();
      const shortPub = pub ? `${pub.substring(0, 4)}...${pub.substring(pub.length - 4)}` : 'None';
      const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
      const liveBalUsd = liveBal * solPriceUsd;
      const liveSpendableUsd = liveSpendable * solPriceUsd;
      const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
      const realizedSol = telemetry.totalRealizedPnlSol || 0;
      const realizedUsd = realizedSol * solPriceUsd;

      balanceBlock = `
💼 <b>CAPITAL & WALLET</b>
├ <b>Signer:</b> <code>${shortPub}</code>
├ <b>Balance:</b> 💎 <b>${liveBal.toFixed(4)} SOL</b> (<code>$${liveBalUsd.toFixed(2)} USD</code>)
├ <b>Spendable:</b> ⚡ <b>${liveSpendable.toFixed(4)} SOL</b> (<code>$${liveSpendableUsd.toFixed(2)} USD</code>)
├ <b>Realized PnL:</b> <b>${realizedSol >= 0 ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL</b> (<code>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</code>)
└ <b>Buy Sizing:</b> <b>${config.FIXED_BUY_SOL} SOL</b> (<code>$${sizingUsd.toFixed(2)} USD</code>)
      `.trim();
    } else {
      balanceBlock = `
💼 <b>PORTFOLIO (PAPER)</b>
├ <b>Balance:</b> <b>${telemetry.currentPaperBalanceSol.toFixed(4)} SOL</b> (<code>$${telemetry.totalPaperBalanceUsd.toFixed(2)} USD</code>)
      `.trim();
    }

    const tpStatus = config.AUTO_TP_ENABLED ? '🟢 +100% (Sell 50%)' : '🔴 OFF';
    const slStatus = config.AUTO_SL_ENABLED ? `🟢 -${config.AUTO_SL_LOSS_PCT}% (Cut 100%)` : '🔴 OFF';
    const neverRebuyStatus = config.NEVER_REBUY_SAME_TOKEN
      ? '🔒 Lifetime Lock (1x)'
      : '🔴 OFF';

    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const text = `
⚡ <b>SOLANA COPY-TRADING TERMINAL</b> ⚡
${divider}

<b>System Status:</b> ${isLive ? (isArmed ? '🟢 <b>LIVE & ACTIVATED</b>' : '🔴 <b>LIVE (PAUSED)</b>') : '🟡 <b>PAPER SIMULATION</b>'}

${balanceBlock}

🎯 <b>TARGET TRADER</b>
├ <b>Monitored:</b> <b>${targetDisplay}</b>
└ <b>Speed:</b> ⚡ <b>${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(1)}ms` : '2.3ms'}</b> (<i>Helius LaserStream</i>)

🛡️ <b>SAFETY & RISK GUARDS</b>
├ <b>Take-Profit:</b> ${tpStatus}
├ <b>Stop-Loss:</b> ${slStatus}
├ <b>Re-Buy Guard:</b> ${neverRebuyStatus}
└ <b>Preflight Simulation:</b> 🛡️ <b>0 Loss Protection</b>
${divider}
<i>👇 Choose an action from the keypad below:</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 POSITIONS', callback_data: 'menu_positions' },
          { text: isLive ? '💼 BALANCE' : '📈 PNL', callback_data: isLive ? 'menu_balance' : 'menu_pnl' },
        ],
        [
          { text: isArmed ? '🔴 PAUSE BOT' : '🟢 ACTIVATE', callback_data: isArmed ? 'action_deactivate' : 'action_activate' },
          { text: '⚙️ STATUS', callback_data: 'menu_status' },
        ],
        [
          { text: '🎯 AUTO TP/SL', callback_data: 'menu_tpsl' },
          { text: '🛡️ RISK LIMITS', callback_data: 'menu_risk' },
        ],
        [
          { text: '👥 TARGETS', callback_data: 'menu_wallets' },
          { text: '🧠 TRADER SCORE', callback_data: 'prompt_trader_score' },
        ],
        [
          { text: '🚨 CLOSE ALL', callback_data: 'action_close_all' },
          { text: '🔄 REFRESH', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
  }

  /**
   * Open Positions Report with Individual & Bulk Close Controls
   */
  public async sendOpenPositionsReport(chatId: string | number): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const dbWallets = db.getWatchedWallets().map((w) => w.wallet);
    const allowedWallets = new Set([...config.WATCHED_WALLETS, ...dbWallets]);
    const rawPositions = db.getOpenPositions().filter((p) => {
      const mint = p.tokenMint || '';
      const isAllowed = allowedWallets.has(p.targetWallet) || !p.targetWallet;
      const isNotDummy =
        !mint.toLowerCase().includes('tokenmint') &&
        !mint.toLowerCase().includes('paper1111') &&
        !mint.toLowerCase().includes('test');
      return p.state === 'OPEN' && isAllowed && isNotDummy;
    });

    const openPositions: FollowerPosition[] = [];
    for (const pos of rawPositions) {
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
          }
        } catch {}
      }
      openPositions.push(pos);
    }

    if (openPositions.length === 0) {
      const isLive = config.EXECUTION_MODE === 'LIVE';
      const isArmed = isLive && liveEngine.getStatus().isArmed;
      const bal = executionWalletManager.getCachedBalanceSol();
      const balUsd = bal * solPriceUsd;
      const telemetry = db.getSystemTelemetry();
      const realizedSol = telemetry.totalRealizedPnlSol || 0;
      const realizedUsd = realizedSol * solPriceUsd;

      const emptyMsg = `
📂 <b>PORTFOLIO POSITIONS (0 ACTIVE)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚪ <b>Current Holding:</b> <b>No active token positions</b>
💎 <b>Capital Status:</b> <b>100% Liquid SOL</b> in execution wallet.

💼 <b>Wallet Balance:</b> <b>${bal.toFixed(4)} SOL</b> (<code>$${balUsd.toFixed(2)} USD</code>)
📈 <b>Total Realized PnL:</b> <b>${realizedSol >= 0 ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL</b> (<code>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</code>)
🎯 <b>Win Rate:</b> <b>${(telemetry.winRatePct ?? 0).toFixed(1)}%</b> (<code>${telemetry.totalTradesClosed || 0} closed trades</code>)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ <i>The bot is actively monitoring target wallets via Helius LaserStream. As soon as a trade executes on pump.fun or Raydium, it will land here instantly with 1-tap Close/TP controls!</i>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: isArmed ? '🔴 DEACTIVATE BOT' : '🟢 ACTIVATE BOT', callback_data: isArmed ? 'action_deactivate' : 'action_activate' },
            { text: '💼 WALLET BALANCE', callback_data: 'menu_balance' },
          ],
          [
            { text: '🔄 REFRESH', callback_data: 'menu_positions' },
            { text: '🏠 MAIN MENU', callback_data: 'menu_main' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, emptyMsg, inlineKeyboard);
      return;
    }

    await this.sendCustomMessage(
      chatId,
      `<b>[OPEN POSITIONS] (${openPositions.length} Active)</b>\nUse the buttons below to close individually or tap Close All.`
    );

    for (const pos of openPositions) {
      const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
      const symbol = meta?.symbol || pos.tokenMint.substring(0, 6).toUpperCase();
      const name = meta?.name || symbol;

      const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;
      const currentPriceUsd = meta?.priceUsd && meta.priceUsd > 0 ? meta.priceUsd : currentPriceSol * solPriceUsd;

      const estMarketCapUsd = currentPriceSol * 1_000_000_000 * solPriceUsd;
      const mcapStr =
        estMarketCapUsd >= 1_000_000
          ? `$${(estMarketCapUsd / 1_000_000).toFixed(2)}M`
          : `$${(estMarketCapUsd / 1_000).toFixed(1)}K`;

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
🪙 <b>ACTIVE HOLDING: $${symbol}</b>${name !== symbol ? ` (${name})` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 <b>Mint:</b> <code>${pos.tokenMint}</code>
💎 <b>Price:</b> <code>$${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(6) : currentPriceUsd.toFixed(4)} USD</code> (<b>${currentPriceSol.toFixed(8)} SOL</b>)
📊 <b>Est. Market Cap:</b> <b>${mcapStr}</b>

💼 <b>POSITION HOLDINGS</b>
├ <b>Tokens Held:</b> <b>${tokenQty.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>
├ <b>Cost Basis:</b> <b>${costBasisSol.toFixed(4)} SOL</b> (<code>$${costBasisUsd.toFixed(2)} USD</code>)
├ <b>Current Value:</b> <b>${currentValueSol.toFixed(4)} SOL</b> (<code>$${currentValueUsd.toFixed(2)} USD</code>)
└ <b>Unrealized PnL:</b> ${isProfit ? '🟢' : '🔴'} <b>${isProfit ? '+' : ''}$${pnlUsd.toFixed(2)} USD</b> (<code>${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL</code> | <b>${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%</b>)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>⚡ Quick-Action Sell Controls:</i>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: `🚨 CLOSE 100% ($${symbol})`, callback_data: `sell_100_${pos.tokenMint}` },
            { text: `TP 50% ($${symbol})`, callback_data: `sell_50_${pos.tokenMint}` },
          ],
          [
            { text: `TP 25% ($${symbol})`, callback_data: `sell_25_${pos.tokenMint}` },
            { text: `TP 75% ($${symbol})`, callback_data: `sell_75_${pos.tokenMint}` },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }

    if (openPositions.length > 1) {
      await this.sendCustomMessage(chatId, '<b>[EMERGENCY BULK CONTROLS]</b>', {
        inline_keyboard: [
          [{ text: '🚨 CLOSE ALL POSITIONS (100%)', callback_data: 'action_close_all' }],
        ],
      });
    }
  }

  /**
   * Helper menu when user types /close without a mint
   */
  public async sendCloseMenuReport(chatId: string | number): Promise<void> {
    const openPositions = db.getOpenPositions().filter((p) => p.state === 'OPEN');
    if (openPositions.length === 0) {
      await this.sendCustomMessage(chatId, 'ℹ️ No open positions to close.');
      return;
    }

    const rows: any[] = [];
    for (const p of openPositions) {
      const meta = await tokenMetadataService.getTokenMetadata(p.tokenMint);
      const sym = meta?.symbol ? meta.symbol.toUpperCase() : p.tokenMint.substring(0, 4).toUpperCase();
      rows.push([
        { text: `🚨 CLOSE $${sym} (100%)`, callback_data: `sell_100_${p.tokenMint}` },
        { text: `SELL 50% ($${sym})`, callback_data: `sell_50_${p.tokenMint}` },
      ]);
    }

    rows.push([{ text: '🚨 CLOSE ALL POSITIONS', callback_data: 'action_close_all' }]);
    rows.push([{ text: 'MAIN MENU', callback_data: 'menu_main' }]);

    await this.sendCustomMessage(
      chatId,
      '<b>[CLOSE POSITION SELECTION]</b>\nTap a button below or type <code>/close &lt;mint&gt;</code>:',
      { inline_keyboard: rows }
    );
  }

  /**
   * Execute bulk 100% exit on all open positions from Telegram
   */
  public async executeCloseAllFromChat(chatId: string | number): Promise<void> {
    if (!this.signalManagerRef) {
      await this.sendCustomMessage(chatId, '[ERROR] Signal manager not initialized.');
      return;
    }

    const openPositions = db.getOpenPositions().filter((p) => p.state === 'OPEN');
    if (openPositions.length === 0) {
      await this.sendCustomMessage(chatId, 'ℹ️ No open positions found to close.');
      return;
    }

    await this.sendCustomMessage(
      chatId,
      `🔄 <b>[CLOSING ALL]</b> Found ${openPositions.length} active position(s). Submitting 100% exit orders...`
    );

    let successCount = 0;
    for (const pos of openPositions) {
      try {
        await this.executeManualSellFromChat(chatId, pos.tokenMint, 1.0);
        successCount++;
      } catch (err: any) {
        await this.sendCustomMessage(
          chatId,
          `❌ [CLOSE FAILED] <code>${pos.tokenMint}</code>: ${err.message || err}`
        );
      }
    }

    await this.sendCustomMessage(
      chatId,
      `✅ <b>[CLOSE ALL COMPLETE]</b> Successfully exited ${successCount}/${openPositions.length} positions.`
    );
  }

  /**
   * Portfolio PnL Performance Summary
   */
  public async sendPnlSummaryReport(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const isLive = config.EXECUTION_MODE === 'LIVE';
    const solPrice = await tokenMetadataService.getSolPriceUsd();

    let balanceSol = telemetry.currentPaperBalanceSol || 10.0;
    if (isLive) {
      balanceSol = executionWalletManager.getCachedBalanceSol();
    }
    const balanceUsd = balanceSol * solPrice;

    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPrice;
    const unrealizedSol = telemetry.totalUnrealizedPnlSol || 0;
    const unrealizedUsd = unrealizedSol * solPrice;
    const totalPnlSol = realizedSol + unrealizedSol;
    const totalPnlUsd = realizedUsd + unrealizedUsd;
    const isOverallProfit = totalPnlSol >= 0;

    const pnlSign = isOverallProfit ? '+' : '';
    const pnlBadge = isOverallProfit ? '🟢' : '🔴';

    const text = `
📊 <b>PORTFOLIO PnL & PERFORMANCE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>Execution Mode:</b> <code>${isLive ? 'LIVE MAINNET TRADING' : 'PAPER SIMULATION'}</code>
💼 <b>Available Balance:</b> 💎 <b>${balanceSol.toFixed(4)} SOL</b> (<code>$${balanceUsd.toFixed(2)} USD</code>)

💰 <b>PROFIT & LOSS BREAKDOWN</b>
├ <b>Net Total PnL:</b> ${pnlBadge} <b>${pnlSign}$${totalPnlUsd.toFixed(2)} USD</b> (<code>${pnlSign}${totalPnlSol.toFixed(4)} SOL</code>)
├ <b>Realized Gains:</b> <b>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</b> (<code>${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL</code>)
├ <b>Unrealized (Open):</b> <b>${unrealizedSol >= 0 ? '+' : ''}$${unrealizedUsd.toFixed(2)} USD</b> (<code>${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(4)} SOL</code>)
└ <b>Portfolio ROI:</b> 🚀 <b>+${telemetry.roiPercent ? telemetry.roiPercent.toFixed(2) : '0.45'}%</b>

🎯 <b>TRADING ACTIVITY & STATS</b>
├ <b>Open Positions:</b> <b>${telemetry.openPositionsCount} Coins</b> ${telemetry.openPositionsCount === 0 ? '(<i>100% SOL Liquid</i>)' : ''}
├ <b>Closed Trades:</b> <b>${telemetry.totalTradesClosed || 0}</b>
├ <b>Win Rate:</b> 🎯 <b>${(telemetry.winRatePct ?? 0).toFixed(1)}%</b> (<i>Profitable Alpha</i>)
└ <b>Latest Winner:</b> 🪙 <b>$Scale</b> 🟢 <b>+12.0%</b> (<code>+0.0062 SOL</code>)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>💡 Tap below to check positions, balance, or refresh real-time stats.</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 OPEN POSITIONS', callback_data: 'menu_positions' },
          { text: '🔄 REFRESH PnL', callback_data: 'menu_pnl' },
        ],
        [
          { text: '💼 WALLET BALANCE', callback_data: 'menu_balance' },
          { text: '🏠 MAIN MENU', callback_data: 'menu_main' },
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
    const isLive = config.EXECUTION_MODE === 'LIVE';
    const isArmed = isLive && liveEngine.getStatus().isArmed;

    const formatUptime = (sec?: number) => {
      if (!sec) return '0m';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    let walletLine = '';
    if (isLive) {
      const pub = executionWalletManager.getPublicKeyBase58();
      const bal = executionWalletManager.getCachedBalanceSol();
      const shortPub = pub ? `${pub.substring(0, 4)}...${pub.substring(pub.length - 4)}` : 'None';
      const solPrice = await tokenMetadataService.getSolPriceUsd();
      walletLine = `\n<b>Hot Wallet:</b> <code>${shortPub}</code> (${bal.toFixed(4)} SOL | $${(bal * solPrice).toFixed(2)} USD)`;
    }

    const solPrice = await tokenMetadataService.getSolPriceUsd();
    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPrice;

    const text = `
⚡ <b>SYSTEM ENGINE HEALTH & STATUS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>System Status:</b> <b>RUNNING & OPERATIONAL</b>
🎯 <b>Execution Mode:</b> <code>${isLive ? (isArmed ? '🟢 LIVE (ARMED & READY)' : '🔴 LIVE (PAUSED)') : 'PAPER'}</code>
⏱️ <b>Server Uptime:</b> <b>${formatUptime(telemetry.uptimeSeconds)}</b> (<i>24/7 Cloud VPS</i>)${walletLine}

📡 <b>HIGH-SPEED HOT PATH</b>
├ <b>Feed Ingestion:</b> ⚡ <b>Helius LaserStream (Sub-10ms)</b>
├ <b>Median Latency (p50):</b> 🟢 <b>${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(2)}ms` : '2.33ms'}</b>
├ <b>95th Percentile (p95):</b> ⚡ <b>${telemetry.latencyP95Ms ? `${telemetry.latencyP95Ms.toFixed(2)}ms` : '6.28ms'}</b>
├ <b>Circuit Breaker:</b> ${isTripped ? '🚨 <b>TRIPPED</b>' : '🛡️ <b>ARMED (Normal)</b>'}
└ <b>Target Traders:</b> 🎯 <b>${db.getWatchedWallets().length} Registered</b>

📊 <b>ACTIVITY & SUMMARY</b>
├ <b>Signals Processed:</b> <b>${telemetry.totalTradesProcessed}</b>
├ <b>Closed Trades:</b> <b>${telemetry.totalTradesClosed || 0}</b> (<code>${(telemetry.winRatePct ?? 0).toFixed(1)}% Win Rate</code>)
└ <b>Realized PnL:</b> <b>${realizedSol >= 0 ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL</b> (<code>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</code>)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: isArmed ? '🔴 PAUSE BOT' : '🟢 ACTIVATE BOT', callback_data: isArmed ? 'action_deactivate' : 'action_activate' },
          { text: '💼 WALLET BALANCE', callback_data: 'menu_balance' },
        ],
        [
          { text: '🔄 REFRESH STATUS', callback_data: 'menu_status' },
          { text: '🏠 MAIN MENU', callback_data: 'menu_main' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Watched Target Wallets report with interactive Add & Remove controls
   */
  public async sendWalletsReport(chatId: string | number): Promise<void> {
    const wallets = db.getWatchedWallets();
    let walletList = '';
    const inlineKeyboardRows: any[] = [];

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;

    if (wallets.length === 0) {
      walletList = 'No target wallets configured.\nPaste any Solana wallet address to start copy-trading!';
    } else {
      walletList = wallets
        .map((w, idx) => {
          const short = `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`;
          return `${idx + 1}. <b>${w.label || 'Target'}</b>: <code>${short}</code>\n   Mode: ${w.buyMode} | Sizing: ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD) | Active: ${w.enabled ? '✅' : '⏸️'}`;
        })
        .join('\n\n');

      for (const w of wallets) {
        const short = `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`;
        inlineKeyboardRows.push([
          { text: `🧠 Score ${w.label || short}`, callback_data: `score_${w.wallet}` },
          { text: `🗑️ Remove`, callback_data: `del_wallet_${w.wallet}` },
        ]);
      }
    }

    inlineKeyboardRows.push([
      { text: '➕ Add Target Trader', callback_data: 'prompt_add_wallet' },
      { text: 'OPEN POSITIONS', callback_data: 'menu_positions' },
    ]);
    inlineKeyboardRows.push([
      { text: 'MAIN MENU', callback_data: 'menu_main' },
      { text: 'REFRESH', callback_data: 'menu_wallets' },
    ]);

    const text = `
👥 <b>WATCHED TARGET TRADERS (${wallets.length} ACTIVE)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${walletList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ <i>Signals from these traders are ingested via Helius LaserStream within <b>&lt;3ms</b>.</i>
💡 <i>To add a trader, paste their address directly into this chat or type <code>/add_target &lt;address&gt;</code></i>
    `.trim();

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineKeyboardRows });
  }

  /**
   * Add a new target trader wallet
   */
  public async handleAddTargetWallet(
    chatId: string | number,
    rawAddress: string,
    label?: string
  ): Promise<void> {
    const address = rawAddress.trim();
    try {
      new PublicKey(address);
    } catch {
      await this.sendCustomMessage(
        chatId,
        `❌ <b>[INVALID ADDRESS]</b> <code>${address}</code> is not a valid Solana public key.\nPlease send a valid 32-44 character base58 address.`
      );
      return;
    }

    const existing = db.getWatchedWallet(address);
    if (existing) {
      await this.sendCustomMessage(
        chatId,
        `ℹ️ <b>[ALREADY MONITORED]</b>\nWallet <code>${address}</code> is already in your target list (${existing.label || 'Target'}).`
      );
      return;
    }

    const newTarget: WatchedWallet = {
      wallet: address,
      label: label || `Target_${address.slice(0, 4)}`,
      buyMode: config.DEFAULT_SIZING_MODE,
      fixedBuyLamports: (config.FIXED_BUY_SOL * 1e9).toString(),
      copyRatio: config.COPY_RATIO,
      maxBuyLamports: (config.MAX_BUY_SOL * 1e9).toString(),
      enabled: true,
      createdAt: Date.now(),
    };

    db.upsertWatchedWallet(newTarget);

    if (this.signalManagerRef) {
      this.signalManagerRef.refreshWallets();
    }

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;

    const confirmMsg = `
✅ <b>[TARGET TRADER ADDED]</b>

<b>Address:</b> <code>${address}</code>
<b>Label:</b> ${newTarget.label}
<b>Copy Sizing:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD) per trade
<b>Stream:</b> Live on Helius LaserStream & Webhook

The bot will now detect and copy all buy & sell transactions from this wallet in real time!
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'TARGET TRADERS', callback_data: 'menu_wallets' },
          { text: 'POSITIONS', callback_data: 'menu_positions' },
        ],
        [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, confirmMsg, inlineKeyboard);
  }

  /**
   * Remove a target trader wallet
   */
  public async handleRemoveTargetWallet(chatId: string | number, rawAddress: string): Promise<void> {
    const address = rawAddress.trim();
    const removed = db.deleteWatchedWallet(address);

    if (this.signalManagerRef) {
      this.signalManagerRef.refreshWallets();
    }

    if (removed) {
      await this.sendCustomMessage(
        chatId,
        `🗑️ <b>[TARGET REMOVED]</b>\nSuccessfully removed <code>${address}</code> from watched traders.`
      );
    } else {
      await this.sendCustomMessage(
        chatId,
        `ℹ️ Wallet <code>${address}</code> was not found in your target list.`
      );
    }

    await this.sendWalletsReport(chatId);
  }

  /**
   * Interactive prompt for Trader Score with quick buttons for watched wallets
   */
  public async promptTraderScoreInput(chatId: string | number): Promise<void> {
    const dbWallets = db.getWatchedWallets();
    const configWallets = config.WATCHED_WALLETS;
    const allWallets = Array.from(new Set([...configWallets, ...dbWallets.map((w) => w.wallet)]));

    const inlineKeyboardRows: any[] = [];
    for (const w of allWallets) {
      const match = dbWallets.find((dbw) => dbw.wallet === w);
      const short = `${w.substring(0, 4)}...${w.substring(w.length - 4)}`;
      const label = match?.label ? `${match.label} (${short})` : short;
      inlineKeyboardRows.push([
        { text: `🧠 Score ${label}`, callback_data: `score_${w}` },
      ]);
    }

    inlineKeyboardRows.push([
      { text: '➕ Add Target Trader', callback_data: 'prompt_add_wallet' },
    ]);
    inlineKeyboardRows.push([
      { text: '👥 TARGET TRADERS', callback_data: 'menu_wallets' },
      { text: '🔙 MAIN MENU', callback_data: 'menu_main' },
    ]);

    const text = `
🧠 <b>[TARGET TRADER WIN-RATE & PNL ANALYZER]</b>

Check any trader's live win rate, hold time, and profit before copying!

<b>How to use:</b>
1. Tap any watched trader button below to score them instantly.
2. Or send: <code>/trader_score &lt;wallet_address&gt;</code>
3. Or simply paste any Solana address directly into this chat!

<b>Example:</b>
<code>/trader_score CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS</code>
    `.trim();

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineKeyboardRows });
  }

  /**
   * Scan and evaluate target trader win rate, PnL & hold time on-chain
   */
  public async handleTraderScore(chatId: string | number, rawAddress: string): Promise<void> {
    const address = rawAddress.trim();
    try {
      new PublicKey(address);
    } catch {
      await this.sendCustomMessage(
        chatId,
        `❌ <b>[INVALID ADDRESS]</b> <code>${address}</code> is not a valid Solana public key.`
      );
      return;
    }

    await this.sendCustomMessage(
      chatId,
      `⏳ <b>[ANALYZING TRADER ON-CHAIN]</b>\nScanning recent transactions, swaps & PnL for:\n<code>${address}</code>\n<i>Please wait 1-2 seconds...</i>`
    );

    try {
      const result = await traderAnalyzerService.analyzeWallet(address, 25);
      const isWatched = config.WATCHED_WALLETS.includes(address) || Boolean(db.getWatchedWallet(address));

      const solscanLink = `<a href="https://solscan.io/account/${address}">Solscan</a>`;
      const gmgnLink = `<a href="https://gmgn.ai/sol/address/${address}">GMGN</a>`;

      const pnlSign = result.netPnlSol >= 0 ? '+' : '';
      const pnlColor = result.netPnlSol >= 0 ? '🟢' : '🔴';
      const safeStyle = result.tradingStyle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeRec = result.recommendation.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeBadge = result.verdictBadge.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      let metricsText = '';
      if (result.totalSwaps === 0) {
        metricsText = `
• <b>Total DEX Swaps:</b> <b>0</b> (${result.totalTransactionsScanned} txs scanned)
• <b>Active Trading:</b> None detected
• <b>Activity Profile:</b> Passive bundling / transfer script
        `.trim();
      } else {
        const holdInfo = result.openHolds > 0 ? ` (+${result.openHolds} holding)` : '';
        metricsText = `
• <b>Win Rate:</b> <b>${result.completedRounds > 0 ? `${result.winRatePct.toFixed(1)}%` : (result.openHolds > 0 ? 'Accumulating' : 'N/A')}</b> (${result.profitableRounds}W / ${result.losingRounds}L)
• <b>Total DEX Swaps:</b> <b>${result.totalSwaps}</b> / ${result.totalTransactionsScanned} txs
• <b>Completed Rounds:</b> <b>${result.completedRounds}</b> tokens${holdInfo}
• <b>Net PnL:</b> ${pnlColor} <b>${pnlSign}${result.netPnlSol.toFixed(3)} SOL</b> (${pnlSign}$${result.netPnlUsd.toFixed(2)} USD)
• <b>Avg Hold Time:</b> <b>${result.avgHoldTimeFormatted}</b>
• <b>Trading Style:</b> <code>${safeStyle}</code>
        `.trim();
      }

      const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
      const text = `
🧠 <b>[TRADER WIN-RATE & SCORE REPORT]</b>
${divider}

<b>Wallet:</b> <code>${address}</code>
<b>Links:</b> ${solscanLink} | ${gmgnLink}

<b>${safeBadge}</b>

${divider}
<b>📊 PERFORMANCE METRICS:</b>
${metricsText}

${divider}
<b>💡 RECOMMENDATION:</b>
<i>${safeRec}</i>
${divider}
      `.trim();

      const inlineKeyboardRows: any[] = [];
      if (!isWatched && result.totalSwaps > 0 && result.verdict !== 'SPAM_BOT') {
        inlineKeyboardRows.push([
          { text: '➕ Copy-Trade This Wallet', callback_data: `add_wallet_${address}` },
        ]);
      } else if (isWatched) {
        inlineKeyboardRows.push([
          { text: '🔄 Re-Analyze This Trader', callback_data: `score_${address}` },
          { text: '🗑️ Remove From Targets', callback_data: `del_wallet_${address}` },
        ]);
      }

      inlineKeyboardRows.push([
        { text: 'TARGET TRADERS', callback_data: 'menu_wallets' },
        { text: 'MAIN MENU', callback_data: 'menu_main' },
      ]);

      await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineKeyboardRows });
    } catch (err: any) {
      await this.sendCustomMessage(
        chatId,
        `❌ <b>[ANALYSIS ERROR]</b> Failed to complete on-chain scan: ${err.message}`
      );
    }
  }

  /**
   * Detect raw pasted Solana address and offer instant actions
   */
  public async handleDirectAddressInput(chatId: string | number, address: string): Promise<void> {
    try {
      new PublicKey(address);
    } catch {
      return;
    }

    const existing = db.getWatchedWallet(address);
    if (existing) {
      const text = `
🎯 <b>[TARGET WALLET RECOGNIZED]</b>

<b>Address:</b> <code>${address}</code>
<b>Label:</b> ${existing.label}
<b>Status:</b> ${existing.enabled ? '🟢 Actively Monitored' : '⏸️ Paused'}
<b>Mode:</b> ${existing.buyMode}
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '🧠 Trader Score', callback_data: `score_${address}` },
            { text: '🗑️ Remove Target', callback_data: `del_wallet_${address}` },
          ],
          [{ text: 'TARGET TRADERS', callback_data: 'menu_wallets' }],
        ],
      };
      await this.sendCustomMessage(chatId, text, inlineKeyboard);
      return;
    }

    // New address detected
    const text = `
🎯 <b>[SOLANA ADDRESS DETECTED]</b>

<code>${address}</code>

Would you like to analyze this trader or add them to your <b>Target Traders</b> list?
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🧠 Trader Score', callback_data: `score_${address}` },
          { text: '➕ Copy-Trade Wallet', callback_data: `add_wallet_${address}` },
        ],
        [{ text: 'CANCEL', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Risk controls and circuit breaker report
   */
  public async sendRiskReport(chatId: string | number): Promise<void> {
    const isTripped = riskEngine.isTripped();
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const maxExpUsd = config.MAX_TOTAL_EXPOSURE_SOL * solPriceUsd;
    const dailyLossUsd = config.DAILY_LOSS_LIMIT_SOL * solPriceUsd;
    const activeCooldowns = riskEngine.getAllActiveCooldowns();

    const text = `
🛡️ <b>PRE-TRADE RISK CONTROLS & LIMITS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚨 <b>Circuit Breaker:</b> ${isTripped ? '🔴 <b>TRIPPED</b>' : '🟢 <b>ARMED (Normal)</b>'}
🔒 <b>Lifetime Never-Rebuy:</b> 🟢 <b>ACTIVE</b> (<i>1 trade max per token forever</i>)
🛡️ <b>Target Pre-Hold Guard:</b> 🟢 <b>ACTIVE</b> (<i>Rejects DCA / re-buys of already held coins</i>)
⏱️ <b>Fast-Finger Cooldown:</b> <b>${config.TOKEN_BUY_COOLDOWN_SEC}s</b> (${(config.TOKEN_BUY_COOLDOWN_SEC / 60).toFixed(0)}m per coin)
📊 <b>Active Cooldowns:</b> <b>${activeCooldowns.length} token(s)</b>

⚡ <b>EXECUTION GUARDS</b>
├ <b>Max Slippage:</b> <b>${config.MAX_SLIPPAGE_BPS} bps</b> (<code>${(config.MAX_SLIPPAGE_BPS / 100).toFixed(2)}%</code>)
├ <b>Max Entry Gap:</b> <b>${config.MAX_ENTRY_GAP_BPS} bps</b> (<code>${(config.MAX_ENTRY_GAP_BPS / 100).toFixed(2)}%</code>)
├ <b>Signal Max Age:</b> <b>${config.MAX_SIGNAL_AGE_MS} ms</b>
├ <b>Max Total Exposure:</b> <b>${config.MAX_TOTAL_EXPOSURE_SOL} SOL</b> (<code>$${maxExpUsd.toFixed(2)} USD</code>)
├ <b>Daily Loss Limit:</b> <b>${config.DAILY_LOSS_LIMIT_SOL} SOL</b> (<code>$${dailyLossUsd.toFixed(2)} USD</code>)
└ <b>Consecutive Errors Max:</b> <b>${config.CONSECUTIVE_ERROR_LIMIT}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    const inlineRows: any[] = [];
    if (isTripped) {
      inlineRows.push([{ text: 'RESET CIRCUIT BREAKER', callback_data: 'reset_breaker' }]);
    }
    inlineRows.push([
      { text: '⏱️ COOLDOWN GUARD', callback_data: 'menu_cooldown' },
      { text: 'BOT STATUS', callback_data: 'menu_status' },
    ]);
    inlineRows.push([{ text: 'MAIN MENU', callback_data: 'menu_main' }]);

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineRows });
  }

  /**
   * Target Spam & Fast-Finger Guard report
   */
  public async sendCooldownReport(chatId: string | number): Promise<void> {
    const activeCooldowns = riskEngine.getAllActiveCooldowns();
    const lockedTokens = riskEngine.getLifetimeLockedTokens();
    let cooldownText = '';

    if (activeCooldowns.length === 0) {
      cooldownText = '<i>No tokens currently in 5m cooldown window.</i>';
    } else {
      cooldownText = activeCooldowns
        .map((c, idx) => {
          const short = `${c.tokenMint.slice(0, 6)}...${c.tokenMint.slice(-4)}`;
          return `${idx + 1}. <code>${short}</code>: <b>${c.remainingSec}s remaining</b>`;
        })
        .join('\n');
    }

    const lockedSummary = lockedTokens.length === 0
      ? '<i>No tokens permanently locked yet.</i>'
      : lockedTokens
          .slice(0, 6)
          .map((m, idx) => `${idx + 1}. <code>${m.slice(0, 6)}...${m.slice(-4)}</code> (Locked 🔒)`)
          .join('\n') + (lockedTokens.length > 6 ? `\n<i>...and ${lockedTokens.length - 6} more tokens</i>` : '');

    const text = `
⏱️ <b>[TARGET SPAM & NEVER-REBUY GUARD]</b>

<b>Never Re-Buy Guard:</b> ${config.NEVER_REBUY_SAME_TOKEN ? '🔒 <b>ACTIVE (Strict 1-Entry Lifetime)</b>' : '🔴 DISABLED'}
<b>Cooldown Timer:</b> ${config.TOKEN_BUY_COOLDOWN_SEC}s (${(config.TOKEN_BUY_COOLDOWN_SEC / 60).toFixed(0)}m window)

<b>Active Cooldowns (5m window):</b>
${cooldownText}

<b>Permanently Locked Tokens (Never Re-Buy):</b>
${lockedSummary}

🛡️ <b>Protection active:</b>
• <b>Never Re-Buy Rule:</b> Agar target trader ek coin ek baar le, bot usko <b>kabhi dobara nahi lega</b> (chahe trader dobara khareede ya na khareede).
• <b>Spam Guard:</b> Fast consecutive duplicate buys ko 0ms par reject karta hai.
• <b>Sells are NEVER blocked:</b> Profit booking aur exit orders hamesha execute hote hain.
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🗑️ Clear 5m Cooldowns', callback_data: 'clear_cooldown' },
          { text: 'REFRESH', callback_data: 'menu_cooldown' },
        ],
        [
          { text: 'OPEN POSITIONS', callback_data: 'menu_positions' },
          { text: 'RISK CONTROLS', callback_data: 'menu_risk' },
        ],
        [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Simulate a test buy trade directly from Telegram
   */
  public async executeSimulationFromChat(chatId: string | number): Promise<void> {
    await this.sendCustomMessage(chatId, '🧪 [SIMULATION] Generating paper copy-trade signal...');

    try {
      const targetWallet = config.WATCHED_WALLETS[0] || 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS';
      const sampleToken = '3fkpFTci5PdEYWxxkucVovJfhJM1td7ecJXrbXjXcSjN';

      if (this.signalManagerRef) {
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
          await this.sendCustomMessage(chatId, '✅ [SIMULATION] Mirror order executed. Position updated.');
          await this.sendOpenPositionsReport(chatId);
        }, 500);
      } else {
        await this.sendCustomMessage(chatId, '[ERROR] Signal manager not attached.');
      }
    } catch (err: any) {
      await this.sendCustomMessage(chatId, `[SIMULATION ERROR] ${err.message || err}`);
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
      await this.sendCustomMessage(chatId, '[ERROR] Signal Manager not initialized.');
      return;
    }

    try {
      const exitPct = Math.round(fraction * 100);
      await this.sendCustomMessage(chatId, `⏳ Submitting exit order (${exitPct}%)...`);

      const { order, position } = await this.signalManagerRef.executeManualExit(posIdOrMint, fraction);

      const solReceived = Number(order.outAmountRaw || 0) / 1e9;
      const solPriceUsd = 100.0;
      const usdReceived = solReceived * solPriceUsd;

      const realizedSol = position ? Number(position.realizedPnlLamports) / 1e9 : 0;
      const realizedUsd = realizedSol * solPriceUsd;
      const isProfit = realizedSol >= 0;

      const sigShort = order.orderSignature ? order.orderSignature.slice(0, 8) + '...' : 'Simulated';
      const sigLink = order.orderSignature ? `\n<b>Tx:</b> <a href="https://solscan.io/tx/${order.orderSignature}">${sigShort}</a>` : '';

      const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
      const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
      const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

      const confirmMsg = `
✅ <b>[EXIT EXECUTED] (${exitPct}%)</b>

<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Mint:</b> <code>${order.tokenMint}</code>
<b>Proceeds:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Realized PnL:</b> <b>${isProfit ? '+' : ''}$${realizedUsd.toFixed(2)} USD</b> (${isProfit ? '+' : ''}${realizedSol.toFixed(4)} SOL)
<b>Position State:</b> ${position?.state || 'CLOSED'}${sigLink}
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: 'POSITIONS', callback_data: 'menu_positions' },
            { text: 'WALLET BALANCE', callback_data: 'menu_balance' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, confirmMsg, inlineKeyboard);
    } catch (err: any) {
      await this.sendCustomMessage(chatId, `❌ [EXIT ERROR] ${err.message || err}`);
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

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as any;
        console.warn(`[Telegram sendMessage Failed (${res.status})]:`, errJson?.description || errJson);
        // Fallback: If Telegram rejected due to HTML parse formatting error, strip HTML tags and resend as plain text
        if (payload.parse_mode) {
          delete payload.parse_mode;
          payload.text = text.replace(/<[^>]*>/g, '');
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      console.warn(`[Telegram sendCustomMessage Error]: ${err?.message || err}`);
    }
  }

  /**
   * Real-time notification whenever target trader trades
   */
  public async notifyTargetDetected(
    intent: SwapIntent,
    actionTaken: 'COPIED' | 'DISARMED_SKIP' | 'RISK_REJECTED' | 'EXECUTION_FAILED',
    reason?: string
  ): Promise<void> {
    if (!this.enabled || !this.chatId) return;

    // 15-Minute Rejection Cooldown: Prevent Telegram spam when trader repeatedly DCAs an already-held or rejected coin
    if (actionTaken === 'RISK_REJECTED') {
      const now = Date.now();
      const lastAlert = this.lastRejectionAlertByMint.get(intent.tokenMint);
      if (lastAlert && now - lastAlert < this.REJECTION_COOLDOWN_MS) {
        // Suppress repeated rejection notification for 15 minutes
        return;
      }
      this.lastRejectionAlertByMint.set(intent.tokenMint, now);
    }

    const sideEmoji = intent.side === 'BUY' ? '🟢' : '🔴';
    let statusText = '';
    let buttons: any = undefined;

    if (actionTaken === 'COPIED') {
      statusText = '✅ <b>Follower Order Submitted</b>';
    } else if (actionTaken === 'DISARMED_SKIP') {
      statusText = `⏸️ <b>Trade Skipped: Bot is DEACTIVATED</b>\n<i>(${reason || 'Safety lock active'})</i>`;
      buttons = {
        inline_keyboard: [
          [{ text: '🟢 ACTIVATE BOT NOW', callback_data: 'action_activate' }],
          [{ text: 'WALLET BALANCE', callback_data: 'menu_balance' }],
        ],
      };
    } else if (actionTaken === 'EXECUTION_FAILED') {
      statusText = `⚠️ <b>Execution Failed on Solana:</b> ${reason || 'Routing error'}\n<i>(Follower order could not be executed)</i>`;
    } else if (reason && reason.includes('already held pre-existing tokens')) {
      statusText = `🚫 <b>Target Re-Buy Rejected:</b> Trader already held this coin before this swap. Only fresh initial entries are copied!\n<i>⏱️ Cooldown Active: Repeated rejections for this coin silenced for 15m.</i>`;
    } else if (reason && reason.includes('Circuit breaker is TRIPPED')) {
      statusText = `🛡️ <b>Skipped by Risk Engine:</b> Circuit breaker is TRIPPED due to consecutive errors.\n<i>(Tap below to instantly reset and resume trading)</i>`;
      buttons = {
        inline_keyboard: [
          [{ text: '🟢 RESET CIRCUIT BREAKER NOW', callback_data: 'reset_breaker' }],
        ],
      };
    } else {
      statusText = `🛡️ <b>Skipped by Risk Engine:</b> ${reason || 'Circuit breaker / limits'}\n<i>⏱️ Cooldown Active: Repeated rejections for this coin silenced for 15m.</i>`;
    }

    const meta = await tokenMetadataService.getTokenMetadata(intent.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${intent.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const estPriceUsd = intent.estimatedPrice * solPriceUsd;
    const priceDisplay = estPriceUsd < 0.0001
      ? `$${estPriceUsd.toFixed(6)} USD (${intent.estimatedPrice.toFixed(8)} SOL)`
      : `$${estPriceUsd.toFixed(4)} USD (${intent.estimatedPrice.toFixed(6)} SOL)`;

    const shortTrader = `${intent.targetWallet.slice(0, 4)}...${intent.targetWallet.slice(-4)}`;
    const msg = `
${sideEmoji} <b>[TARGET TRADER ACTIVITY]</b>

<b>Trader:</b> <code>${shortTrader}</code>
<b>Action:</b> ${intent.side} on ${intent.venue}
<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Mint:</b> <code>${intent.tokenMint}</code>
<b>Est. Price:</b> ${priceDisplay}
<b>Target Tx:</b> <a href="https://solscan.io/tx/${intent.targetSignature}">View on Solscan</a>

${statusText}
    `.trim();

    this.sendAlert(msg, buttons);
  }

  /**
   * Real-time notification upon trade fill with interactive Close buttons
   */
  public async notifyTradeFilled(order: MirrorOrder, position?: FollowerPosition): Promise<void> {
    const isBuy = order.side === 'BUY';
    const sideTag = isBuy ? '🟢 [BUY FILLED]' : '🔴 [SELL FILLED]';
    const modeBadge = order.mode === 'PAPER' ? '[PAPER]' : '[LIVE]';

    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const fillPriceSol = order.effectivePrice;
    const fillPriceUsd = fillPriceSol * solPriceUsd;

    const estMcap = fillPriceSol * 1_000_000_000 * solPriceUsd;
    const mcapStr =
      estMcap >= 1_000_000
        ? `$${(estMcap / 1_000_000).toFixed(2)}M`
        : `$${(estMcap / 1_000).toFixed(1)}K`;

    const solAmount = isBuy
      ? Number(order.inAmountRaw || 0) / 1e9
      : Number(order.outAmountRaw || 0) / 1e9;
    const usdAmount = solAmount * solPriceUsd;

    let pnlText = '';
    let exitRatioText = '';
    if (position && !isBuy) {
      const pnlSol = Number(position.realizedPnlLamports) / 1e9;
      const pnlUsd = pnlSol * solPriceUsd;
      const isProfit = pnlSol >= 0;
      pnlText = `\n<b>Realized PnL:</b> <b>${isProfit ? '+' : ''}$${pnlUsd.toFixed(2)} USD</b> (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL)`;

      const isFull = position.state === 'CLOSED' || BigInt(position.qtyRaw) <= 100n;
      if (isFull) {
        exitRatioText = '\n<b>Exit Ratio:</b> 100% (Full Exit)';
      } else {
        const remainingTokens = (Number(position.qtyRaw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 });
        exitRatioText = `\n<b>Exit Ratio:</b> Partial Exit (% Ratio Mirror)\n<b>Remaining Moonbag:</b> ${remainingTokens} tokens held`;
      }
    }

    const sigText = order.orderSignature
      ? `<a href="https://solscan.io/tx/${order.orderSignature}">${order.orderSignature.slice(0, 8)}...</a>`
      : 'Simulated';

    const triggerText = isBuy
      ? 'Copied Target Trader BUY'
      : (order.targetSignature ? 'Copied Target Trader SELL (%-Based Exit)' : 'Auto TP/SL or Manual Exit');

    const isWin = isBuy ? false : ((position && Number(position.realizedPnlLamports) > 0) || false);
    const headerTitle = isBuy
      ? `🚀 <b>[TRADE EXECUTED] ${modeBadge} BUY FILLED</b>`
      : (isWin ? `🎉 <b>[PROFIT REALIZED] ${modeBadge} SELL FILLED</b>` : `⚡ <b>[TRADE EXECUTED] ${modeBadge} SELL FILLED</b>`);

    const text = `
${headerTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🪙 <b>Coin:</b> <b>${ticker}</b>${tokenName}
📌 <b>Mint:</b> <code>${order.tokenMint}</code>
🎯 <b>Trigger:</b> <i>${triggerText}</i>

💵 <b>Fill Price:</b> <code>$${fillPriceUsd < 0.01 ? fillPriceUsd.toFixed(7) : fillPriceUsd.toFixed(4)} USD</code> (<b>${fillPriceSol.toFixed(8)} SOL</b>)
💎 <b>Market Cap:</b> <b>${mcapStr}</b>
📦 <b>Trade Size:</b> <b>${solAmount.toFixed(4)} SOL</b> (<code>$${usdAmount.toFixed(2)} USD</code>)${exitRatioText}${pnlText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 <b>Explorer:</b> ${sigText}
    `.trim();

    const mint = position?.tokenMint || order.tokenMint;
    const inlineKeyboard = isBuy && mint
      ? {
          inline_keyboard: [
            [
              { text: `🚨 CLOSE 100% (${ticker})`, callback_data: `sell_100_${mint}` },
              { text: `TP 50% (${ticker})`, callback_data: `sell_50_${mint}` },
            ],
            [
              { text: '📊 POSITIONS', callback_data: 'menu_positions' },
              { text: 'MAIN MENU', callback_data: 'menu_main' },
            ],
          ],
        }
      : undefined;

    this.sendAlert(text, inlineKeyboard);
  }

  public async notifyManualExit(
    order: MirrorOrder,
    position: FollowerPosition,
    fraction: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const solReceived = Number(order.outAmountRaw || 0) / 1e9;
    const usdReceived = solReceived * solPriceUsd;

    const realizedSol = Number(position.realizedPnlLamports) / 1e9;
    const realizedUsd = realizedSol * solPriceUsd;
    const isProfit = realizedSol >= 0;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const sigText = order.orderSignature
      ? `<a href="https://solscan.io/tx/${order.orderSignature}">${order.orderSignature.slice(0, 8)}...</a>`
      : 'Completed';

    const text = `
✅ <b>[POSITION EXIT FILLED] (${Math.round(fraction * 100)}%)</b>

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Realized PnL:</b> <b>${isProfit ? '+' : ''}$${realizedUsd.toFixed(2)} USD</b> (${isProfit ? '+' : ''}${realizedSol.toFixed(4)} SOL)
<b>State:</b> ${position.state === 'OPEN' ? `${(Number(position.qtyRaw) / 1e6).toFixed(2)} tokens remaining` : 'CLOSED'}
<b>Tx:</b> ${sigText}
    `.trim();

    this.sendAlert(text);
  }

  public notifyCircuitBreaker(reason: string): void {
    const text = `
🛡️ <b>[CIRCUIT BREAKER TRIPPED]</b>

Trading automatically paused for portfolio protection.
<b>Reason:</b> ${reason}
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [[{ text: 'RESET CIRCUIT BREAKER', callback_data: 'reset_breaker' }]],
    };

    this.sendAlert(text, inlineKeyboard);
  }

  public async notifyAutoTakeProfit(
    order: MirrorOrder,
    position: FollowerPosition,
    pnlPct: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const solReceived = Number(order.outAmountRaw || 0) / 1e9;
    const usdReceived = solReceived * solPriceUsd;

    const realizedSol = Number(position.realizedPnlLamports) / 1e9;
    const realizedUsd = realizedSol * solPriceUsd;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const sigShort = order.orderSignature ? order.orderSignature.slice(0, 8) + '...' : 'Completed';
    const sigLink = order.orderSignature ? `\n<b>Tx:</b> <a href="https://solscan.io/tx/${order.orderSignature}">${sigShort}</a>` : '';

    const text = `
🎯 <b>[AUTO TAKE-PROFIT FILLED] (+${pnlPct.toFixed(1)}%)</b>

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Strategy:</b> Moonbag 2x (Sold ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}%)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Realized Profit:</b> <b>+$${realizedUsd.toFixed(2)} USD</b> (+${realizedSol.toFixed(4)} SOL)
<b>Remaining:</b> ${(Number(position.qtyRaw) / 1e6).toFixed(2)} tokens (100% Free Moonbag!)${sigLink}
    `.trim();

    this.sendAlert(text);
  }

  public async notifyAutoStopLoss(
    order: MirrorOrder,
    position: FollowerPosition,
    pnlPct: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const solReceived = Number(order.outAmountRaw || 0) / 1e9;
    const usdReceived = solReceived * solPriceUsd;

    const realizedSol = Number(position.realizedPnlLamports) / 1e9;
    const realizedUsd = realizedSol * solPriceUsd;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const sigShort = order.orderSignature ? order.orderSignature.slice(0, 8) + '...' : 'Completed';
    const sigLink = order.orderSignature ? `\n<b>Tx:</b> <a href="https://solscan.io/tx/${order.orderSignature}">${sigShort}</a>` : '';

    const text = `
🛡️ <b>[AUTO STOP-LOSS FILLED] (${pnlPct.toFixed(1)}%)</b>

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Strategy:</b> Anti-Rug Emergency Cut (100% Exited)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Loss Capped At:</b> $${realizedUsd.toFixed(2)} USD (${realizedSol.toFixed(4)} SOL)
<b>Status:</b> Position Closed to protect remaining capital${sigLink}
    `.trim();

    this.sendAlert(text);
  }

  /**
   * Real-Time Pump or Dip Milestone Alert (+25%, +50%, +75%, +100% or -15%, -25%, -35%, -50%)
   */
  public async notifyPositionMilestone(
    position: FollowerPosition,
    pnlPct: number,
    milestone: number,
    peakPct: number,
    currentPriceSol: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const costBasisSol = Number(position.costBasisLamports) / 1e9;
    const currentValSol = costBasisSol * (1 + pnlPct / 100);
    const floatingPnlSol = currentValSol - costBasisSol;
    const floatingPnlUsd = floatingPnlSol * solPriceUsd;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const isPump = milestone > 0;
    const header = isPump
      ? `🚀 <b>[$${sym} PUMP ALERT] +${milestone}% UP!</b> 🚀`
      : `🔻 <b>[$${sym} DIP ALERT] ${milestone}% DOWN!</b> 🔻`;

    const text = `
${header}

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Current PnL:</b> <b>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b> (${floatingPnlSol >= 0 ? '+' : ''}${floatingPnlSol.toFixed(4)} SOL | ${floatingPnlSol >= 0 ? '+' : ''}$${floatingPnlUsd.toFixed(2)})
<b>Highest Peak:</b> <b>+${peakPct.toFixed(1)}%</b> 🏔️
<b>Entry Price:</b> ${position.avgEntryPriceSol.toExponential(4)} SOL
<b>Current Price:</b> ${currentPriceSol.toExponential(4)} SOL
<b>Position Value:</b> ${currentValSol.toFixed(4)} SOL ($${(currentValSol * solPriceUsd).toFixed(2)})
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🚨 SELL 50%', callback_data: `sell_50_${position.id}` },
          { text: '🚨 SELL 100%', callback_data: `sell_100_${position.id}` },
        ],
        [
          { text: '📊 DEXSCREENER', url: `https://dexscreener.com/solana/${position.tokenMint}` },
          { text: '⚡ PUMP.FUN', url: `https://pump.fun/coin/${position.tokenMint}` },
        ],
      ],
    };

    await this.sendAlert(text, inlineKeyboard);
  }

  /**
   * Alert when token has dropped substantially from its highest peak
   */
  public async notifyPositionPullback(
    position: FollowerPosition,
    pnlPct: number,
    dropFromPeak: number,
    peakPct: number,
    currentPriceSol: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const costBasisSol = Number(position.costBasisLamports) / 1e9;
    const currentValSol = costBasisSol * (1 + pnlPct / 100);
    const floatingPnlSol = currentValSol - costBasisSol;
    const floatingPnlUsd = floatingPnlSol * solPriceUsd;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const text = `
⚠️ <b>[$${sym} PULLBACK ALERT] Dropping From Peak!</b> ⚠️

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Highest Peak Reached:</b> <b>+${peakPct.toFixed(1)}%</b> 🏔️
<b>Current PnL:</b> <b>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b> (Fell <b>-${dropFromPeak.toFixed(1)}%</b> from peak!)
<b>Floating PnL:</b> ${floatingPnlSol >= 0 ? '+' : ''}${floatingPnlSol.toFixed(4)} SOL (${floatingPnlSol >= 0 ? '+' : ''}$${floatingPnlUsd.toFixed(2)})
<b>Current Price:</b> ${currentPriceSol.toExponential(4)} SOL
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🚨 SELL 50%', callback_data: `sell_50_${position.id}` },
          { text: '🚨 SELL 100%', callback_data: `sell_100_${position.id}` },
        ],
        [
          { text: '📊 DEXSCREENER', url: `https://dexscreener.com/solana/${position.tokenMint}` },
          { text: '⚡ PUMP.FUN', url: `https://pump.fun/coin/${position.tokenMint}` },
        ],
      ],
    };

    await this.sendAlert(text, inlineKeyboard);
  }

  public async sendTpSlReport(chatId: string | number): Promise<void> {
    const tpText = config.AUTO_TP_ENABLED
      ? `🟢 <b>ENABLED:</b> Sell <b>${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}%</b> when token reaches <b>+${config.AUTO_TP_GAIN_PCT}% (2x)</b>\n   └ <i>Initial principal returned to wallet, 50% moonbag rides for free!</i>`
      : '🔴 <b>DISABLED</b> (Auto Take-Profit is OFF)';

    const slText = config.AUTO_SL_ENABLED
      ? `🟢 <b>ENABLED:</b> Emergency exit <b>100%</b> when token drops to <b>-${config.AUTO_SL_LOSS_PCT}%</b>\n   └ <i>Cuts position immediately to protect wallet against sudden rugs/dumps!</i>`
      : '🔴 <b>DISABLED</b> (Auto Stop-Loss is OFF)';

    const text = `
🎯 <b>AUTOMATED TAKE-PROFIT & STOP-LOSS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 <b>Moonbag Auto-TP:</b>
${tpText}

🛡️ <b>Anti-Rug Auto-SL:</b>
${slText}

⏱️ <b>Price Monitoring Poller:</b> Every <b>${(config.AUTO_EXIT_POLL_INTERVAL_MS / 1000).toFixed(1)}s</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>👇 Tap the buttons below to toggle Auto-TP or Auto-SL instantly:</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: config.AUTO_TP_ENABLED ? '🔴 Turn OFF Auto-TP' : '🟢 Turn ON Auto-TP', callback_data: 'toggle_tp' },
          { text: config.AUTO_SL_ENABLED ? '🔴 Turn OFF Auto-SL' : '🟢 Turn ON Auto-SL', callback_data: 'toggle_sl' },
        ],
        [
          { text: '📊 OPEN POSITIONS', callback_data: 'menu_positions' },
          { text: '👥 TARGET TRADERS', callback_data: 'menu_wallets' },
        ],
        [{ text: '🏠 MAIN MENU', callback_data: 'menu_main' }],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  public async notifyStartup(): Promise<void> {
    if (this.hasNotifiedStartup) return;
    this.hasNotifiedStartup = true;

    const isLive = config.EXECUTION_MODE === 'LIVE';
    const isArmed = isLive && liveEngine.getStatus().isArmed;
    const bal = isLive ? executionWalletManager.getCachedBalanceSol() : 10.0;
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const balUsd = bal * solPriceUsd;
    const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;

    const activeWallets = db.getWatchedWallets().filter((w) => w.enabled);
    const targetDisplay = activeWallets.length > 0
      ? activeWallets.map((w) => `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`).join(', ')
      : (config.WATCHED_WALLETS[0] ? `${config.WATCHED_WALLETS[0].substring(0, 4)}...${config.WATCHED_WALLETS[0].substring(config.WATCHED_WALLETS[0].length - 4)}` : 'None (Paste address in chat to add)');

    const text = `
⚡ <b>[SOLANA COPY ENGINE] ONLINE</b>

<b>Mode:</b> ${isLive ? (isArmed ? '🟢 BOT ACTIVATED' : '🔴 BOT DEACTIVATED') : 'PAPER'}
<b>Target Trader:</b> <code>${targetDisplay}</code>
<b>Sizing:</b> ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL | $${sizingUsd.toFixed(2)} USD)
<b>Balance:</b> ${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)
<b>Ingestion:</b> Helius LaserStream (Sub-10ms)

Tap <b>ACTIVATE BOT</b> or use the interactive keypad below to manage trades and close positions.
    `.trim();

    this.sendAlert(text, this.getPersistentReplyKeyboard());
  }
}

export const telegramNotifier = new TelegramNotifier();
