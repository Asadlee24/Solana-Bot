import { config } from '../config/index.js';
import { db } from '../db/database.js';
import { tokenMetadataService, TokenMetadata } from '../services/token-metadata.js';
import { FollowerPosition, MirrorOrder } from '../types/index.js';

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private updateOffset: number = 0;
  private isPolling: boolean = false;
  private signalManagerRef: any = null;

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.enabled = Boolean(this.botToken && this.chatId);
  }

  public setSignalManager(sm: any): void {
    this.signalManagerRef = sm;
  }

  /**
   * Non-blocking send alert with optional inline keyboard buttons
   */
  public async sendAlert(text: string, replyMarkup?: any): Promise<void> {
    if (!this.enabled) return;

    setImmediate(async () => {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        const payload: any = {
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        };
        if (replyMarkup) {
          payload.reply_markup = replyMarkup;
        }

        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.warn('[Telegram Alert Failed]:', err);
      }
    });
  }

  /**
   * Start long-polling for incoming Telegram commands (/positions, /pnl, inline buttons)
   */
  public startInteractivePolling(): void {
    if (!this.enabled || this.isPolling) return;
    this.isPolling = true;
    console.info('[Telegram Bot] Interactive command listener started.');

    const poll = async () => {
      if (!this.isPolling) return;
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=15`;
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
      } catch {
        // Network timeout / backoff
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

  private async handleTextMessage(msg: any): Promise<void> {
    const text = (msg.text || '').trim();
    const chatId = msg.chat?.id || this.chatId;

    if (text.startsWith('/start') || text.startsWith('/help')) {
      const helpMsg = `
<b>⚡ SOLANA COPY BOT CONTROL ⚡</b>

<b>Commands:</b>
• <b>/positions</b> or <b>/pnl</b> — View currently open positions, live profit/loss in SOL & USD, and Take Profit buttons.
• <b>/status</b> — Bot health, balance, and execution mode.
• <b>/sell &lt;mint&gt; [pct]</b> — Manually sell token (e.g. <code>/sell 3fkp... 50</code>).
• <b>/close &lt;mint&gt;</b> — Close 100% of an open position.
      `.trim();
      await this.sendCustomMessage(chatId, helpMsg);
    } else if (text.startsWith('/positions') || text.startsWith('/pnl')) {
      await this.sendOpenPositionsReport(chatId);
    } else if (text.startsWith('/status')) {
      await this.sendStatusReport(chatId);
    } else if (text.startsWith('/close') || text.startsWith('/sell')) {
      const parts = text.split(' ');
      const mint = parts[1];
      const fraction = parts[2] ? parseFloat(parts[2]) / (parseFloat(parts[2]) > 1 ? 100 : 1) : 1.0;

      if (!mint) {
        await this.sendCustomMessage(chatId, '⚠️ Please provide token mint: <code>/close &lt;mint&gt;</code>');
        return;
      }

      await this.executeManualSellFromChat(chatId, mint, fraction);
    }
  }

  private async handleCallbackQuery(cq: any): Promise<void> {
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id || this.chatId;

    // Acknowledge callback query
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
    } catch {}

    if (data.startsWith('sell_')) {
      // Format: sell_50_<posId> or sell_100_<posId>
      const parts = data.split('_');
      const pct = parseInt(parts[1], 10);
      const posId = parts.slice(2).join('_');
      const fraction = pct / 100;

      await this.executeManualSellFromChat(chatId, posId, fraction);
    }
  }

  private async executeManualSellFromChat(chatId: string | number, posIdOrMint: string, fraction: number): Promise<void> {
    if (!this.signalManagerRef) {
      await this.sendCustomMessage(chatId, '❌ Signal Manager not attached to bot yet.');
      return;
    }

    try {
      await this.sendCustomMessage(chatId, `⏳ Executing manual exit (${Math.round(fraction * 100)}%)...`);
      const { order, position } = await this.signalManagerRef.executeManualExit(posIdOrMint, fraction);

      const solReceived = Number(order.outAmountRaw || 0) / 1e9;
      const solPriceUsd = 100.0;
      const usdReceived = solReceived * solPriceUsd;

      const realizedSol = position ? Number(position.realizedPnlLamports) / 1e9 : 0;
      const realizedUsd = realizedSol * solPriceUsd;
      const isProfit = realizedSol >= 0;

      const confirmMsg = `
<b>✅ MANUAL EXIT EXECUTED (${Math.round(fraction * 100)}%)!</b>
<b>Token:</b> <code>${order.tokenMint}</code>
<b>Payout:</b> +${solReceived.toFixed(4)} SOL (+$${usdReceived.toFixed(2)} USD)
<b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}${realizedSol.toFixed(4)} SOL (${isProfit ? '+$' : '-$'}${Math.abs(realizedUsd).toFixed(2)} USD)
<b>State:</b> ${position?.state || 'CLOSED'}
      `.trim();

      await this.sendCustomMessage(chatId, confirmMsg);
    } catch (err: any) {
      await this.sendCustomMessage(chatId, `❌ Error executing exit: ${err.message || err}`);
    }
  }

  public async sendOpenPositionsReport(chatId: string | number): Promise<void> {
    const openPositions = db.getOpenPositions().filter((p) => p.state === 'OPEN');
    if (openPositions.length === 0) {
      await this.sendCustomMessage(chatId, 'ℹ️ No open positions currently active.');
      return;
    }

    const solPriceUsd = 100.0;

    for (const pos of openPositions) {
      const meta = await tokenMetadataService.getTokenMetadata(pos.tokenMint);
      const symbol = meta?.symbol || pos.tokenMint.substring(0, 6);
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
<b>Mint:</b> <code>${pos.tokenMint}</code>
<b>Live Price:</b> $${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(7) : currentPriceUsd.toFixed(4)} USD (${currentPriceSol.toFixed(8)} SOL)
<b>Tokens Held:</b> ${tokenQty.toLocaleString('en-US', { maximumFractionDigits: 2 })}
<b>Cost Basis:</b> $${costBasisUsd.toFixed(2)} USD (${costBasisSol.toFixed(4)} SOL)
<b>Current Value:</b> $${currentValueUsd.toFixed(2)} USD (${currentValueSol.toFixed(4)} SOL)
<b>Profit / Loss:</b> <b>${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(pnlUsd).toFixed(2)} USD</b> (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL | <b>${isProfit ? '+' : ''}${pnlPct.toFixed(1)}%</b>)
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '💰 Take Profit 50%', callback_data: `sell_50_${pos.id}` },
            { text: '🚨 Close 100%', callback_data: `sell_100_${pos.id}` },
          ],
        ],
      };

      await this.sendAlert(text, inlineKeyboard);
    }
  }

  private async sendStatusReport(chatId: string | number): Promise<void> {
    const telemetry = db.getSystemTelemetry();
    const solPrice = telemetry.solPriceUsd || 100.0;
    const balanceSol = telemetry.currentPaperBalanceSol || 10.0;
    const balanceUsd = balanceSol * solPrice;
    const realizedSol = telemetry.totalRealizedPnlSol || 0;
    const realizedUsd = realizedSol * solPrice;

    const text = `
<b>⚡ SOLANA COPY BOT STATUS ⚡</b>
<b>Mode:</b> ${telemetry.executionMode}
<b>Balance:</b> $${balanceUsd.toFixed(2)} USD (${balanceSol.toFixed(4)} SOL)
<b>Realized PnL:</b> ${realizedSol >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)} USD (${realizedSol.toFixed(4)} SOL)
<b>Open Positions:</b> ${telemetry.openPositionsCount}
<b>Trades Processed:</b> ${telemetry.totalTradesProcessed}
<b>Median Latency:</b> ${telemetry.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(1)}ms` : '—'}
<b>Circuit Breaker:</b> ${telemetry.circuitBreakerTripped ? '🚨 TRIPPED' : '🟢 ARMED'}
    `.trim();

    await this.sendCustomMessage(chatId, text);
  }

  private async sendCustomMessage(chatId: string | number, text: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch {}
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
      pnlText = `\n<b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(pnlUsd).toFixed(2)} USD (${isProfit ? '+' : ''}${pnlSol.toFixed(4)} SOL)`;
    }

    const text = `
<b>${modeBadge} Trade Executed: ${sideIcon}</b>
<b>Token:</b> <code>${order.tokenMint}</code>
<b>Price:</b> $${fillPriceUsd < 0.01 ? fillPriceUsd.toFixed(7) : fillPriceUsd.toFixed(4)} USD (${fillPriceSol.toFixed(8)} SOL)
<b>Total ${isBuy ? 'Allocated' : 'Received'}:</b> $${usdAmount.toFixed(2)} USD (${solAmount.toFixed(4)} SOL)${pnlText}
<b>Signature:</b> <code>${order.orderSignature || 'N/A'}</code>
    `.trim();

    this.sendAlert(text);
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

    const sym = meta?.symbol || position.tokenMint.substring(0, 6);

    const text = `
<b>💰 MANUAL TAKE PROFIT FILLED (${Math.round(fraction * 100)}%)!</b>
<b>Token:</b> $${sym} (<code>${position.tokenMint}</code>)
<b>Received:</b> +$${usdReceived.toFixed(2)} USD (+${solReceived.toFixed(4)} SOL)
<b>Realized PnL:</b> ${isProfit ? '🟢 +' : '🔴 '}$${Math.abs(realizedUsd).toFixed(2)} USD (${isProfit ? '+' : ''}${realizedSol.toFixed(4)} SOL)
<b>Remaining:</b> ${position.state === 'OPEN' ? `${(Number(position.qtyRaw) / 1e6).toFixed(2)} tokens` : 'CLOSED'}
    `.trim();

    this.sendAlert(text);
  }

  public notifyCircuitBreaker(reason: string): void {
    const text = `
<b>🚨 CIRCUIT BREAKER TRIPPED 🚨</b>
Trading has been paused for safety.
<b>Reason:</b> ${reason}
    `.trim();

    this.sendAlert(text);
  }

  public notifyStartup(): void {
    const text = `
<b>⚡ SOLANA COPY BOT IS NOW LIVE! ⚡</b>
<b>Mode:</b> ${config.EXECUTION_MODE}
<b>Target Wallet:</b> <code>${config.WATCHED_WALLETS[0]}</code>
<b>Sizing:</b> ${config.DEFAULT_SIZING_MODE} (${config.FIXED_BUY_SOL} SOL)
<b>Status:</b> Listening via Helius LaserStream 🟢
<b>Commands:</b> Type /positions to check open trades and take profit!
    `.trim();

    this.sendAlert(text);
  }
}

export const telegramNotifier = new TelegramNotifier();


