import { config } from '../config/index.js';
import { FollowerPosition, MirrorOrder } from '../types/index.js';

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.enabled = Boolean(this.botToken && this.chatId);
  }

  /**
   * Non-blocking send alert off hot path
   */
  public async sendAlert(text: string): Promise<void> {
    if (!this.enabled) return;

    // Fire and forget, catch any network errors
    setImmediate(async () => {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
      } catch (err) {
        console.warn('[Telegram Alert Failed]:', err);
      }
    });
  }

  public notifyTradeFilled(order: MirrorOrder, position?: FollowerPosition): void {
    const isBuy = order.side === 'BUY';
    const sideIcon = isBuy ? '🟢 BUY' : '🔴 SELL';
    const modeBadge = order.mode === 'PAPER' ? '📝 [PAPER]' : '⚡ [LIVE]';

    const text = `
<b>${modeBadge} Trade Executed: ${sideIcon}</b>
<b>Token:</b> <code>${order.tokenMint}</code>
<b>Side:</b> ${order.side}
<b>Fill Price:</b> ${order.effectivePrice.toFixed(8)} SOL
<b>In Amount:</b> ${order.inAmountRaw}
<b>Out Amount:</b> ${order.outAmountRaw}
<b>Signature:</b> <code>${order.orderSignature || 'N/A'}</code>
${position ? `<b>Realized PnL:</b> ${(Number(position.realizedPnlLamports) / 1e9).toFixed(4)} SOL` : ''}
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
}

export const telegramNotifier = new TelegramNotifier();
