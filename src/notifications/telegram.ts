import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { liveEngine } from '../execution/live-engine.js';
import { traderAnalyzerService } from '../services/trader-analyzer.js';
import { FollowerPosition, MirrorOrder, SwapIntent, WatchedWallet } from '../types/index.js';
import { targetSyncService } from '../services/target-sync.js';
import { mintDecimalsService } from '../services/mint-decimals.js';
import { positionSyncService } from '../services/position-sync.js';
import { traderNamingService } from '../services/trader-naming.js';

function formatVenueName(venue?: string): string {
  if (!venue) return 'Jupiter V2';
  const v = venue.toUpperCase();
  if (v.includes('PUMP')) return 'Pump.fun';
  if (v.includes('RAYDIUM_CPMM') || v.includes('CPMM')) return 'Raydium CPMM';
  if (v.includes('RAYDIUM_CLMM') || v.includes('CLMM')) return 'Raydium CLMM';
  if (v.includes('RAYDIUM')) return 'Raydium AMM';
  if (v.includes('JUPITER')) return 'Jupiter V2';
  if (v.includes('MOONSHOT')) return 'Moonshot';
  return venue;
}

function formatShortAddress(address: string, chars: number = 4): string {
  if (!address || address.length <= chars * 2 + 2) return address || '';
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

function formatGapBps(reason?: string): { isGap: boolean; gapPctText: string; maxPctText: string; cleanReason: string } {
  if (!reason) {
    return { isGap: false, gapPctText: '', maxPctText: '', cleanReason: '' };
  }
  const match = reason.match(/Entry price gap \(\+?([\d.]+) bps(?: vs baseline [^)]+)?\) exceeds tolerance \((\d+) bps\)/i);
  if (match) {
    const gapBps = parseFloat(match[1]);
    const maxBps = parseFloat(match[2]);
    const gapPct = gapBps / 100;
    const maxPct = maxBps / 100;
    return {
      isGap: true,
      gapPctText: `+${gapPct.toFixed(2)}% (${gapBps.toFixed(0)} bps)`,
      maxPctText: `+${maxPct.toFixed(2)}% (${maxBps.toFixed(0)} bps)`,
      cleanReason: 'Price moved too far ahead of target entry',
    };
  }
  return { isGap: false, gapPctText: '', maxPctText: '', cleanReason: reason };
}

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
  private lastTargetAlertByMint: Map<string, number> = new Map();
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
   * Register essential native command menu with Telegram servers
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
            { command: 'menu', description: 'Main Dashboard & Controls' },
            { command: 'positions', description: 'Open Positions & Actions' },
            { command: 'status', description: 'Engine Health, Latency & Feed' },
            { command: 'balance', description: 'Wallet & Spendable SOL' },
            { command: 'arm', description: 'Arm Live Copy Trading' },
            { command: 'pause', description: 'Pause Live Engine' },
            { command: 'help', description: 'Commands & Terminal Shortcuts' },
            { command: 'pair', description: 'Pair Operator Chat ID' },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        console.info('[Telegram Bot] Successfully registered native Telegram command menu.');
      }

      // Configure native Telegram bot menu button
      const menuButtonUrl = `${this.apiRoot}/bot${this.botToken}/setChatMenuButton`;
      await fetch(menuButtonUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: { type: 'commands' },
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
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
    // Load chat IDs authorized via secure pairing persisted in SQLite
    try {
      const persisted = db.getAuthorizedTelegramChats();
      for (const id of persisted) {
        if (id && id.trim()) ids.add(id.trim());
      }
    } catch {}

    if (this.chatId && this.chatId.trim() && ids.has(this.chatId.trim())) {
      ids.add(this.chatId.trim());
    }
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
      let hasError = false;
      try {
        const url = `${this.apiRoot}/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=15`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              this.updateOffset = update.update_id + 1;
              // Asynchronous non-blocking dispatch so long polling immediately accepts the next command
              this.handleUpdate(update).catch((err) => {
                console.warn('[Telegram Update Handler Error]:', err);
              });
            }
          }
        }
      } catch (err: any) {
        hasError = true;
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
          if (hasError) {
            setTimeout(poll, 1000);
          } else {
            // Immediate zero-delay next long-poll loop so commands respond in <100ms
            setImmediate(poll);
          }
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
    return authorized.includes(incomingStr);
  }

  /**
   * Main text message dispatcher
   */
  private async handleTextMessage(msg: any): Promise<void> {
    const rawChatId = msg.chat?.id;
    if (!rawChatId) return;

    const rawText = (msg.text || '').trim();

    // Check for /pair <code> or pair <code> command before authorization check
    const withoutPrefix = rawText.replace(/@\w+/g, '').trim();
    if (withoutPrefix.startsWith('/pair') || withoutPrefix.toLowerCase().startsWith('pair')) {
      const parts = withoutPrefix.split(/\s+/);
      const codeAttempt = parts[1];
      await this.handlePairCommand(rawChatId, codeAttempt);
      return;
    }

    if (!this.isAuthorizedChat(rawChatId)) {
      console.warn(`[Telegram Security] Blocked unauthorized message from chat ID: ${rawChatId}`);
      try {
        const pairingConfigured = Boolean(config.TELEGRAM_PAIRING_CODE && config.TELEGRAM_PAIRING_CODE.trim() !== '');
        const isPaired = db.isTelegramPairingCompleted();
        if (pairingConfigured && !isPaired) {
          await this.sendCustomMessage(
            rawChatId,
            '🔒 <b>[PAIRING REQUIRED]</b> This bot is protected.\nTo authenticate your Telegram account as the authorized operator, send:\n<code>/pair &lt;pairing_code&gt;</code>'
          );
        } else {
          await this.sendCustomMessage(
            rawChatId,
            '⛔ <b>[ACCESS DENIED]</b> Unauthorized chat ID. You do not have permission to control this bot.'
          );
        }
      } catch {}
      return;
    }
    const chatId = String(rawChatId);
    this.chatId = chatId;

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
      clean.includes('guide') ||
      clean === 'keypad' ||
      clean === 'keyboard' ||
      clean === 'restore' ||
      clean.includes('restore') ||
      clean.includes('keypad')
    ) {
      await this.sendMainMenu(chatId, true);
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
      await this.promptCloseAllConfirmation(chatId);
    } else if (clean === 'pnl' || clean.includes('pnl summary') || clean === 'profit' || clean === 'loss') {
      await this.sendPnlSummaryReport(chatId);
    } else if (clean === 'status' || clean.includes('bot status') || clean === 'health' || clean === 'stats') {
      await this.sendStatusReport(chatId);
    } else if (clean.startsWith('label') || clean.startsWith('name ') || clean.startsWith('rename ')) {
      const parts = rawText.trim().split(/\s+/);
      if (parts.length < 3) {
        await this.sendCustomMessage(
          chatId,
          'ℹ️ <b>Trader Nickname Usage:</b>\n<code>/label &lt;trader_number_or_address&gt; &lt;nickname&gt;</code>\n\n<b>Examples:</b>\n• <code>/label 1 Alpha Whale</code>\n• <code>/label 2 Pump Sniper</code>\n• <code>/label CwUH Smart Insider</code>\n\n<i>Type /traders to view all your traders and their numbers!</i>'
        );
        return;
      }
      const target = parts[1];
      const newName = parts.slice(2).join(' ');
      const res = await traderNamingService.setTraderLabel(target, newName);
      await this.sendCustomMessage(chatId, res.message);
      await this.sendWalletsReport(chatId);
    } else if (clean === 'traders' || clean === 'wallets' || clean.includes('watched wallets') || clean === 'targets' || clean.includes('target traders') || clean.includes('target wallets')) {
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
    } else if (clean === 'tpsl' || clean === 'trailing' || clean === 'zeroloss' || clean === 'breakeven' || clean.includes('take profit') || clean.includes('stop loss') || clean === 'protection' || clean.includes('moonbag') || clean.includes('zero loss') || clean.includes('trailing sl')) {
      await this.sendTpSlReport(chatId);
    } else if (clean === 'trailing_off' || clean === 'zeroloss_off' || clean === 'trailingoff' || clean === 'zerolossoff') {
      (config as any).TRAILING_SL_ENABLED = false;
      await this.sendCustomMessage(chatId, '🔴 <b>Breakeven Floor & Trailing Stop-Loss have been TURNED OFF.</b>');
      await this.sendTpSlReport(chatId);
    } else if (clean === 'trailing_on' || clean === 'zeroloss_on' || clean === 'trailingon' || clean === 'zerolosson') {
      (config as any).TRAILING_SL_ENABLED = true;
      await this.sendCustomMessage(chatId, `🛡️ <b>Breakeven Floor & Trailing Stop-Loss have been TURNED ON!</b>\n• +${config.BREAKEVEN_TRIGGER_PCT}% profit par Stop-Loss Entry (+${config.BREAKEVEN_LOCK_PCT}% cushion) par lock ho jayega.\n• +30%+ par Stop-Loss peak se ${config.TRAILING_SL_CUSHION_PCT}% peeche trail karega.`);
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

      if (fraction >= 1.0 && config.EXECUTION_MODE === 'LIVE') {
        await this.promptSell100Confirmation(chatId, mint);
      } else {
        await this.executeManualSellFromChat(chatId, mint, fraction);
      }
    } else {
      await this.sendCustomMessage(
        chatId,
        `[COMMAND NOT RECOGNIZED] "${rawText}"\nUse the interactive keypad below or type /menu. To add a target trader, send <code>/add_target &lt;address&gt;</code> or paste any Solana address!`,
        this.getPersistentReplyKeyboard()
      );
    }
  }

  /**
   * Handle secure operator pairing via /pair <code>
   */
  public async handlePairCommand(chatId: string | number, codeAttempt?: string): Promise<void> {
    const targetChat = String(chatId).trim();

    if (!config.TELEGRAM_PAIRING_CODE || config.TELEGRAM_PAIRING_CODE.trim() === '') {
      await this.sendCustomMessage(
        targetChat,
        '⛔ <b>[PAIRING DISABLED]</b> TELEGRAM_PAIRING_CODE is not configured on the server. Please set it in your .env file or define TELEGRAM_CHAT_ID.'
      );
      return;
    }

    if (db.isTelegramPairingCompleted()) {
      await this.sendCustomMessage(
        targetChat,
        '⚠️ <b>[ALREADY PAIRED]</b> This bot has already been paired to an authorized operator account. Remote re-pairing is blocked.\nTo re-pair, an administrator must reset pairing locally on the host server.'
      );
      return;
    }

    if (!codeAttempt || codeAttempt.trim() === '') {
      await this.sendCustomMessage(
        targetChat,
        '⚠️ <b>[CODE REQUIRED]</b> Please provide your setup pairing code:\n<code>/pair &lt;your_code&gt;</code>'
      );
      return;
    }

    const trimmedAttempt = codeAttempt.trim();
    const expectedCode = config.TELEGRAM_PAIRING_CODE.trim();

    const bufA = Buffer.from(trimmedAttempt);
    const bufB = Buffer.from(expectedCode);
    const isValid = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

    if (!isValid) {
      console.warn(`[Telegram Security] Invalid pairing code attempt from chat ID: ${targetChat}`);
      await this.sendCustomMessage(
        targetChat,
        '⛔ <b>[INVALID PAIRING CODE]</b> Verification failed. Check your TELEGRAM_PAIRING_CODE in .env and try again.'
      );
      return;
    }

    // Persist pairing in SQLite (survives restarts)
    db.addAuthorizedTelegramChat(targetChat);
    db.setTelegramPairingCompleted(true);
    this.chatId = targetChat;

    console.info(`[Telegram Security] Successfully paired operator chat ID: ${targetChat}`);
    await this.sendCustomMessage(
      targetChat,
      '✅ <b>[PAIRING SUCCESSFUL]</b>\nThis Telegram account is now the verified authorized operator for this trading bot!\nAll trade alerts, position notices, and administrative commands are now enabled.\n\nSend /menu to open the control terminal.'
    );
  }

  /**
   * Safe local-only reset for Telegram pairing
   */
  public resetPairing(): void {
    db.resetTelegramPairing();
    this.chatId = config.TELEGRAM_CHAT_ID || '';
    console.info('[Telegram Security] Operator pairing reset locally.');
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

    // Instant ACK to Telegram: stops button spinning in user's UI in <20ms
    fetch(`${this.apiRoot}/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cq.id }),
    }).catch(() => {});

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
      await this.promptCloseAllConfirmation(chatId);
    } else if (data === 'confirm_close_all') {
      await this.executeCloseAllFromChat(chatId);
    } else if (data === 'cancel_action') {
      await this.sendCustomMessage(chatId, '❌ Action cancelled.');
      await this.sendMainMenu(chatId);
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
      const status = config.AUTO_TP_ENABLED ? '🟢 <b>TURNED ON (+100% Take Profit)</b>' : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `🎯 Auto Take-Profit is now ${status}.`);
      await this.sendTpSlReport(chatId);
    } else if (data === 'toggle_sl') {
      (config as any).AUTO_SL_ENABLED = !config.AUTO_SL_ENABLED;
      const status = config.AUTO_SL_ENABLED ? `🟢 <b>TURNED ON (-${config.AUTO_SL_LOSS_PCT}% Stop Loss)</b>` : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `🛡️ Stop-Loss is now ${status}.`);
      await this.sendTpSlReport(chatId);
    } else if (data === 'toggle_trailing') {
      (config as any).TRAILING_SL_ENABLED = !config.TRAILING_SL_ENABLED;
      const status = config.TRAILING_SL_ENABLED
        ? '🛡️ <b>TURNED ON (Breakeven Floor & Trailing Active)</b>'
        : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `Breakeven Floor & Trailing SL is now ${status}.`);
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

      if (pct === 100 && config.EXECUTION_MODE === 'LIVE') {
        await this.promptSell100Confirmation(chatId, posIdOrMint);
      } else {
        await this.executeManualSellFromChat(chatId, posIdOrMint, fraction);
      }
    } else if (data.startsWith('confirm_sell_100_')) {
      const posIdOrMint = data.replace('confirm_sell_100_', '').trim();
      await this.executeManualSellFromChat(chatId, posIdOrMint, 1.0);
    } else if (data.startsWith('toggle_wallet_')) {
      const address = data.replace('toggle_wallet_', '').trim();
      await this.handleToggleTargetWallet(chatId, address);
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
   * Protected confirmation prompt before emergency Close All
   */
  public async promptCloseAllConfirmation(chatId: string | number): Promise<void> {
    const openPositions = db.getOpenPositions().filter((p) => p.state === 'OPEN' && BigInt(p.qtyRaw || '0') > 0n);
    const count = openPositions.length;
    if (count === 0) {
      await this.sendCustomMessage(chatId, 'ℹ️ No open positions to close.');
      return;
    }

    const text = `
🚨 <b>CONFIRM EMERGENCY CLOSE ALL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Are you sure you want to market sell and liquidate all <b>${count}</b> open position(s)?

⚠️ <i>This will execute immediate market orders for all active holdings.</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `🚨 YES, CLOSE ALL (${count})`, callback_data: 'confirm_close_all' },
          { text: '❌ CANCEL', callback_data: 'menu_positions' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Protected confirmation prompt before 100% position liquidation in LIVE mode
   */
  public async promptSell100Confirmation(chatId: string | number, posIdOrMint: string): Promise<void> {
    const pos = db.getPositionById(posIdOrMint) || db.getOpenPositionByMint(posIdOrMint);
    const mint = pos?.tokenMint || posIdOrMint;
    const meta = await tokenMetadataService.getTokenMetadata(mint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${mint.slice(0, 6).toUpperCase()}`;

    const text = `
⚠️ <b>CONFIRM 100% SELL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Close 100% of <b>${ticker}</b> at market price?

Signer: <code>${formatShortAddress(executionWalletManager.getPublicKeyBase58() || '', 4)}</code>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `🚨 YES, SELL 100%`, callback_data: `confirm_sell_100_${posIdOrMint}` },
          { text: '❌ CANCEL', callback_data: 'menu_positions' },
        ],
      ],
    };

    await this.sendCustomMessage(chatId, text, inlineKeyboard);
  }

  /**
   * Simplified 6-button primary keyboard
   */
  private getPersistentReplyKeyboard(): any {
    return {
      keyboard: [
        [{ text: '📊 POSITIONS' }, { text: '🎯 TARGETS' }],
        [{ text: '💼 WALLET' }, { text: '📈 PNL' }],
        [{ text: '🛡️ RISK' }, { text: '⚙️ STATUS' }],
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
    const balanceState = await executionWalletManager.getFreshBalance(20000);
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const balDisplay = balanceState.isAvailable
      ? `${balanceState.displayBalance} ($${(balanceState.balanceSol * solPriceUsd).toFixed(2)} USD)`
      : '⚠️ Balance unavailable / RPC syncing';
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
• <b>Wallet Balance:</b> ${balDisplay}
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
      const balState = executionWalletManager.getBalanceDisplayState();
      const bal = balState.balanceSol;
      const spendable = balState.spendableSol;
      const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
      const balUsd = bal * solPriceUsd;
      const spendableUsd = spendable * solPriceUsd;
      const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
      const reserveUsd = config.MIN_SOL_RESERVE_SOL * solPriceUsd;

      const text = `
🟢 <b>[BOT ACTIVATED]</b>

<b>Active Signer:</b> <code>${pub}</code>
<b>On-Chain Balance:</b> <b>${balState.displayBalance} ($${balUsd.toFixed(2)} USD)</b>
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
      const balanceState = await executionWalletManager.getFreshBalance(20000);
      const pub = executionWalletManager.getPublicKeyBase58();
      const isArmed = liveEngine.getStatus().isArmed;
      const minToArm = config.MIN_SOL_RESERVE_SOL + config.FIXED_BUY_SOL;
      const bal = balanceState.balanceSol;
      const spendable = balanceState.spendableSol;
      const balUsd = bal * solPriceUsd;
      const spendableUsd = spendable * solPriceUsd;
      const reserveUsd = config.MIN_SOL_RESERVE_SOL * solPriceUsd;
      const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;
      const minToArmUsd = minToArm * solPriceUsd;

      const accounting = db.getAccountingSummary();
      const realizedSol = accounting.realizedPnlSol;
      const realizedUsd = realizedSol * solPriceUsd;
      const closedTrades = accounting.totalTradesClosed;
      const winRate = accounting.winRatePct;

      const tpStatus = config.AUTO_TP_ENABLED ? '🟢 ON (+100%)' : '🔴 OFF';
      const slStatus = config.AUTO_SL_ENABLED ? `🟢 ON (-${config.AUTO_SL_LOSS_PCT}%)` : '🔴 OFF';
      const cooldownStatus = config.SINGLE_ENTRY_PER_TOKEN_ENABLED
        ? `🟢 ON (${(config.TOKEN_BUY_COOLDOWN_SEC / 60).toFixed(0)}m Cooldown)`
        : '🔴 OFF';
      const neverRebuyStatus = config.NEVER_REBUY_SAME_TOKEN
        ? '🔒 ON (1 Entry per Token)'
        : '🔴 OFF';

      let walletOverview = '';
      if (balanceState.isAvailable) {
        walletOverview = `
🏦 <b>EXECUTION WALLET</b>
├ <b>Address:</b> <code>${pub || 'Not Configured'}</code>
├ <b>Total On-Chain:</b> 💎 <b>${balanceState.displayBalance}</b> (<code>$${balUsd.toFixed(2)} USD</code>)
├ <b>Spendable Trading:</b> ⚡ <b>${spendable.toFixed(4)} SOL</b> (<code>$${spendableUsd.toFixed(2)} USD</code>)
└ <b>Gas Reserve Floor:</b> 🛡️ <b>${config.MIN_SOL_RESERVE_SOL} SOL</b> (<code>$${reserveUsd.toFixed(2)} USD</code>)
        `.trim();
      } else {
        walletOverview = `
🏦 <b>EXECUTION WALLET</b>
├ <b>Address:</b> <code>${pub || 'Not Configured'}</code>
├ <b>Total On-Chain:</b> ⚠️ <i>Balance unavailable / RPC syncing</i>
├ <b>Spendable Trading:</b> ⚠️ <i>Unavailable</i>
└ <b>Gas Reserve Floor:</b> 🛡️ <b>${config.MIN_SOL_RESERVE_SOL} SOL</b> (<code>$${reserveUsd.toFixed(2)} USD</code>)
        `.trim();
      }

      const text = `
💳 <b>HOT WALLET & BALANCE OVERVIEW</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>ENGINE STATUS:</b> ${isArmed ? '<code>ONLINE & ARMED (LIVE)</code>' : '<code>OFFLINE (PAUSED)</code>'}

${walletOverview}

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
  public async sendMainMenu(chatId: string | number, includeKeypad: boolean = false): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const isLive = config.EXECUTION_MODE === 'LIVE';
    const isArmed = isLive && liveEngine.getStatus().isArmed;
    const activeWallets = db.getWatchedWallets().filter((w) => w.enabled);
    const targetsCount = activeWallets.length > 0 ? activeWallets.length : config.WATCHED_WALLETS.length;
    const openPositionsCount = db.getOpenPositions().filter((p) => p.state === 'OPEN' && BigInt(p.qtyRaw || '0') > 0n).length;

    let balanceDisplay = '0.0000 SOL';
    let spendableDisplay = '0.0000 SOL';
    let balanceUsdDisplay = '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();

    if (isLive) {
      const balanceState = await executionWalletManager.getFreshBalance(20000);
      if (balanceState.isAvailable) {
        balanceDisplay = balanceState.displayBalance;
        spendableDisplay = `${balanceState.spendableSol.toFixed(4)} SOL`;
        balanceUsdDisplay = ` (<code>$${(balanceState.balanceSol * solPriceUsd).toFixed(2)} USD</code>)`;
      } else {
        balanceDisplay = '⚠️ Balance unavailable / RPC syncing';
        spendableDisplay = '⚠️ Unavailable';
      }
    } else {
      const paperBal = telemetry.currentPaperBalanceSol ?? 10.0;
      balanceDisplay = `${paperBal.toFixed(4)} SOL (Paper)`;
      spendableDisplay = `${Math.max(0, paperBal - config.MIN_SOL_RESERVE_SOL).toFixed(4)} SOL`;
    }

    const accounting = db.getAccountingSummary();
    const realizedSol = isLive ? (accounting.realizedPnlSol || 0) : (telemetry.totalRealizedPnlSol || 0);
    const realizedPnlSign = realizedSol >= 0 ? '+' : '';
    const pnlDisplay = `${realizedPnlSign}${realizedSol.toFixed(4)} SOL`;

    // Latency: no samples -> "Awaiting live samples"
    const latencyDisplay = telemetry.latencyP50Ms && telemetry.latencyP50Ms > 0
      ? `p50 ${telemetry.latencyP50Ms.toFixed(0)}ms`
      : 'Awaiting live samples';

    const feedName = config.HELIUS_API_KEY ? 'Helius Enhanced WSS' : 'Solana WSS';
    const fastPathState = config.FAST_COPY_MODE ? 'ON' : 'OFF';

    const statusBadge = isLive
      ? (isArmed ? '🟢 <b>LIVE • ARMED</b>' : '🔴 <b>LIVE • PAUSED</b>')
      : '🟡 <b>PAPER • RUNNING</b>';

    const text = `
⚡ <b>SOLANA COPY BOT</b>

${statusBadge}

💼 <b>Wallet</b>
${balanceDisplay}${balanceUsdDisplay}
Spendable: ${spendableDisplay}
Trade Size: ${config.FIXED_BUY_SOL.toFixed(4)} SOL

📊 <b>Trading</b>
Targets: ${targetsCount}
Positions: ${openPositionsCount}
Realized PnL: ${pnlDisplay}

⚡ <b>Execution</b>
Feed: ${feedName}
Fast Path: ${fastPathState}
Latency: ${latencyDisplay}

🛡️ <b>Risk Guards:</b> <b>ACTIVE</b>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 Positions', callback_data: 'menu_positions' },
          { text: '🎯 Targets', callback_data: 'menu_wallets' },
        ],
        [
          { text: '💼 Wallet', callback_data: 'menu_balance' },
          { text: '📈 PnL', callback_data: 'menu_pnl' },
        ],
        [
          { text: '🛡️ Risk', callback_data: 'menu_risk' },
          { text: '⚙️ Status', callback_data: 'menu_status' },
        ],
        [
          {
            text: isArmed ? '🔴 Pause Bot' : '🟢 Arm Bot',
            callback_data: isArmed ? 'action_deactivate' : 'action_activate',
          },
        ],
      ],
    };

    if (includeKeypad) {
      await this.sendCustomMessage(
        chatId,
        text,
        inlineKeyboard,
        this.getPersistentReplyKeyboard()
      );
    } else {
      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }
  }

  /**
   * Open Positions Report with Individual & Bulk Close Controls
   */
  public async sendOpenPositionsReport(chatId: string | number): Promise<void> {
    const rawPositions = db.getOpenPositions().filter((p) => {
      const mint = p.tokenMint || '';
      const isNotDummy =
        !mint.toLowerCase().includes('tokenmint') &&
        !mint.toLowerCase().includes('paper1111') &&
        !mint.toLowerCase().includes('test') &&
        mint !== '9aaDsN9KkSy9q3LmAwhXiJF75veH4wsbEFkJXqMH54VW' &&
        mint !== 'So11111111111111111111111111111111111111112';
      return p.state === 'OPEN' && isNotDummy && BigInt(p.qtyRaw || '0') > 0n;
    });

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();

    if (rawPositions.length === 0) {
      const isLive = config.EXECUTION_MODE === 'LIVE';
      const isArmed = isLive && liveEngine.getStatus().isArmed;
      const balanceState = isLive ? await executionWalletManager.getFreshBalance(20000) : null;
      const balDisplay = isLive
        ? (balanceState?.isAvailable ? `${balanceState.displayBalance} ($${(balanceState.balanceSol * solPriceUsd).toFixed(2)} USD)` : '⚠️ Balance unavailable / RPC syncing')
        : `${(db.getSystemTelemetry().currentPaperBalanceSol || 10.0).toFixed(4)} SOL ($${((db.getSystemTelemetry().currentPaperBalanceSol || 10.0) * solPriceUsd).toFixed(2)} USD)`;
      const accounting = db.getAccountingSummary();
      const realizedSol = accounting.realizedPnlSol;
      const realizedUsd = realizedSol * solPriceUsd;
      const winRate = accounting.winRatePct;
      const closedTrades = accounting.totalTradesClosed;

      const emptyMsg = `
📂 <b>PORTFOLIO POSITIONS (0 ACTIVE)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚪ <b>Current Holding:</b> <b>No active token positions</b>
💎 <b>Capital Status:</b> <b>100% Pure Liquid SOL</b> in execution wallet.

💼 <b>Wallet Balance:</b> <b>${balDisplay}</b>
📈 <b>Total Realized PnL:</b> <b>${realizedSol >= 0 ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL</b> (<code>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</code>)
🎯 <b>Win Rate:</b> <b>${winRate.toFixed(1)}%</b> (<code>${closedTrades} closed trades today</code>)

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
      `<b>[OPEN POSITIONS] (${rawPositions.length} Active)</b>\nUse the buttons below to close individually or tap Close All.`
    );

    // Parallel fetch metadata for all open positions in a single concurrent sweep (<300ms)
    const positionDetails = await Promise.all(
      rawPositions.map(async (pos) => {
        const [decimals, meta] = await Promise.all([
          mintDecimalsService.getDecimals(pos.tokenMint),
          tokenMetadataService.getTokenMetadata(pos.tokenMint),
        ]);
        return { pos, decimals, meta };
      })
    );

    for (const { pos, decimals, meta } of positionDetails) {
      const symbol = meta?.symbol || pos.tokenMint.substring(0, 6).toUpperCase();
      const name = meta?.name || symbol;

      const currentPriceSol = meta?.priceSol && meta.priceSol > 0 ? meta.priceSol : pos.avgEntryPriceSol;
      const currentPriceUsd = meta?.priceUsd && meta.priceUsd > 0 ? meta.priceUsd : currentPriceSol * solPriceUsd;

      const estMarketCapUsd = currentPriceSol * 1_000_000_000 * solPriceUsd;
      const mcapStr =
        estMarketCapUsd >= 1_000_000
          ? `$${(estMarketCapUsd / 1_000_000).toFixed(2)}M`
          : `$${(estMarketCapUsd / 1_000).toFixed(1)}K`;

      const tokenQty = Number(pos.qtyRaw) / (10 ** decimals);
      let costBasisLamports = BigInt(pos.costBasisLamports || '0');
      if (costBasisLamports === 0n) {
        costBasisLamports = BigInt(Math.round((config.FIXED_BUY_SOL || 0.05) * 1e9));
      }
      const costBasisSol = Number(costBasisLamports) / 1e9;
      const costBasisUsd = costBasisSol * solPriceUsd;

      const currentValueSol = tokenQty * currentPriceSol;
      const currentValueUsd = currentValueSol * solPriceUsd;

      const pnlSol = currentValueSol - costBasisSol;
      const pnlUsd = currentValueUsd - costBasisUsd;
      const pnlPct = costBasisSol > 0 ? (pnlSol / costBasisSol) * 100 : 0;
      const isProfit = pnlSol >= 0;

      const traderInfo = traderNamingService.getTraderInfo(pos.targetWallet || pos.tokenMint);

      const text = `
🪙 <b>ACTIVE HOLDING: $${symbol}</b>${name !== symbol ? ` (${name})` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 <b>Mint:</b> <code>${pos.tokenMint}</code>
👤 <b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
🔗 <b>Trader Links:</b> <a href="${traderInfo.solscanUrl}">Solscan</a> | <a href="${traderInfo.gmgnUrl}">GMGN Profile</a>
💎 <b>Price:</b> <code>$${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(7) : currentPriceUsd.toFixed(4)} USD</code> (<b>${currentPriceSol.toFixed(8)} SOL</b>)
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
            { text: `💰 TP 50% ($${symbol})`, callback_data: `sell_50_${pos.tokenMint}` },
          ],
          [
            { text: `⚡ TP 25%`, callback_data: `sell_25_${pos.tokenMint}` },
            { text: `⚡ TP 75%`, callback_data: `sell_75_${pos.tokenMint}` },
          ],
          [
            { text: '🚨 CLOSE ALL (100%)', callback_data: 'action_close_all' },
            { text: '🔄 REFRESH', callback_data: 'menu_positions' },
          ],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }

    if (rawPositions.length > 1) {
      await this.sendCustomMessage(chatId, '<b>[EMERGENCY BULK CONTROLS]</b>', {
        inline_keyboard: [
          [{ text: '🚨 CLOSE ALL POSITIONS (100%)', callback_data: 'action_close_all' }],
        ],
      });
    }

    await positionSyncService.persistOpenPositions();
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
    const enriched = await Promise.all(
      openPositions.map(async (p) => {
        const meta = await tokenMetadataService.getTokenMetadata(p.tokenMint);
        const sym = meta?.symbol ? meta.symbol.toUpperCase() : p.tokenMint.substring(0, 4).toUpperCase();
        return { p, sym };
      })
    );
    for (const { p, sym } of enriched) {
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

    const isLive = config.EXECUTION_MODE === 'LIVE';
    const mintsToClose = new Set<string>();

    // 1. From DB open positions
    const openPositions = db.getOpenPositions().filter((p) => p.state === 'OPEN');
    for (const p of openPositions) {
      if (p.tokenMint) mintsToClose.add(p.tokenMint);
    }

    // 2. In LIVE mode: directly query on-chain tokens held in wallet!
    if (isLive) {
      try {
        const held = await executionWalletManager.getHeldTokensWithAmounts();
        for (const h of held) {
          if (
            h.mint &&
            h.mint !== 'So11111111111111111111111111111111111111112' &&
            h.mint !== '9aaDsN9KkSy9q3LmAwhXiJF75veH4wsbEFkJXqMH54VW'
          ) {
            mintsToClose.add(h.mint);
          }
        }
      } catch (err: any) {
        console.warn('[Telegram] Error scanning on-chain tokens in close all:', err?.message || err);
      }
    }

    if (mintsToClose.size === 0) {
      await this.sendCustomMessage(
        chatId,
        'ℹ️ <b>No open token positions found to close.</b>\nYour wallet holds 100% pure SOL.'
      );
      return;
    }

    await this.sendCustomMessage(
      chatId,
      `🚨 <b>[CLOSING ALL]</b> Found ${mintsToClose.size} active token(s) to exit. Submitting 100% market sells...`
    );

    let successCount = 0;
    for (const mint of mintsToClose) {
      try {
        await this.executeManualSellFromChat(chatId, mint, 1.0);
        successCount++;
      } catch (err: any) {
        await this.sendCustomMessage(
          chatId,
          `❌ [CLOSE FAILED] <code>${mint}</code>: ${err?.message || err}`
        );
      }
    }

    await this.sendCustomMessage(
      chatId,
      `✅ <b>[CLOSE ALL COMPLETE]</b> Successfully exited ${successCount}/${mintsToClose.size} token(s).`
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
      const balanceState = await executionWalletManager.getFreshBalance(20000);
      if (!balanceState.isAvailable) {
        await this.sendCustomMessage(
          chatId,
          '⚠️ <b>[WALLET BALANCE SYNCING]</b>\n\nCould not query on-chain wallet balance right now due to RPC latency. Your funds are safe on-chain.\nPlease tap <b>/stats</b> again in a few seconds.'
        );
        return;
      }
      balanceSol = balanceState.balanceSol;
    }
    const balanceUsd = balanceSol * solPrice;

    const initialCapital = isLive
      ? (config.LIVE_INITIAL_BALANCE_SOL || 0.2610)
      : (telemetry.initialPaperBalanceSol || 10.0);
    const accounting = db.getAccountingSummary();
    const realizedSol = accounting.realizedPnlSol;
    const realizedUsd = realizedSol * solPrice;
    const unrealizedSol = telemetry.totalUnrealizedPnlSol || 0;
    const unrealizedUsd = unrealizedSol * solPrice;
    const totalPnlSol = realizedSol + unrealizedSol;
    const totalPnlUsd = realizedUsd + unrealizedUsd;
    const isOverallProfit = totalPnlSol >= 0;
    const roiPercent = initialCapital > 0 ? ((totalPnlSol / initialCapital) * 100) : 0;

    const winRate = accounting.winRatePct;
    const closedCount = accounting.totalTradesClosed;

    const pnlSign = isOverallProfit ? '+' : '';
    const pnlBadge = isOverallProfit ? '🟢' : '🔴';

    const closedPositions = db.getClosedPositions(4);
    const recentTradesText = closedPositions.length === 0
      ? '    • <i>No settled trades recorded yet.</i>'
      : closedPositions.map((c) => {
          const pnlLamports = Number(BigInt(c.realizedPnlLamports || '0'));
          const pnlInSol = pnlLamports / 1e9;
          const sign = pnlInSol >= 0 ? '+' : '';
          const badge = pnlInSol >= 0 ? '🟢' : '🔴';
          const shortMint = `${c.tokenMint.substring(0, 4)}...${c.tokenMint.substring(c.tokenMint.length - 4)}`;
          return `    • 🪙 <code>${shortMint}</code>: ${badge} <b>${sign}${pnlInSol.toFixed(4)} SOL</b>`;
        }).join('\n');

    const text = `
📊 <b>PORTFOLIO PnL & PERFORMANCE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>Execution Mode:</b> <code>${isLive ? 'LIVE MAINNET TRADING' : 'PAPER SIMULATION'}</code>
💼 <b>Available Balance:</b> 💎 <b>${balanceSol.toFixed(4)} SOL</b> (<code>$${balanceUsd.toFixed(2)} USD</code>)
💰 <b>Starting Capital:</b> <b>${initialCapital.toFixed(4)} SOL</b> (<code>$${(initialCapital * solPrice).toFixed(2)} USD</code>)

💰 <b>PROFIT & LOSS BREAKDOWN</b>
├ <b>Net Total PnL:</b> ${pnlBadge} <b>${pnlSign}$${totalPnlUsd.toFixed(2)} USD</b> (<code>${pnlSign}${totalPnlSol.toFixed(4)} SOL</code>)
├ <b>Realized Gains:</b> <b>${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD</b> (<code>${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL</code>)
├ <b>Unrealized (Open):</b> <b>${unrealizedSol >= 0 ? '+' : ''}$${unrealizedUsd.toFixed(2)} USD</b> (<code>${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(4)} SOL</code>)
└ <b>Portfolio ROI:</b> 🚀 <b>${roiPercent >= 0 ? '+' : ''}${roiPercent.toFixed(1)}%</b> (<i>Realized Growth</i>)

🎯 <b>TRADING ACTIVITY & STATS</b>
├ <b>Open Positions:</b> <b>${telemetry.openPositionsCount} Coins</b> ${telemetry.openPositionsCount === 0 ? '(<i>100% Pure SOL Liquid</i>)' : ''}
├ <b>Closed Trades:</b> <b>${closedCount}</b>
├ <b>Win Rate:</b> 🎯 <b>${winRate.toFixed(1)}%</b> (${closedCount > 0 ? `${closedCount} Settled Trades` : 'Baseline'})
└ <b>Recent Settled Trades:</b>
${recentTradesText}

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
      const balanceState = await executionWalletManager.getFreshBalance(20000);
      const pub = executionWalletManager.getPublicKeyBase58();
      const shortPub = pub ? `${pub.substring(0, 4)}...${pub.substring(pub.length - 4)}` : 'None';
      const solPrice = await tokenMetadataService.getSolPriceUsd();
      if (balanceState.isAvailable) {
        walletLine = `\n<b>Hot Wallet:</b> <code>${shortPub}</code> (${balanceState.displayBalance} | $${(balanceState.balanceSol * solPrice).toFixed(2)} USD)`;
      } else {
        walletLine = `\n<b>Hot Wallet:</b> <code>${shortPub}</code> (⚠️ <i>Balance unavailable / RPC syncing</i>)`;
      }
    }

    const solPrice = await tokenMetadataService.getSolPriceUsd();
    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPrice;

    const latencyP50Text = telemetry.latencyP50Ms && telemetry.latencyP50Ms > 0
      ? `${telemetry.latencyP50Ms.toFixed(1)}ms`
      : 'Awaiting live samples';
    const latencyP95Text = telemetry.latencyP95Ms && telemetry.latencyP95Ms > 0
      ? `${telemetry.latencyP95Ms.toFixed(1)}ms`
      : 'Awaiting live samples';

    const text = `
⚡ <b>SYSTEM ENGINE HEALTH & STATUS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>System Status:</b> <b>RUNNING & OPERATIONAL</b>
🎯 <b>Execution Mode:</b> <code>${isLive ? (isArmed ? '🟢 LIVE (ARMED & READY)' : '🔴 LIVE (PAUSED)') : 'PAPER'}</code>
⏱️ <b>Server Uptime:</b> <b>${formatUptime(telemetry.uptimeSeconds)}</b>${walletLine}

📡 <b>EXECUTION PATH</b>
├ <b>Feed Ingestion:</b> ⚡ <b>${config.HELIUS_API_KEY ? 'Helius Enhanced WSS' : 'Solana WSS'}</b>
├ <b>Median Latency (p50):</b> 🟢 <b>${latencyP50Text}</b>
├ <b>95th Percentile (p95):</b> ⚡ <b>${latencyP95Text}</b>
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
          const label = w.label && w.label !== 'Target Trader' ? w.label : `Trader #${idx + 1}`;
          return `${idx + 1}. 🏷️ <b>${label}</b>: <code>${short}</code>\n   🔗 <a href="https://solscan.io/account/${w.wallet}">Solscan</a> | <a href="https://gmgn.ai/sol/address/${w.wallet}">GMGN</a>\n   Mode: ${w.buyMode} | Sizing: ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD) | Status: ${w.enabled ? '🟢 Copying' : '⏸️ Paused'}`;
        })
        .join('\n\n');

      for (const w of wallets) {
        const short = `${w.wallet.substring(0, 4)}...${w.wallet.substring(w.wallet.length - 4)}`;
        const statusBtn = w.enabled ? '⏸️ Pause' : '▶️ Resume';
        inlineKeyboardRows.push([
          { text: statusBtn, callback_data: `toggle_wallet_${w.wallet}` },
          { text: `🧠 Score`, callback_data: `score_${w.wallet}` },
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
👥 <b>WATCHED TARGET TRADERS (${wallets.length} SAVED)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${walletList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>To give any trader a custom name, type: <code>/label 1 Alpha Whale</code></i>
⚡ <i>Signals from active traders are ingested via Helius LaserStream within <b>&lt;3ms</b>.</i>
    `.trim();

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineKeyboardRows });
    return;
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
      if (!existing.enabled) {
        existing.enabled = true;
        db.upsertWatchedWallet(existing);
        if (this.signalManagerRef) {
          this.signalManagerRef.refreshWallets();
        }
        await targetSyncService.syncAll();
        await this.sendCustomMessage(
          chatId,
          `✅ <b>[TARGET RE-ACTIVATED]</b>\nWallet <code>${address}</code> was already saved in your bot and has been re-activated for copy-trading!`
        );
        await this.sendWalletsReport(chatId);
        return;
      }
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

    await targetSyncService.syncAll();

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const sizingUsd = config.FIXED_BUY_SOL * solPriceUsd;

    const confirmMsg = `
✅ <b>[TARGET TRADER ADDED]</b>

<b>Address:</b> <code>${address}</code>
<b>Label:</b> ${newTarget.label}
<b>Copy Sizing:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD) per trade
<b>Stream:</b> Live on Helius LaserStream & Webhook
<b>Persistence:</b> 🔒 Saved permanently (never lost across redeployments)

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
   * Toggle enable / pause for target trader wallet without removing it
   */
  public async handleToggleTargetWallet(chatId: string | number, rawAddress: string): Promise<void> {
    const address = rawAddress.trim();
    const existing = db.getWatchedWallet(address);
    if (!existing) {
      await this.sendCustomMessage(chatId, `ℹ️ Wallet <code>${address}</code> not found.`);
      await this.sendWalletsReport(chatId);
      return;
    }

    existing.enabled = !existing.enabled;
    db.upsertWatchedWallet(existing);

    if (this.signalManagerRef) {
      this.signalManagerRef.refreshWallets();
    }

    await targetSyncService.syncAll();

    const statusText = existing.enabled ? '🟢 <b>ACTIVE (Copying ON)</b>' : '⏸️ <b>PAUSED (Copying OFF)</b>';
    await this.sendCustomMessage(
      chatId,
      `🎯 Target <code>${existing.label || address.slice(0, 4) + '...' + address.slice(-4)}</code> is now ${statusText}.\n<i>The wallet stays saved in your bot permanently so you never have to re-enter it.</i>`
    );
    await this.sendWalletsReport(chatId);
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

    await targetSyncService.syncAll();

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

      const { order, position } = await this.signalManagerRef.executeManualExit(posIdOrMint, fraction, true);

      const solReceived = Number(order.outAmountRaw || 0) / 1e9;
      const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
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
    if (!this.enabled || !this.botToken) {
      return;
    }
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
  /**
   * Real-time notification whenever target trader trades
   */
  public async notifyTargetDetected(
    intent: SwapIntent,
    actionTaken: 'COPIED' | 'DISARMED_SKIP' | 'RISK_REJECTED' | 'EXECUTION_FAILED',
    reason?: string
  ): Promise<void> {
    if (!this.enabled || !this.chatId) return;

    const now = Date.now();
    const lastAlert = this.lastTargetAlertByMint.get(intent.tokenMint);
    const isRepeated = Boolean(lastAlert && now - lastAlert < this.REJECTION_COOLDOWN_MS);

    if (actionTaken === 'RISK_REJECTED' && isRepeated) {
      // Suppress repeated target rejection cards within 15 minutes to reduce chat noise
      return;
    }
    this.lastTargetAlertByMint.set(intent.tokenMint, now);

    const meta = await tokenMetadataService.getTokenMetadata(intent.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${intent.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const estPriceUsd = intent.estimatedPrice * solPriceUsd;
    const priceDisplay = estPriceUsd < 0.0001
      ? `$${estPriceUsd.toFixed(6)}`
      : `$${estPriceUsd.toFixed(4)}`;

    const traderInfo = traderNamingService.getTraderInfo(intent.targetWallet);
    const venueName = formatVenueName(intent.venue);
    const isFastPath = intent.venue === 'PUMPFUN' && config.FAST_COPY_MODE;
    const fastPathText = isFastPath ? 'YES ⚡' : 'NO';

    let outcomeBlock = '';
    const buttons: any = {
      inline_keyboard: [
        [
          { text: '🎯 Target Tx', url: `https://solscan.io/tx/${intent.targetSignature}` },
          { text: '🪙 Token', url: `https://dexscreener.com/solana/${intent.tokenMint}` },
        ],
      ],
    };

    if (actionTaken === 'COPIED') {
      outcomeBlock = `
✅ <b>FOLLOWER ORDER SUBMITTED</b>
<b>Fast Path:</b> ${fastPathText}
      `.trim();
    } else if (actionTaken === 'DISARMED_SKIP') {
      outcomeBlock = `
⏸️ <b>FOLLOWER SKIPPED</b>
<b>Reason:</b> Bot is PAUSED / DISARMED.
<b>Fast Path:</b> ${fastPathText}
      `.trim();
      buttons.inline_keyboard.unshift([
        { text: '🟢 Arm Bot Now', callback_data: 'action_activate' },
        { text: '💼 Wallet', callback_data: 'menu_balance' },
      ]);
    } else {
      const gapInfo = formatGapBps(reason);
      if (gapInfo.isGap) {
        outcomeBlock = `
❌ <b>FOLLOWER SKIPPED</b>
<b>Price moved:</b> ${gapInfo.gapPctText}
<b>Max allowed:</b> ${gapInfo.maxPctText}
<b>Fast Path:</b> ${fastPathText}
<b>Reason:</b> ${gapInfo.cleanReason}
        `.trim();
      } else if (reason && reason.includes('already held pre-existing tokens')) {
        outcomeBlock = `
❌ <b>FOLLOWER SKIPPED</b>
<b>Reason:</b> Target trader already held tokens (re-buy / DCA). Only fresh initial entries are copied!
<b>Fast Path:</b> ${fastPathText}
        `.trim();
      } else if (reason && reason.includes('Circuit breaker is TRIPPED')) {
        outcomeBlock = `
🚨 <b>FOLLOWER SKIPPED</b>
<b>Reason:</b> Circuit breaker TRIPPED due to consecutive errors.
<b>Fast Path:</b> ${fastPathText}
        `.trim();
        buttons.inline_keyboard.unshift([
          { text: '🟢 Reset Circuit Breaker', callback_data: 'reset_breaker' },
        ]);
      } else {
        outcomeBlock = `
🛡️ <b>FOLLOWER SKIPPED</b>
<b>Reason:</b> ${reason || 'Risk limits exceeded'}
<b>Fast Path:</b> ${fastPathText}
        `.trim();
      }
    }

    const text = `
🎯 <b>TARGET ${intent.side} DETECTED</b>

<b>Trader:</b> <b>${traderInfo.displayName}</b>
<b>Token:</b> <b>${ticker}</b>${tokenName}
<b>Venue:</b> ${venueName}
<b>Target Entry:</b> <code>${priceDisplay}</code>

${outcomeBlock}
    `.trim();

    this.sendAlert(text, buttons);
  }

  /**
   * Real-time notification when a fast-path order is broadcast and awaiting on-chain confirmation
   */
  public async notifyTradeSubmitted(order: MirrorOrder, targetIntent?: SwapIntent): Promise<void> {
    const isFastPath = order.isFastPath ?? (order.venue === 'PUMPFUN' && config.FAST_COPY_MODE);
    const venueName = formatVenueName(order.venue || targetIntent?.venue || 'Pump.fun');
    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const solAmount = Number(order.inAmountRaw || 0) / 1e9;
    const usdAmount = solAmount * solPriceUsd;

    const sig = order.orderSignature || '';
    const sigText = sig
      ? `<a href="https://solscan.io/tx/${sig}">${formatShortAddress(sig, 4)}</a>`
      : 'Simulated';

    const traderWallet = (order as any).targetWallet || targetIntent?.targetWallet || traderNamingService.findTargetWalletByMint(order.tokenMint);
    const traderInfo = traderNamingService.getTraderInfo(traderWallet);
    const shortMint = formatShortAddress(order.tokenMint, 6);

    const text = `
⚡ <b>BUY SUBMITTED</b>

<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Size:</b> <b>${solAmount.toFixed(4)} SOL</b> (<code>$${usdAmount.toFixed(2)} USD</code>)
<b>Target:</b> <b>${traderInfo.displayName}</b>
<b>Venue:</b> <b>${venueName}</b>
<b>Fast Path:</b> <b>${isFastPath ? 'YES ⚡' : 'NO'}</b>
<b>Mint:</b> <code>${shortMint}</code>
<b>Tx:</b> ${sigText}

⏳ <i>Broadcasting to validators. Awaiting on-chain confirmation...</i>
    `.trim();

    const buttons = {
      inline_keyboard: [
        [
          { text: '🎯 Target Tx', url: `https://solscan.io/tx/${order.targetSignature}` },
          { text: '🪙 Token', url: `https://dexscreener.com/solana/${order.tokenMint}` },
        ],
      ],
    };

    this.sendAlert(text, buttons);
  }

  /**
   * Real-time notification when an order fails on-chain
   */
  public async notifyTradeFailed(order: MirrorOrder, reason: string): Promise<void> {
    const isFastPath = order.isFastPath ?? (order.venue === 'PUMPFUN' && config.FAST_COPY_MODE);
    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const shortMint = formatShortAddress(order.tokenMint, 6);

    const sig = order.orderSignature || '';
    const sigText = sig
      ? `<a href="https://solscan.io/tx/${sig}">${formatShortAddress(sig, 4)}</a>`
      : 'Simulated';

    const text = `
❌ <b>BUY FAILED</b>

<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Mint:</b> <code>${shortMint}</code>
<b>Fast Path:</b> <b>${isFastPath ? 'YES ⚡' : 'NO'}</b>
<b>Reason:</b> <code>${reason}</code>
<b>Tx:</b> ${sigText}

🛡️ <i>No tokens acquired. Capital reservation and lock released safely.</i>
    `.trim();

    const buttons = {
      inline_keyboard: [
        [
          { text: '🎯 Target Tx', url: `https://solscan.io/tx/${order.targetSignature}` },
          { text: '🪙 Token', url: `https://dexscreener.com/solana/${order.tokenMint}` },
        ],
      ],
    };

    this.sendAlert(text, buttons);
  }

  /**
   * Real-time notification when an order expires on-chain without landing
   */
  public async notifyTradeExpired(order: MirrorOrder, reason?: string): Promise<void> {
    const isFastPath = order.isFastPath ?? (order.venue === 'PUMPFUN' && config.FAST_COPY_MODE);
    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const shortMint = formatShortAddress(order.tokenMint, 6);

    const sig = order.orderSignature || '';
    const sigText = sig
      ? `<a href="https://solscan.io/tx/${sig}">${formatShortAddress(sig, 4)}</a>`
      : 'Simulated';

    const text = `
⚠️ <b>BUY EXPIRED</b>

<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Mint:</b> <code>${shortMint}</code>
<b>Fast Path:</b> <b>${isFastPath ? 'YES ⚡' : 'NO'}</b>
<b>Reason:</b> <i>Transaction did not land before block height expiration.</i>
<b>Tx:</b> ${sigText}

🛡️ <i>Capital reservation and lock released safely.</i>
    `.trim();

    const buttons = {
      inline_keyboard: [
        [
          { text: '🎯 Target Tx', url: `https://solscan.io/tx/${order.targetSignature}` },
          { text: '🪙 Token', url: `https://dexscreener.com/solana/${order.tokenMint}` },
        ],
      ],
    };

    this.sendAlert(text, buttons);
  }

  /**
   * Real-time notification when order broadcast status is uncertain
   */
  public async notifyTradeSubmissionUnknown(order: MirrorOrder, targetIntent?: SwapIntent): Promise<void> {
    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const shortMint = formatShortAddress(order.tokenMint, 6);

    const sig = order.orderSignature || '';
    const sigText = sig
      ? `<a href="https://solscan.io/tx/${sig}">${formatShortAddress(sig, 4)}</a>`
      : 'Simulated';

    const text = `
⏳ <b>BUY UNCERTAIN</b>

<b>Coin:</b> <b>${ticker}</b>${tokenName}
<b>Mint:</b> <code>${shortMint}</code>
<b>Tx:</b> ${sigText}

⚠️ <i>Broadcast status uncertain. Monitoring blockhash for confirmation or timeout...</i>
    `.trim();

    const buttons = {
      inline_keyboard: [
        [
          { text: '🎯 Target Tx', url: `https://solscan.io/tx/${order.targetSignature}` },
          { text: '🪙 Token', url: `https://dexscreener.com/solana/${order.tokenMint}` },
        ],
      ],
    };

    this.sendAlert(text, buttons);
  }

  /**
   * Real-time notification upon verified on-chain trade confirmation
   * NEVER called before on-chain CONFIRMED state!
   */
  public async notifyTradeFilled(order: MirrorOrder, position?: FollowerPosition): Promise<void> {
    const isBuy = order.side === 'BUY';
    const isFastPath = order.isFastPath ?? (order.venue === 'PUMPFUN' && config.FAST_COPY_MODE);
    const venueName = formatVenueName(order.venue || 'Pump.fun');

    const meta = await tokenMetadataService.getTokenMetadata(order.tokenMint);
    const ticker = meta?.symbol ? `$${meta.symbol.toUpperCase()}` : `$${order.tokenMint.slice(0, 6).toUpperCase()}`;
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';

    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const fillPriceSol = order.effectivePrice;
    const fillPriceUsd = fillPriceSol * solPriceUsd;

    const solAmount = isBuy
      ? Number(order.inAmountRaw || 0) / 1e9
      : Number(order.outAmountRaw || 0) / 1e9;
    const usdAmount = solAmount * solPriceUsd;

    const sig = order.orderSignature || '';
    const sigText = sig
      ? `<a href="https://solscan.io/tx/${sig}">${formatShortAddress(sig, 4)}</a>`
      : 'Simulated';

    const traderWallet = (order as any).targetWallet || position?.targetWallet || traderNamingService.findTargetWalletByMint(order.tokenMint);
    const traderInfo = traderNamingService.getTraderInfo(traderWallet);
    const mint = position?.tokenMint || order.tokenMint;
    const shortMint = formatShortAddress(order.tokenMint, 6);

    let text = '';
    let inlineKeyboard: any = undefined;

    if (isBuy) {
      let slotLines = '';
      if (order.targetSlot !== undefined || order.followerSlot !== undefined) {
        const targetSlotStr = order.targetSlot ? String(order.targetSlot) : 'N/A';
        const followerSlotStr = order.followerSlot ? String(order.followerSlot) : 'N/A';
        let gapStr = 'N/A';
        if (order.slotGap !== undefined) {
          gapStr = order.slotGap >= 0 ? `+${order.slotGap} slot(s)` : `${order.slotGap} slot(s)`;
        } else if (order.followerSlot && order.targetSlot) {
          const diff = order.followerSlot - order.targetSlot;
          gapStr = diff >= 0 ? `+${diff} slot(s)` : `${diff} slot(s)`;
        }
        slotLines = `\n<b>Target Slot:</b> <code>${targetSlotStr}</code>\n<b>Follower Slot:</b> <code>${followerSlotStr}</code>\n<b>Slot Gap:</b> <b>${gapStr}</b>\n`;
      }

      text = `
✅ <b>BUY CONFIRMED</b>

<b>${ticker}</b>${tokenName}
<b>Bought:</b> <b>${solAmount.toFixed(4)} SOL</b> (<code>$${usdAmount.toFixed(2)} USD</code>)
<b>Entry:</b> <code>$${fillPriceUsd < 0.01 ? fillPriceUsd.toFixed(7) : fillPriceUsd.toFixed(4)} USD</code> (<code>${fillPriceSol.toFixed(8)} SOL</code>)
<b>Target:</b> <b>${traderInfo.displayName}</b>
<b>Venue:</b> <b>${venueName}</b>
<b>Fast Path:</b> <b>${isFastPath ? 'YES ⚡' : 'NO'}</b>
${slotLines}
📌 <b>Mint:</b> <code>${shortMint}</code>
🔗 <b>Tx:</b> ${sigText}
      `.trim();

      inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '📊 Position', callback_data: 'menu_positions' },
            { text: `💰 Sell 50%`, callback_data: `sell_50_${mint}` },
            { text: `🚨 Sell 100%`, callback_data: `sell_100_${mint}` },
          ],
          [
            { text: '🎯 Target Tx', url: `https://solscan.io/tx/${order.targetSignature}` },
            { text: '🪙 Token', url: `https://dexscreener.com/solana/${order.tokenMint}` },
          ],
        ],
      };
    } else {
      // Sell confirmation
      const pnlSol = position ? Number(position.realizedPnlLamports) / 1e9 : 0;
      const pnlUsd = pnlSol * solPriceUsd;
      const isProfit = pnlSol >= 0;
      const headerTitle = isProfit ? '🎉 <b>SELL CONFIRMED</b>' : '⚡ <b>SELL CONFIRMED</b>';

      text = `
${headerTitle}

<b>${ticker}</b>${tokenName}
<b>Sold:</b> <b>${solAmount.toFixed(4)} SOL</b> (<code>$${usdAmount.toFixed(2)} USD</code>)
<b>Exit Price:</b> <code>$${fillPriceUsd.toFixed(4)} USD</code>
<b>Realized PnL:</b> <b>${isProfit ? '🟢 +' : '🔴 '}${pnlSol.toFixed(4)} SOL</b> (<code>${isProfit ? '+' : ''}$${pnlUsd.toFixed(2)} USD</code>)
<b>Target:</b> <b>${traderInfo.displayName}</b>
<b>Venue:</b> <b>${venueName}</b>
<b>Tx:</b> ${sigText}
      `.trim();

      inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '📊 Positions', callback_data: 'menu_positions' },
            { text: '📈 PnL Summary', callback_data: 'menu_pnl' },
          ],
          [
            { text: '🏠 Main Menu', callback_data: 'menu_main' },
          ],
        ],
      };
    }

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

    const traderInfo = traderNamingService.getTraderInfo(position.targetWallet || position.tokenMint);

    const text = `
🎯 <b>[AUTO TAKE-PROFIT FILLED] (+${pnlPct.toFixed(1)}%)</b>

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
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

    const traderInfo = traderNamingService.getTraderInfo(position.targetWallet || position.tokenMint);

    const text = `
🛡️ <b>[AUTO STOP-LOSS FILLED] (${pnlPct.toFixed(1)}%)</b>

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
<b>Strategy:</b> Anti-Rug Emergency Cut (100% Exited)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Loss Capped At:</b> $${realizedUsd.toFixed(2)} USD (${realizedSol.toFixed(4)} SOL)
<b>Status:</b> Position Closed to protect remaining capital${sigLink}
    `.trim();

    this.sendAlert(text);
  }

  /**
   * Real-Time Breakeven Protection Lock Alert (Fires when profit crosses +20%)
   */
  public async notifyBreakevenLocked(
    position: FollowerPosition,
    pnlPct: number,
    peakPct: number,
    meta?: TokenMetadata
  ): Promise<void> {
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const costBasisSol = Number(position.costBasisLamports) / 1e9;
    const currentValSol = costBasisSol * (1 + pnlPct / 100);
    const floatingPnlSol = currentValSol - costBasisSol;
    const floatingPnlUsd = floatingPnlSol * solPriceUsd;

    const sym = meta?.symbol ? meta.symbol.toUpperCase() : position.tokenMint.substring(0, 6).toUpperCase();
    const tokenName = meta?.name && meta.name !== 'Unknown Token' ? ` (${meta.name})` : '';
    const traderInfo = traderNamingService.getTraderInfo(position.targetWallet || position.tokenMint);

    const text = `
🛡️ <b>[BREAKEVEN PROTECTION LOCKED]</b> 🔒

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
<b>Trigger Gain:</b> <b>+${pnlPct.toFixed(1)}%</b> (Peak: +${peakPct.toFixed(1)}%) 🚀
<b>Floating Gain:</b> +${floatingPnlSol.toFixed(4)} SOL (+$${floatingPnlUsd.toFixed(2)} USD)
<b>Stop-Loss Floor:</b> <b>LOCKED AT +${config.BREAKEVEN_LOCK_PCT.toFixed(1)}%</b> (Entry Price + Fee Cushion)
<b>Protection Status:</b> <b>BREAKEVEN FLOOR ACTIVE</b> 🛡️
<i>Agar coin yahan se dump hota hai, toh bot automatically Breakeven par nikal jayega. Capital protection stop active!</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🚨 SELL 50%', callback_data: `sell_50_${position.tokenMint}` },
          { text: '🚨 SELL 100%', callback_data: `sell_100_${position.tokenMint}` },
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
   * Alert when Breakeven Exit is executed
   */
  public async notifyBreakevenExit(
    order: MirrorOrder,
    position: FollowerPosition,
    pnlPct: number,
    peakPct: number,
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

    const traderInfo = traderNamingService.getTraderInfo(position.targetWallet || position.tokenMint);

    const text = `
🛡️ <b>[BREAKEVEN PROTECTION EXIT FILLED]</b> 🛡️

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
<b>Strategy:</b> Breakeven Capital Protection (100% Exited)
<b>Highest Peak:</b> +${peakPct.toFixed(1)}% 🏔️
<b>Exit Result:</b> <b>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b> (${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL | ${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Verdict:</b> <b>Capital protection stop executed at breakeven before dump.</b>${sigLink}
    `.trim();

    this.sendAlert(text);
  }

  /**
   * Alert when Dynamic Trailing Stop-Loss is executed to bank profits
   */
  public async notifyTrailingStopLoss(
    order: MirrorOrder,
    position: FollowerPosition,
    pnlPct: number,
    floorPct: number,
    peakPct: number,
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

    const traderInfo = traderNamingService.getTraderInfo(position.targetWallet || position.tokenMint);

    const text = `
💰 <b>[TRAILING STOP-LOSS FILLED] (+${pnlPct.toFixed(1)}% PROFIT BANKED!)</b> 🎯

<b>Coin:</b> <b>$${sym}</b>${tokenName}
<b>Mint:</b> <code>${position.tokenMint}</code>
<b>Copied Trader:</b> <b>${traderInfo.displayName}</b>
<b>Strategy:</b> Dynamic Trailing Stop-Loss (100% Exited)
<b>Highest Peak:</b> <b>+${peakPct.toFixed(1)}%</b> 🏔️
<b>Trailing Floor:</b> +${floorPct.toFixed(1)}% (Max ${config.TRAILING_SL_CUSHION_PCT}% pullback tolerance)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Realized Profit:</b> <b>+$${realizedUsd.toFixed(2)} USD</b> (+${realizedSol.toFixed(4)} SOL) 💵
<b>Verdict:</b> <b>Munafa kamyabi se lock ho gaya! Coin dump hone par profit zaaya nahi hua.</b>${sigLink}
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
          { text: '🚨 SELL 50%', callback_data: `sell_50_${position.tokenMint}` },
          { text: '🚨 SELL 100%', callback_data: `sell_100_${position.tokenMint}` },
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
          { text: '🚨 SELL 50%', callback_data: `sell_50_${position.tokenMint}` },
          { text: '🚨 SELL 100%', callback_data: `sell_100_${position.tokenMint}` },
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
    const trailingText = config.TRAILING_SL_ENABLED
      ? `🛡️ <b>ACTIVE (Breakeven Floor & Trailing SL):</b>\n   ├ <b>+${config.BREAKEVEN_TRIGGER_PCT}% Gain:</b> Stop-Loss floor locked at <b>Entry (+${config.BREAKEVEN_LOCK_PCT}% cushion)</b> 🔒\n   ├ <b>+30%+ Gain:</b> Dynamic Trailing SL locks profit at <b>Peak - ${config.TRAILING_SL_CUSHION_PCT}%</b> 🏔️\n   └ <i>Automated protection with trailing floor against sudden market dumps.</i>`
      : '🔴 <b>DISABLED</b> (Breakeven Floor & Trailing SL is OFF)';

    const tpText = config.AUTO_TP_ENABLED
      ? `🟢 <b>ENABLED:</b> Sell <b>${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}%</b> when token reaches <b>+${config.AUTO_TP_GAIN_PCT}% (2x)</b>\n   └ <i>Initial principal returned to wallet, 50% moonbag rides for free!</i>`
      : '🔴 <b>DISABLED</b> (Auto Take-Profit is OFF)';

    const slText = config.AUTO_SL_ENABLED
      ? `🟢 <b>ENABLED:</b> Emergency exit <b>100%</b> when token drops to <b>-${config.AUTO_SL_LOSS_PCT}%</b>\n   └ <i>Anti-Rug base floor protects wallet if coin rugs immediately!</i>`
      : '🔴 <b>DISABLED</b> (Auto Stop-Loss is OFF)';

    const text = `
🎯 <b>AUTOMATED PROFIT & CAPITAL PROTECTION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🛡️ <b>Breakeven Floor & Trailing SL:</b>
${trailingText}

🚀 <b>Moonbag Auto Take-Profit:</b>
${tpText}

🚨 <b>Anti-Rug Base Stop-Loss:</b>
${slText}

⏱️ <b>Price Monitoring Poller:</b> Every <b>${(config.AUTO_EXIT_POLL_INTERVAL_MS / 1000).toFixed(1)}s</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>👇 Tap the buttons below to toggle any protection feature instantly:</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: config.TRAILING_SL_ENABLED ? '🛡️ Breakeven: ON (Tap to Disable)' : '⚪ Breakeven: OFF (Tap to Enable)',
            callback_data: 'toggle_trailing',
          },
        ],
        [
          { text: config.AUTO_TP_ENABLED ? '🔴 Turn OFF Auto-TP' : '🟢 Turn ON Auto-TP', callback_data: 'toggle_tp' },
          { text: config.AUTO_SL_ENABLED ? '🔴 Turn OFF Base-SL' : '🟢 Turn ON Base-SL', callback_data: 'toggle_sl' },
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
    const balanceState = isLive ? executionWalletManager.getBalanceDisplayState() : null;
    const solPriceUsd = await tokenMetadataService.getSolPriceUsd();
    const balDisplay = isLive
      ? (balanceState?.isAvailable ? `${balanceState.displayBalance} ($${(balanceState.balanceSol * solPriceUsd).toFixed(2)} USD)` : '⚠️ Balance unavailable / RPC syncing')
      : `10.0000 SOL ($${(10.0 * solPriceUsd).toFixed(2)} USD)`;
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
<b>Balance:</b> ${balDisplay}
<b>Ingestion:</b> Helius LaserStream (Sub-10ms)

Tap <b>ACTIVATE BOT</b> or use the interactive keypad below to manage trades and close positions.
    `.trim();

    this.sendAlert(text, this.getPersistentReplyKeyboard());
  }
}

export const telegramNotifier = new TelegramNotifier();
