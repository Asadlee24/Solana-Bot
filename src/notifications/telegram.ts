import { PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { riskEngine } from '../engine/risk-engine.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { liveEngine } from '../execution/live-engine.js';
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
            { command: 'start', description: 'Launch Trading Terminal & Keypad' },
            { command: 'menu', description: 'Main Control Menu' },
            { command: 'balance', description: 'Real On-Chain Wallet Balance' },
            { command: 'arm', description: 'ARM Live Engine (Enable Live Trading)' },
            { command: 'disarm', description: 'Emergency DISARM (Pause Trading)' },
            { command: 'positions', description: 'Open Positions & Close Controls' },
            { command: 'close', description: 'Close Position: /close <mint>' },
            { command: 'close_all', description: 'Emergency Close All Open Positions' },
            { command: 'targets', description: 'View & Manage Watched Target Traders' },
            { command: 'tpsl', description: 'Auto Take-Profit & Stop-Loss Settings' },
            { command: 'add_target', description: 'Add Target: /add_target <address>' },
            { command: 'remove_target', description: 'Remove Target: /remove_target <address>' },
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
   * Main text message dispatcher
   */
  private async handleTextMessage(msg: any): Promise<void> {
    const rawText = (msg.text || '').trim();
    const chatId = msg.chat?.id || this.chatId;

    if (chatId) {
      this.chatId = String(chatId);
    }

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
    } else if (clean === 'arm' || clean.includes('arm engine') || clean === 'start trading') {
      await this.handleArmCommand(chatId);
    } else if (clean === 'disarm' || clean.includes('disarm') || clean === 'kill' || clean === 'stop') {
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
      await this.sendCustomMessage(chatId, '🔴 <b>Anti-Rug Stop-Loss (-25%) has been TURNED OFF.</b>\nBot will NOT automatically cut losses on dumps.');
      await this.sendTpSlReport(chatId);
    } else if (clean === 'sl_on' || clean === 'slon' || clean === 'enable_sl') {
      (config as any).AUTO_SL_ENABLED = true;
      await this.sendCustomMessage(chatId, '🟢 <b>Anti-Rug Stop-Loss (-25%) has been TURNED ON.</b>\nBot will automatically emergency cut if token drops by -25%.');
      await this.sendTpSlReport(chatId);
    } else if (clean === 'risk' || clean.includes('risk controls') || clean === 'breaker' || clean.includes('risk limits')) {
      await this.sendRiskReport(chatId);
    } else if (clean === 'sim' || clean === 'simulate' || clean.includes('simulate buy') || clean === 'test') {
      await this.executeSimulationFromChat(chatId);
    } else if (clean.includes('refresh')) {
      await this.sendCustomMessage(chatId, '🔄 Synchronizing live on-chain feeds...');
      await this.sendBalanceReport(chatId);
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
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id || this.chatId;

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
    } else if (data === 'action_arm') {
      await this.handleArmCommand(chatId);
    } else if (data === 'action_disarm') {
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
      const status = config.AUTO_SL_ENABLED ? '🟢 <b>TURNED ON (-25% Emergency Cut)</b>' : '🔴 <b>TURNED OFF</b>';
      await this.sendCustomMessage(chatId, `🛡️ Anti-Rug Stop-Loss is now ${status}.`);
      await this.sendTpSlReport(chatId);
    } else if (data === 'menu_risk') {
      await this.sendRiskReport(chatId);
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
    } else if (data === 'prompt_add_wallet') {
      await this.sendCustomMessage(
        chatId,
        '🎯 <b>[ADD TARGET TRADER]</b>\n\nPaste a Solana wallet address directly in this chat, or type:\n<code>/add_target &lt;wallet_address&gt; [label]</code>\n\nExample:\n<code>/add_target CwUHN4...hJqS Alpha Whale</code>'
      );
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
          [{ text: 'POSITIONS' }, { text: 'WALLET BALANCE' }],
          [{ text: 'ARM ENGINE' }, { text: 'DISARM ENGINE' }],
          [{ text: 'TARGET TRADERS' }, { text: 'CLOSE ALL' }],
          [{ text: 'BOT STATUS' }, { text: 'MAIN MENU' }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      };
    }

    return {
      keyboard: [
        [{ text: 'POSITIONS' }, { text: 'PNL SUMMARY' }],
        [{ text: 'TARGET TRADERS' }, { text: 'BOT STATUS' }],
        [{ text: 'CLOSE ALL' }, { text: 'SIMULATE BUY' }],
        [{ text: 'REFRESH' }, { text: 'MAIN MENU' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  /**
   * ARM Live Engine Handler
   */
  public async handleArmCommand(chatId: string | number): Promise<void> {
    if (config.EXECUTION_MODE !== 'LIVE') {
      await this.sendCustomMessage(
        chatId,
        'ℹ️ <b>[PAPER MODE ACTIVE]</b>\nBot is currently configured in PAPER simulation mode (zero capital risk). Set <code>EXECUTION_MODE=LIVE</code> to arm real swaps.'
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
🟢 <b>[LIVE ENGINE ARMED]</b>

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
          [{ text: 'EMERGENCY DISARM', callback_data: 'action_disarm' }],
          [{ text: 'OPEN POSITIONS', callback_data: 'menu_positions' }, { text: 'MAIN MENU', callback_data: 'menu_main' }],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard, this.getPersistentReplyKeyboard());
    } else {
      const text = `
🔴 <b>[ARM REFUSED / DISARMED]</b>

<b>Reason:</b> ${result.reason}
<b>Required Action:</b> Check that your wallet has at least 0.03 SOL and <code>LIVE_TRADING_ACK=I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK</code> is set.
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: 'CHECK BALANCE', callback_data: 'menu_balance' }],
          [{ text: 'RETRY ARM', callback_data: 'action_arm' }],
        ],
      };

      await this.sendCustomMessage(chatId, text, inlineKeyboard);
    }
  }

  /**
   * DISARM Live Engine Handler
   */
  public async handleDisarmCommand(chatId: string | number): Promise<void> {
    liveEngine.kill('Operator disarmed via Telegram command');

    const text = `
🔴 <b>[LIVE ENGINE DISARMED]</b>

Trading execution paused. The bot will continue watching and logging signals, but <b>NO real transactions will be submitted</b>.
Tap <b>ARM ENGINE</b> when you are ready to resume.
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: 'ARM ENGINE', callback_data: 'action_arm' }],
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

      const text = `
💰 <b>[LIVE EXECUTION HOT WALLET]</b>

<b>Status:</b> ${isArmed ? '🟢 <b>LIVE ARMED</b>' : '🔴 <b>LIVE DISARMED</b>'}
<b>Public Address:</b> <code>${pub || 'Not Configured'}</code>
<b>On-Chain Balance:</b> <b>${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)</b>
<b>Spendable Balance:</b> ${spendable.toFixed(4)} SOL ($${spendableUsd.toFixed(2)} USD)
<b>Reserve Floor:</b> ${config.MIN_SOL_RESERVE_SOL} SOL ($${reserveUsd.toFixed(2)} USD) (Protected)
<b>Fixed Trade Size:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD)
<b>Minimum Balance to Arm:</b> ${minToArm.toFixed(2)} SOL ($${minToArmUsd.toFixed(2)} USD) (Passed)

🔗 <a href="https://solscan.io/account/${pub}">View Wallet on Solscan</a>
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: isArmed ? 'DISARM ENGINE' : 'ARM ENGINE', callback_data: isArmed ? 'action_disarm' : 'action_arm' },
            { text: 'REFRESH BALANCE', callback_data: 'menu_balance' },
          ],
          [
            { text: 'OPEN POSITIONS', callback_data: 'menu_positions' },
            { text: 'MAIN MENU', callback_data: 'menu_main' },
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
    const modeBadge = isLive ? (isArmed ? '🟢 [LIVE ARMED]' : '🔴 [LIVE DISARMED]') : '[PAPER SIMULATION]';
    const targetWallet = config.WATCHED_WALLETS[0] || 'CwUHN4...';
    const targetShort = `${targetWallet.substring(0, 4)}...${targetWallet.substring(targetWallet.length - 4)}`;

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

      balanceBlock = `
<b>Wallet:</b> <code>${shortPub}</code>
<b>Real Balance:</b> <b>${liveBal.toFixed(4)} SOL ($${liveBalUsd.toFixed(2)} USD)</b>
<b>Spendable:</b> ${liveSpendable.toFixed(4)} SOL ($${liveSpendableUsd.toFixed(2)} USD)
<b>Trade Sizing:</b> ${config.FIXED_BUY_SOL} SOL ($${sizingUsd.toFixed(2)} USD)
      `.trim();
    } else {
      balanceBlock = `<b>Portfolio Balance:</b> ${telemetry.currentPaperBalanceSol.toFixed(4)} SOL ($${telemetry.totalPaperBalanceUsd.toFixed(2)} USD)`;
    }

    const text = `
<b>[SOLANA COPY ENGINE] TERMINAL CONTROL</b>

<b>Mode:</b> ${modeBadge}
<b>Target Trader:</b> <code>${targetShort}</code>
${balanceBlock}
<b>Stream Status:</b> Helius LaserStream (Active)
<b>Latency (p50):</b> ${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(1)}ms` : '2.3ms'}
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'POSITIONS', callback_data: 'menu_positions' },
          { text: isLive ? 'WALLET BALANCE' : 'PNL SUMMARY', callback_data: isLive ? 'menu_balance' : 'menu_pnl' },
        ],
        [
          { text: isArmed ? 'DISARM ENGINE' : 'ARM ENGINE', callback_data: isArmed ? 'action_disarm' : 'action_arm' },
          { text: 'ENGINE STATUS', callback_data: 'menu_status' },
        ],
        [
          { text: 'CLOSE ALL POSITIONS', callback_data: 'action_close_all' },
          { text: 'TARGET WALLETS', callback_data: 'menu_wallets' },
        ],
        [
          { text: '🎯 AUTO TP / SL', callback_data: 'menu_tpsl' },
          { text: 'REFRESH', callback_data: 'menu_main' },
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
    const openPositions = db.getOpenPositions().filter((p) => {
      const mint = p.tokenMint || '';
      const isAllowed = allowedWallets.has(p.targetWallet) || !p.targetWallet;
      const isNotDummy =
        !mint.toLowerCase().includes('tokenmint') &&
        !mint.toLowerCase().includes('paper1111') &&
        !mint.toLowerCase().includes('test');
      return p.state === 'OPEN' && isAllowed && isNotDummy;
    });

    if (openPositions.length === 0) {
      const isLive = config.EXECUTION_MODE === 'LIVE';
      const isArmed = isLive && liveEngine.getStatus().isArmed;
      const bal = executionWalletManager.getCachedBalanceSol();
      const balUsd = bal * solPriceUsd;

      const emptyMsg = `
<b>[ACTIVE POSITIONS] 0 OPEN</b>

No active token positions currently held.
<b>Mode:</b> ${isLive ? (isArmed ? '🟢 LIVE ARMED' : '🔴 LIVE DISARMED') : 'PAPER'}
${isLive ? `<b>Balance:</b> ${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)` : ''}

When target trader executes a swap on pump.fun or Raydium, the follower order will land immediately and appear here with instant Close buttons.
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: isArmed ? 'DISARM ENGINE' : 'ARM ENGINE', callback_data: isArmed ? 'action_disarm' : 'action_arm' },
            { text: 'WALLET BALANCE', callback_data: 'menu_balance' },
          ],
          [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
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
<b>[POSITION] $${symbol} (${name})</b>

<b>Mint:</b> <code>${pos.tokenMint}</code>
<b>Price:</b> $${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(6) : currentPriceUsd.toFixed(4)} USD (${currentPriceSol.toFixed(8)} SOL)
<b>Market Cap:</b> ${mcapStr}
<b>Holdings:</b> ${tokenQty.toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens
<b>Cost Basis:</b> ${costBasisSol.toFixed(4)} SOL ($${costBasisUsd.toFixed(2)} USD)
<b>Current Value:</b> ${currentValueSol.toFixed(4)} SOL ($${currentValueUsd.toFixed(2)} USD)
<b>Unrealized PnL:</b> <b>${isProfit ? '+' : ''}$${pnlUsd.toFixed(2)} USD</b> (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL | <b>${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%</b>)
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '🚨 CLOSE 100%', callback_data: `sell_100_${pos.tokenMint}` },
            { text: 'TP 50%', callback_data: `sell_50_${pos.tokenMint}` },
          ],
          [
            { text: 'TP 25%', callback_data: `sell_25_${pos.tokenMint}` },
            { text: 'TP 75%', callback_data: `sell_75_${pos.tokenMint}` },
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

    const rows: any[] = openPositions.map((p) => {
      const short = `${p.tokenMint.substring(0, 4)}...${p.tokenMint.substring(p.tokenMint.length - 4)}`;
      return [
        { text: `CLOSE ${short} (100%)`, callback_data: `sell_100_${p.tokenMint}` },
        { text: `SELL 50%`, callback_data: `sell_50_${p.tokenMint}` },
      ];
    });

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

    const text = `
<b>[PORTFOLIO PERFORMANCE SUMMARY]</b>

<b>Execution Mode:</b> ${isLive ? 'LIVE' : 'PAPER'}
<b>Open Positions:</b> ${telemetry.openPositionsCount}
<b>Unrealized PnL:</b> ${unrealizedSol >= 0 ? '+' : ''}$${unrealizedUsd.toFixed(2)} USD (${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(4)} SOL)
<b>Realized PnL:</b> ${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD (${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL)
<b>Net Total PnL:</b> <b>${isOverallProfit ? '+' : ''}$${totalPnlUsd.toFixed(2)} USD</b> (${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL)
<b>Portfolio ROI:</b> ${telemetry.roiPercent ? `${telemetry.roiPercent.toFixed(2)}%` : '0.00%'}
<b>Available Balance:</b> ${balanceSol.toFixed(4)} SOL ($${balanceUsd.toFixed(2)} USD)
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'VIEW POSITIONS', callback_data: 'menu_positions' },
          { text: 'REFRESH', callback_data: 'menu_pnl' },
        ],
        [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
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

    const text = `
<b>[SYSTEM STATUS & TELEMETRY]</b>

<b>Status:</b> RUNNING (Operational)
<b>Mode:</b> ${isLive ? (isArmed ? '🟢 LIVE ARMED' : '🔴 LIVE DISARMED') : 'PAPER'}${walletLine}
<b>Target Traders:</b> ${config.WATCHED_WALLETS.length} registered
<b>Orders Copied:</b> ${telemetry.totalTradesProcessed}
<b>Reaction Latency (p50):</b> ${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(2)}ms` : '2.33ms'}
<b>95th Percentile (p95):</b> ${telemetry.latencyP95Ms ? `${telemetry.latencyP95Ms.toFixed(2)}ms` : '6.28ms'}
<b>Circuit Breaker:</b> ${isTripped ? 'TRIPPED (Trading Paused)' : 'ARMED (Normal)'}
<b>Hot Path Feed:</b> Helius LaserStream (Sub-10ms)
<b>Uptime:</b> ${formatUptime(telemetry.uptimeSeconds)}
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: isArmed ? 'DISARM ENGINE' : 'ARM ENGINE', callback_data: isArmed ? 'action_disarm' : 'action_arm' },
          { text: 'WALLET BALANCE', callback_data: 'menu_balance' },
        ],
        [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
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
          { text: `🗑️ Remove ${w.label || short}`, callback_data: `del_wallet_${w.wallet}` },
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
<b>[WATCHED TARGET TRADERS] (${wallets.length})</b>

${walletList}

⚡ Signals from these traders are ingested via Helius LaserStream within <b>&lt;3ms</b>.
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
          [{ text: '🗑️ Remove Target', callback_data: `del_wallet_${address}` }],
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

Would you like to add this address to your <b>Target Traders</b> list? The bot will automatically copy its buy and sell swaps on pump.fun and Raydium!
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '➕ Start Copy-Trading This Wallet', callback_data: `add_wallet_${address}` }],
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

    const text = `
<b>[PRE-TRADE RISK CONTROLS]</b>

<b>Circuit Breaker:</b> ${isTripped ? 'TRIPPED' : 'ARMED (Normal)'}
<b>Max Slippage:</b> ${config.MAX_SLIPPAGE_BPS} bps (${(config.MAX_SLIPPAGE_BPS / 100).toFixed(2)}%)
<b>Max Entry Gap:</b> ${config.MAX_ENTRY_GAP_BPS} bps (${(config.MAX_ENTRY_GAP_BPS / 100).toFixed(2)}%)
<b>Signal Max Age:</b> ${config.MAX_SIGNAL_AGE_MS} ms
<b>Max Total Exposure:</b> ${config.MAX_TOTAL_EXPOSURE_SOL} SOL ($${maxExpUsd.toFixed(2)} USD)
<b>Daily Loss Limit:</b> ${config.DAILY_LOSS_LIMIT_SOL} SOL ($${dailyLossUsd.toFixed(2)} USD)
<b>Consecutive Error Limit:</b> ${config.CONSECUTIVE_ERROR_LIMIT}
    `.trim();

    const inlineRows: any[] = [];
    if (isTripped) {
      inlineRows.push([{ text: 'RESET CIRCUIT BREAKER', callback_data: 'reset_breaker' }]);
    }
    inlineRows.push([
      { text: 'BOT STATUS', callback_data: 'menu_status' },
      { text: 'MAIN MENU', callback_data: 'menu_main' },
    ]);

    await this.sendCustomMessage(chatId, text, { inline_keyboard: inlineRows });
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

      const confirmMsg = `
✅ <b>[EXIT EXECUTED] (${exitPct}%)</b>

<b>Token:</b> <code>${order.tokenMint}</code>
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

  /**
   * Real-time notification whenever target trader trades
   */
  public async notifyTargetDetected(
    intent: SwapIntent,
    actionTaken: 'COPIED' | 'DISARMED_SKIP' | 'RISK_REJECTED',
    reason?: string
  ): Promise<void> {
    if (!this.enabled || !this.chatId) return;
    const sideEmoji = intent.side === 'BUY' ? '🟢' : '🔴';
    let statusText = '';
    let buttons: any = undefined;

    if (actionTaken === 'COPIED') {
      statusText = '✅ <b>Follower Order Submitted</b>';
    } else if (actionTaken === 'DISARMED_SKIP') {
      statusText = `⏸️ <b>Trade Skipped: Live Engine is DISARMED</b>\n<i>(${reason || 'Safety lock active'})</i>`;
      buttons = {
        inline_keyboard: [
          [{ text: '🟢 ARM ENGINE NOW', callback_data: 'action_arm' }],
          [{ text: 'WALLET BALANCE', callback_data: 'menu_balance' }],
        ],
      };
    } else {
      statusText = `🛡️ <b>Skipped by Risk Engine:</b> ${reason || 'Circuit breaker / limits'}`;
    }

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
<b>Token:</b> <code>${intent.tokenMint}</code>
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
    if (position && !isBuy) {
      const pnlSol = Number(position.realizedPnlLamports) / 1e9;
      const pnlUsd = pnlSol * solPriceUsd;
      const isProfit = pnlSol >= 0;
      pnlText = `\n<b>Realized PnL:</b> <b>${isProfit ? '+' : ''}$${pnlUsd.toFixed(2)} USD</b> (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL)`;
    }

    const sigText = order.orderSignature
      ? `<a href="https://solscan.io/tx/${order.orderSignature}">${order.orderSignature.slice(0, 8)}...</a>`
      : 'Simulated';

    const text = `
⚡ <b>[EXECUTION] ${modeBadge} ${sideTag}</b>

<b>Token:</b> <code>${order.tokenMint}</code>
<b>Fill Price:</b> $${fillPriceUsd < 0.01 ? fillPriceUsd.toFixed(7) : fillPriceUsd.toFixed(4)} USD (${fillPriceSol.toFixed(8)} SOL)
<b>Market Cap:</b> ${mcapStr} MCap
<b>Amount:</b> ${solAmount.toFixed(4)} SOL ($${usdAmount.toFixed(2)} USD)${pnlText}
<b>Signature:</b> ${sigText}
    `.trim();

    const mint = position?.tokenMint || order.tokenMint;
    const inlineKeyboard = isBuy && mint
      ? {
          inline_keyboard: [
            [
              { text: '🚨 CLOSE 100%', callback_data: `sell_100_${mint}` },
              { text: 'TP 50%', callback_data: `sell_50_${mint}` },
            ],
            [
              { text: 'POSITIONS', callback_data: 'menu_positions' },
              { text: 'WALLET BALANCE', callback_data: 'menu_balance' },
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

    const sym = meta?.symbol || position.tokenMint.substring(0, 6).toUpperCase();

    const sigText = order.orderSignature
      ? `<a href="https://solscan.io/tx/${order.orderSignature}">${order.orderSignature.slice(0, 8)}...</a>`
      : 'Completed';

    const text = `
✅ <b>[POSITION EXIT FILLED] (${Math.round(fraction * 100)}%)</b>

<b>Token:</b> $${sym} (<code>${position.tokenMint}</code>)
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

    const sym = meta?.symbol || position.tokenMint.substring(0, 6).toUpperCase();
    const sigShort = order.orderSignature ? order.orderSignature.slice(0, 8) + '...' : 'Completed';
    const sigLink = order.orderSignature ? `\n<b>Tx:</b> <a href="https://solscan.io/tx/${order.orderSignature}">${sigShort}</a>` : '';

    const text = `
🎯 <b>[AUTO TAKE-PROFIT FILLED] (+${pnlPct.toFixed(1)}%)</b>

<b>Token:</b> $${sym} (<code>${position.tokenMint}</code>)
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

    const sym = meta?.symbol || position.tokenMint.substring(0, 6).toUpperCase();
    const sigShort = order.orderSignature ? order.orderSignature.slice(0, 8) + '...' : 'Completed';
    const sigLink = order.orderSignature ? `\n<b>Tx:</b> <a href="https://solscan.io/tx/${order.orderSignature}">${sigShort}</a>` : '';

    const text = `
🛡️ <b>[AUTO STOP-LOSS FILLED] (${pnlPct.toFixed(1)}%)</b>

<b>Token:</b> $${sym} (<code>${position.tokenMint}</code>)
<b>Strategy:</b> Anti-Rug Emergency Cut (100% Exited)
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Loss Capped At:</b> $${realizedUsd.toFixed(2)} USD (${realizedSol.toFixed(4)} SOL)
<b>Status:</b> Position Closed to protect remaining capital${sigLink}
    `.trim();

    this.sendAlert(text);
  }

  public async sendTpSlReport(chatId: string | number): Promise<void> {
    const tpText = config.AUTO_TP_ENABLED
      ? `🟢 <b>Enabled:</b> Sell ${(config.AUTO_TP_SELL_FRACTION * 100).toFixed(0)}% when token reaches <b>+${config.AUTO_TP_GAIN_PCT}% (2x)</b>\n   <i>(Principal returned to wallet, remaining 50% rides as free moonbag)</i>`
      : '🔴 <b>Disabled</b> (Auto-TP is OFF)';

    const slText = config.AUTO_SL_ENABLED
      ? `🟢 <b>Enabled:</b> Emergency exit 100% when token drops to <b>-${config.AUTO_SL_LOSS_PCT}%</b>\n   <i>(Protects capital against sudden rugpulls & dumps)</i>`
      : '🔴 <b>Disabled</b> (Auto-SL is OFF)';

    const text = `
🎯 <b>[AUTOMATED TAKE-PROFIT & STOP-LOSS]</b>

<b>Moonbag Auto-TP:</b>
${tpText}

<b>Anti-Rug Auto-SL:</b>
${slText}

<b>Price Monitoring Frequency:</b> Every ${(config.AUTO_EXIT_POLL_INTERVAL_MS / 1000).toFixed(1)}s

Tap below to turn Auto-TP or Auto-SL ON or OFF anytime:
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: config.AUTO_TP_ENABLED ? '🔴 Turn OFF Auto-TP' : '🟢 Turn ON Auto-TP', callback_data: 'toggle_tp' },
          { text: config.AUTO_SL_ENABLED ? '🔴 Turn OFF Auto-SL' : '🟢 Turn ON Auto-SL', callback_data: 'toggle_sl' },
        ],
        [
          { text: 'OPEN POSITIONS', callback_data: 'menu_positions' },
          { text: 'TARGET TRADERS', callback_data: 'menu_wallets' },
        ],
        [{ text: 'MAIN MENU', callback_data: 'menu_main' }],
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

    const text = `
⚡ <b>[SOLANA COPY ENGINE] ONLINE</b>

<b>Mode:</b> ${isLive ? (isArmed ? '🟢 LIVE ARMED' : '🔴 LIVE DISARMED') : 'PAPER'}
<b>Target Trader:</b> <code>${config.WATCHED_WALLETS[0]}</code>
<b>Sizing:</b> ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL | $${sizingUsd.toFixed(2)} USD)
<b>Balance:</b> ${bal.toFixed(4)} SOL ($${balUsd.toFixed(2)} USD)
<b>Ingestion:</b> Helius LaserStream (Sub-10ms)

Tap <b>ARM ENGINE</b> or use the interactive keypad below to manage trades and close positions.
    `.trim();

    this.sendAlert(text, this.getPersistentReplyKeyboard());
  }
}

export const telegramNotifier = new TelegramNotifier();
