import fs from 'fs';
import path from 'path';
import { db } from '../db/database.js';
import { config } from '../config/index.js';
import { executionWalletManager } from '../execution/wallet-manager.js';
import { tokenMetadataService } from './token-metadata.js';
import { mintDecimalsService } from './mint-decimals.js';
import { FollowerPosition } from '../types/index.js';

const PERSISTENCE_FILE = path.resolve('data/positions_persistence.json');

export class PositionSyncService {
  /**
   * Persist current open positions to disk so restarts/redeployments never lose cost basis or entry prices
   */
  public async persistOpenPositions(): Promise<void> {
    try {
      const open = db.getOpenPositions().filter((p) => p.state === 'OPEN' && BigInt(p.qtyRaw) > 0n);
      const dir = path.dirname(PERSISTENCE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(open, null, 2), 'utf-8');
    } catch (err: any) {
      console.warn('[PositionSync] Failed to persist open positions to disk:', err?.message || err);
    }
  }

  /**
   * Run once on bot startup:
   * 1. Restore persistent positions from JSON into SQLite if DB was wiped by ephemeral container.
   * 2. In LIVE mode, cross-reference with real on-chain token balances in execution wallet.
   * 3. Sync accurate cost basis, entry prices, and clean up closed/zero-balance tokens.
   */
  public async initializeOnStartup(): Promise<void> {
    try {
      // 1. Load persistent file if available
      if (fs.existsSync(PERSISTENCE_FILE)) {
        try {
          const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
          const savedPositions: FollowerPosition[] = JSON.parse(raw);
          if (Array.isArray(savedPositions) && savedPositions.length > 0) {
            for (const pos of savedPositions) {
              const existing = db.getOpenPositionByMint(pos.tokenMint);
              if (!existing && pos.state === 'OPEN' && BigInt(pos.qtyRaw) > 0n) {
                db.savePosition(pos);
              }
            }
            console.info(`[PositionSync] Restored ${savedPositions.length} persistent position(s) from disk into database.`);
          }
        } catch (e: any) {
          console.warn('[PositionSync] Could not parse positions_persistence.json:', e?.message || e);
        }
      }

      // 2. In LIVE mode: Reconcile directly with on-chain wallet tokens
      if (config.EXECUTION_MODE === 'LIVE') {
        const held = await executionWalletManager.getHeldTokensWithAmounts();
        const openInDb = db.getOpenPositions();
        const activeMints = new Set<string>();

        for (const item of held) {
          // Skip native SOL and known spam mints
          if (
            item.mint === '9aaDsN9KkSy9q3LmAwhXiJF75veH4wsbEFkJXqMH54VW' ||
            item.mint === 'So11111111111111111111111111111111111111112'
          ) {
            continue;
          }

          activeMints.add(item.mint);
          let existing = db.getOpenPositionByMint(item.mint);

          const decimals = await mintDecimalsService.getDecimals(item.mint);
          const tokenQty = Number(item.amountRaw) / (10 ** decimals);

          if (!existing) {
            // Find any past BUY order in DB
            const orders = db.getRecentOrders(100);
            const buyOrder = orders.find(
              (o) => o.token_mint === item.mint && o.side === 'BUY' && (o.status === 'FILLED' || o.status === 'LANDED' || o.status === 'CONFIRMED')
            );

            const meta = await tokenMetadataService.getTokenMetadata(item.mint);
            const currentSpotPriceSol = meta?.priceSol || 0;

            let costBasisLamports = '50000000'; // Default to standard 0.05 SOL buy size
            let avgEntryPriceSol = tokenQty > 0 ? (Number(costBasisLamports) / 1e9) / tokenQty : currentSpotPriceSol;

            if (buyOrder) {
              costBasisLamports = buyOrder.actualInAmountRaw || buyOrder.in_amount_raw || costBasisLamports;
              avgEntryPriceSol = buyOrder.actualExecutionPrice || buyOrder.effective_price || avgEntryPriceSol;
            }

            const newPos: FollowerPosition = {
              id: `onchain_${item.mint}`,
              targetWallet: buyOrder?.target_signature || 'On-Chain Wallet',
              tokenMint: item.mint,
              qtyRaw: item.amountRaw,
              costBasisLamports,
              avgEntryPriceSol,
              realizedPnlLamports: '0',
              unrealizedPnlLamports: '0',
              state: 'OPEN',
              openedAt: Date.now(),
              updatedAt: Date.now(),
              closedAt: undefined,
              tp1Triggered: false,
              peakPnlPct: 0,
            };

            db.savePosition(newPos);
            console.info(`[PositionSync] Synchronized live on-chain holding for ${item.mint} (Qty: ${tokenQty}, Cost: ${(Number(costBasisLamports)/1e9).toFixed(4)} SOL).`);
          } else {
            // Update token quantity with ground-truth on-chain balance
            existing.qtyRaw = item.amountRaw;
            // Ensure cost basis is non-zero
            if (!existing.costBasisLamports || existing.costBasisLamports === '0') {
              existing.costBasisLamports = Math.round((config.FIXED_BUY_SOL || 0.05) * 1e9).toString();
              if (!existing.avgEntryPriceSol || existing.avgEntryPriceSol <= 0) {
                existing.avgEntryPriceSol = tokenQty > 0 ? (Number(existing.costBasisLamports) / 1e9) / tokenQty : 0;
              }
            }
            existing.state = 'OPEN';
            existing.updatedAt = Date.now();
            db.savePosition(existing);
          }
        }

        // Close any position in DB that is no longer held on-chain
        for (const pos of openInDb) {
          if (!activeMints.has(pos.tokenMint)) {
            pos.state = 'CLOSED';
            pos.qtyRaw = '0';
            pos.closedAt = Date.now();
            pos.updatedAt = Date.now();
            db.savePosition(pos);
          }
        }
      }

      await this.persistOpenPositions();
    } catch (err: any) {
      console.warn('[PositionSync] Error during position startup sync:', err?.message || err);
    }
  }
}

export const positionSyncService = new PositionSyncService();
