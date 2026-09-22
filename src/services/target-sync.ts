import fs from 'fs';
import path from 'path';
import { db } from '../db/database.js';
import { WatchedWallet } from '../types/index.js';
import { config } from '../config/index.js';

const BACKUP_FILE = path.resolve(process.cwd(), 'data', 'targets_persistence.json');

export class TargetSyncService {
  private static instance: TargetSyncService;

  private constructor() {
    this.ensureDataDir();
  }

  public static getInstance(): TargetSyncService {
    if (!TargetSyncService.instance) {
      TargetSyncService.instance = new TargetSyncService();
    }
    return TargetSyncService.instance;
  }

  private ensureDataDir(): void {
    const dir = path.dirname(BACKUP_FILE);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
  }

  /**
   * Load targets on startup:
   * 1. If DB already has wallets, ensure backup JSON is in sync.
   * 2. If DB has 0 wallets, check backup JSON file.
   * 3. If backup JSON also empty, seed from config.WATCHED_WALLETS.
   */
  public initializeOnStartup(): void {
    try {
      // 1. Primary: If persistent backup JSON exists, restore all saved wallets into DB
      if (fs.existsSync(BACKUP_FILE)) {
        const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
        const parsed: WatchedWallet[] = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          for (const w of parsed) {
            db.upsertWatchedWallet(w);
          }
          console.info(`[TargetSync] Restored ${parsed.length} target wallet(s) from persistent backup file.`);
        }
      }

      // 2. Also ensure config.WATCHED_WALLETS are registered if not present
      if (config.WATCHED_WALLETS && config.WATCHED_WALLETS.length > 0) {
        for (const walletStr of config.WATCHED_WALLETS) {
          if (walletStr && walletStr.trim()) {
            const cleanW = walletStr.trim();
            if (!db.getWatchedWallet(cleanW)) {
              db.upsertWatchedWallet({
                wallet: cleanW,
                label: 'Target Trader',
                enabled: true,
                buyMode: config.DEFAULT_SIZING_MODE,
                fixedBuyLamports: (config.FIXED_BUY_SOL * 1e9).toString(),
                copyRatio: config.COPY_RATIO,
                maxBuyLamports: (config.MAX_BUY_SOL * 1e9).toString(),
                createdAt: Date.now(),
              });
            }
          }
        }
      }

      const allWallets = db.getWatchedWallets();
      this.saveToFile(allWallets);
    } catch (err) {
      console.warn('[TargetSync] Initialization error:', err);
    }
  }

  /**
   * Sync whenever targets are added, removed, or toggled
   */
  public async syncAll(): Promise<void> {
    const wallets = db.getWatchedWallets();
    this.saveToFile(wallets);
    await this.syncToRailway(wallets);
  }

  private saveToFile(wallets: WatchedWallet[]): void {
    try {
      this.ensureDataDir();
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(wallets, null, 2), 'utf8');
    } catch (err) {
      console.warn('[TargetSync] Failed to write backup file:', err);
    }
  }

  /**
   * Sync active wallets back to Railway environment variables so Railway redeploys never lose them
   */
  private async syncToRailway(wallets: WatchedWallet[]): Promise<void> {
    const token = process.env.RAILWAY_API_TOKEN || 'fc01bb79-cfa5-4ff8-b597-62e1f55307bb';
    const projectId = process.env.RAILWAY_PROJECT_ID || '6a30d60a-bf9c-46ee-8f6a-d2c9ee897457';
    const serviceId = process.env.RAILWAY_SERVICE_ID || 'dd7ab1a3-0f33-44cd-99f6-6f9ee2d0a1b6';
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || 'ef2777b3-ea35-48f8-adbc-471f0240db82';

    if (!token || !projectId || !serviceId) return;

    try {
      const activeAddresses = wallets.filter((w) => w.enabled).map((w) => w.wallet).join(',');
      const query = `
        mutation {
          variableUpsert(input: {
            projectId: "${projectId}",
            environmentId: "${environmentId}",
            serviceId: "${serviceId}",
            name: "WATCHED_WALLETS",
            value: "${activeAddresses}"
          })
        }
      `;

      await fetch('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-blocking background sync
    }
  }
}

export const targetSyncService = TargetSyncService.getInstance();
