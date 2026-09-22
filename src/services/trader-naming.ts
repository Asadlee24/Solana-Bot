import { db } from '../db/database.js';
import { config } from '../config/index.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { targetSyncService } from './target-sync.js';

export interface TraderDisplayInfo {
  address: string;
  short: string;
  label: string;
  displayName: string;
  solscanUrl: string;
  gmgnUrl: string;
  isKnownTrader: boolean;
}

export class TraderNamingService {
  private static instance: TraderNamingService;

  public static getInstance(): TraderNamingService {
    if (!TraderNamingService.instance) {
      TraderNamingService.instance = new TraderNamingService();
    }
    return TraderNamingService.instance;
  }

  /**
   * Shorten a 32-44 char Solana public key
   */
  public shortenAddress(address: string): string {
    if (!address || address.length < 8) return address || 'Unknown';
    return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Find target wallet from past mirror intents or positions by token mint
   */
  public findTargetWalletByMint(mint: string): string | null {
    try {
      // 1. Check positions
      const pos = db.getOpenPositionByMint(mint);
      if (pos && pos.targetWallet && pos.targetWallet !== 'On-Chain Wallet') {
        return pos.targetWallet;
      }

      // 2. Check mirror intents
      const stmt = (db as any).db.prepare(`
        SELECT target_wallet FROM mirror_intents 
        WHERE token_mint = ? AND side = 'BUY' 
        ORDER BY created_at DESC LIMIT 1
      `);
      const row = stmt.get(mint) as any;
      if (row?.target_wallet) {
        return row.target_wallet;
      }
    } catch {}
    return null;
  }

  /**
   * Get detailed trader display info for any wallet address or position/mint
   */
  public getTraderInfo(walletOrMint?: string): TraderDisplayInfo {
    let wallet = (walletOrMint || '').trim();

    // If wallet looks like 'On-Chain Wallet' or is missing, try to resolve by mint
    if (!wallet || wallet === 'On-Chain Wallet') {
      const recovered = walletOrMint ? this.findTargetWalletByMint(walletOrMint) : null;
      if (recovered) {
        wallet = recovered;
      }
    }

    if (!wallet || wallet === 'On-Chain Wallet') {
      return {
        address: 'On-Chain Wallet',
        short: 'Wallet',
        label: 'Manual / Hot Wallet Holding',
        displayName: '💼 Manual / Hot Wallet Holding',
        solscanUrl: `https://solscan.io/account/${executionWalletManager.getPublicKey()?.toBase58() || ''}`,
        gmgnUrl: 'https://gmgn.ai',
        isKnownTrader: false,
      };
    }

    const short = this.shortenAddress(wallet);
    const solscanUrl = `https://solscan.io/account/${wallet}`;
    const gmgnUrl = `https://gmgn.ai/sol/address/${wallet}`;

    // Look up in watched_wallets DB
    const watched = db.getWatchedWallet(wallet);
    if (watched && watched.label && watched.label !== 'Target Trader' && watched.label !== 'Target') {
      return {
        address: wallet,
        short,
        label: watched.label,
        displayName: `🏷️ ${watched.label} (${short})`,
        solscanUrl,
        gmgnUrl,
        isKnownTrader: true,
      };
    }

    // Check index in config.WATCHED_WALLETS
    const indexInConfig = config.WATCHED_WALLETS.indexOf(wallet);
    if (indexInConfig !== -1) {
      const defaultLabel = `Trader #${indexInConfig + 1}`;
      return {
        address: wallet,
        short,
        label: defaultLabel,
        displayName: `🏷️ ${defaultLabel} (${short})`,
        solscanUrl,
        gmgnUrl,
        isKnownTrader: true,
      };
    }

    // General fallback
    return {
      address: wallet,
      short,
      label: watched?.label || `Trader_${short.replace('...', '_')}`,
      displayName: `🏷️ Trader (${short})`,
      solscanUrl,
      gmgnUrl,
      isKnownTrader: Boolean(watched),
    };
  }

  /**
   * Set custom nickname/label for a trader by wallet address OR by 1-based index
   */
  public async setTraderLabel(walletOrIndex: string, newLabel: string): Promise<{ success: boolean; wallet?: string; label?: string; message: string }> {
    const cleanLabel = newLabel.trim();
    if (!cleanLabel) {
      return { success: false, message: 'Label cannot be empty.' };
    }

    const wallets = db.getWatchedWallets();
    let targetWallet: string | null = null;

    // Check if walletOrIndex is a number (e.g. 1, 2, 3...)
    const num = parseInt(walletOrIndex.trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= wallets.length) {
      targetWallet = wallets[num - 1].wallet;
    } else {
      // Find matching wallet address or partial address
      const query = walletOrIndex.trim().toLowerCase();
      const match = wallets.find(
        (w) => w.wallet.toLowerCase() === query || w.wallet.toLowerCase().startsWith(query)
      );
      if (match) {
        targetWallet = match.wallet;
      }
    }

    if (!targetWallet) {
      return {
        success: false,
        message: `Trader "${walletOrIndex}" not found. You have ${wallets.length} watched traders. Use 1 to ${wallets.length} or the wallet address.`,
      };
    }

    const existing = db.getWatchedWallet(targetWallet);
    if (existing) {
      existing.label = cleanLabel;
      db.upsertWatchedWallet(existing);
      await targetSyncService.syncAll();
      return {
        success: true,
        wallet: targetWallet,
        label: cleanLabel,
        message: `Successfully renamed trader to "🏷️ ${cleanLabel}" (${this.shortenAddress(targetWallet)})!`,
      };
    }

    return { success: false, message: 'Failed to update trader label.' };
  }
}

export const traderNamingService = TraderNamingService.getInstance();
