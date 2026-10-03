import fs from 'fs';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58Module from 'bs58';
import { CANONICAL_LIVE_TRADING_ACK, config } from '../config/index.js';
import { db } from '../db/database.js';

const bs58Decode = (
  typeof (bs58Module as any).decode === 'function'
    ? (bs58Module as any).decode
    : (bs58Module as any).default?.decode
) as (input: string) => Uint8Array;

export type ReadinessLevel = 'READY' | 'WARNING' | 'BLOCKED';

export interface ReadinessCheckItem {
  category: 'NETWORK' | 'EXECUTION' | 'SECURITY' | 'STORAGE' | 'STRATEGY';
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  criticalForLive: boolean;
}

export interface ReadinessReport {
  overallStatus: ReadinessLevel;
  executionMode: 'PAPER' | 'LIVE';
  canStart: boolean;
  checks: ReadinessCheckItem[];
  timestamp: number;
}

export class ReadinessValidator {
  public validate(): ReadinessReport {
    const checks: ReadinessCheckItem[] = [];
    const isLive = config.EXECUTION_MODE === 'LIVE';

    // 1. Solana RPC URL
    try {
      const url = new URL(config.SOLANA_RPC_URL);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        checks.push({
          category: 'NETWORK',
          name: 'Solana RPC URL',
          status: 'PASS',
          message: `Configured (${url.host})`,
          criticalForLive: true,
        });
      } else {
        checks.push({
          category: 'NETWORK',
          name: 'Solana RPC URL',
          status: 'FAIL',
          message: `Invalid protocol: ${url.protocol}`,
          criticalForLive: true,
        });
      }
    } catch {
      checks.push({
        category: 'NETWORK',
        name: 'Solana RPC URL',
        status: 'FAIL',
        message: 'Malformed or missing SOLANA_RPC_URL',
        criticalForLive: true,
      });
    }

    // 2. Execution Hot Wallet Cryptography
    const privateKeyRaw = config.FOLLOWER_PRIVATE_KEY?.trim() || '';
    if (isLive) {
      if (!privateKeyRaw) {
        checks.push({
          category: 'EXECUTION',
          name: 'Execution Hot Wallet',
          status: 'FAIL',
          message: 'FOLLOWER_PRIVATE_KEY is required in LIVE mode but is empty',
          criticalForLive: true,
        });
      } else {
        let valid = false;
        try {
          if (privateKeyRaw.startsWith('[') && privateKeyRaw.endsWith(']')) {
            const bytes = JSON.parse(privateKeyRaw);
            if (Array.isArray(bytes) && (bytes.length === 64 || bytes.length === 32)) {
              Keypair.fromSecretKey(Uint8Array.from(bytes));
              valid = true;
            }
          } else {
            const decoded = bs58Decode(privateKeyRaw);
            if (decoded && (decoded.length === 64 || decoded.length === 32)) {
              Keypair.fromSecretKey(decoded);
              valid = true;
            }
          }
        } catch {}

        if (valid) {
          checks.push({
            category: 'EXECUTION',
            name: 'Execution Hot Wallet',
            status: 'PASS',
            message: 'Cryptographically valid Solana keypair loaded',
            criticalForLive: true,
          });
        } else {
          checks.push({
            category: 'EXECUTION',
            name: 'Execution Hot Wallet',
            status: 'FAIL',
            message: 'FOLLOWER_PRIVATE_KEY is not a valid 64-byte or 32-byte secret key',
            criticalForLive: true,
          });
        }
      }
    } else {
      checks.push({
        category: 'EXECUTION',
        name: 'Execution Hot Wallet',
        status: 'PASS',
        message: 'PAPER mode simulation (no private key needed)',
        criticalForLive: false,
      });
    }

    // 3. Live Trading Safety Acknowledgement
    if (isLive) {
      if (config.LIVE_TRADING_ACK === CANONICAL_LIVE_TRADING_ACK) {
        checks.push({
          category: 'EXECUTION',
          name: 'Live Trading Acknowledgement',
          status: 'PASS',
          message: 'Explicit safety acknowledgement confirmed',
          criticalForLive: true,
        });
      } else {
        checks.push({
          category: 'EXECUTION',
          name: 'Live Trading Acknowledgement',
          status: 'FAIL',
          message:
            `Missing or incorrect LIVE_TRADING_ACK. Must equal "${CANONICAL_LIVE_TRADING_ACK}"`,
          criticalForLive: true,
        });
      }
    }

    // 4. API Authentication Token
    if (config.CONTROL_API_TOKEN && config.CONTROL_API_TOKEN.trim().length >= 16) {
      checks.push({
        category: 'SECURITY',
        name: 'Control API Auth Token',
        status: 'PASS',
        message: 'Cryptographic control token configured (>= 16 chars)',
        criticalForLive: isLive,
      });
    } else if (config.ALLOW_UNAUTHENTICATED_CONTROL) {
      checks.push({
        category: 'SECURITY',
        name: 'Control API Auth Token',
        status: isLive ? 'FAIL' : 'WARN',
        message: 'ALLOW_UNAUTHENTICATED_CONTROL is active (DANGEROUS for live deployments)',
        criticalForLive: isLive,
      });
    } else {
      checks.push({
        category: 'SECURITY',
        name: 'Control API Auth Token',
        status: isLive ? 'FAIL' : 'WARN',
        message: 'CONTROL_API_TOKEN is empty; mutating API endpoints will fail closed (401)',
        criticalForLive: isLive,
      });
    }

    // 5. Helius Webhook Authentication
    if (config.HELIUS_WEBHOOK_SECRET && config.HELIUS_WEBHOOK_SECRET.trim().length >= 10) {
      checks.push({
        category: 'SECURITY',
        name: 'Helius Webhook Secret',
        status: 'PASS',
        message: 'Authenticated webhook secret configured',
        criticalForLive: false,
      });
    } else if (config.ALLOW_UNAUTHENTICATED_WEBHOOK) {
      checks.push({
        category: 'SECURITY',
        name: 'Helius Webhook Secret',
        status: 'WARN',
        message: 'ALLOW_UNAUTHENTICATED_WEBHOOK is true (development mode)',
        criticalForLive: false,
      });
    } else {
      checks.push({
        category: 'SECURITY',
        name: 'Helius Webhook Secret',
        status: 'WARN',
        message: 'HELIUS_WEBHOOK_SECRET is unset; webhook endpoint returns 503 until set',
        criticalForLive: false,
      });
    }

    // 6. Sizing & Risk Controls
    if (config.FIXED_BUY_SOL > 0 && config.MAX_BUY_SOL >= config.FIXED_BUY_SOL) {
      checks.push({
        category: 'STRATEGY',
        name: 'Order Sizing Bounds',
        status: 'PASS',
        message: `Fixed: ${config.FIXED_BUY_SOL} SOL | Max: ${config.MAX_BUY_SOL} SOL`,
        criticalForLive: true,
      });
    } else {
      checks.push({
        category: 'STRATEGY',
        name: 'Order Sizing Bounds',
        status: 'FAIL',
        message: `Invalid bounds: FIXED_BUY_SOL (${config.FIXED_BUY_SOL}) must be > 0 and <= MAX_BUY_SOL (${config.MAX_BUY_SOL})`,
        criticalForLive: true,
      });
    }

    if (config.MIN_SOL_RESERVE_SOL >= 0.01) {
      checks.push({
        category: 'STRATEGY',
        name: 'Fee Reserve Floor',
        status: 'PASS',
        message: `Reserve floor: ${config.MIN_SOL_RESERVE_SOL} SOL`,
        criticalForLive: true,
      });
    } else {
      checks.push({
        category: 'STRATEGY',
        name: 'Fee Reserve Floor',
        status: 'WARN',
        message: `MIN_SOL_RESERVE_SOL (${config.MIN_SOL_RESERVE_SOL}) is below recommended 0.01 SOL`,
        criticalForLive: false,
      });
    }

    // 7. Watched Target Wallets
    try {
      const dbWallets = db.getWatchedWallets();
      const totalWallets = new Set([...config.WATCHED_WALLETS, ...dbWallets.map((w) => w.wallet)])
        .size;
      if (totalWallets > 0) {
        checks.push({
          category: 'STRATEGY',
          name: 'Target Wallets',
          status: 'PASS',
          message: `${totalWallets} target wallet(s) registered`,
          criticalForLive: false,
        });
      } else {
        checks.push({
          category: 'STRATEGY',
          name: 'Target Wallets',
          status: 'WARN',
          message: '0 target wallets registered. Bot will idle until a wallet is added.',
          criticalForLive: false,
        });
      }
    } catch {
      checks.push({
        category: 'STRATEGY',
        name: 'Target Wallets',
        status: 'WARN',
        message: 'Could not query target wallets from DB',
        criticalForLive: false,
      });
    }

    // 8. Storage Directory & Persistence
    const dbDir = path.dirname(path.resolve(config.DB_PATH));
    try {
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      fs.accessSync(dbDir, fs.constants.W_OK);
      checks.push({
        category: 'STORAGE',
        name: 'SQLite Storage Directory',
        status: 'PASS',
        message: `Writable (${dbDir})`,
        criticalForLive: true,
      });
    } catch (err: any) {
      checks.push({
        category: 'STORAGE',
        name: 'SQLite Storage Directory',
        status: 'FAIL',
        message: `Database directory not writable (${dbDir}): ${err.message}`,
        criticalForLive: true,
      });
    }

    // Determine overall status
    const hasCriticalFail = checks.some((c) => c.status === 'FAIL' && (isLive || c.criticalForLive));
    const hasWarnings = checks.some((c) => c.status === 'WARN');

    let overallStatus: ReadinessLevel = 'READY';
    let canStart = true;

    if (hasCriticalFail) {
      overallStatus = 'BLOCKED';
      canStart = !isLive; // In PAPER mode, non-fatal to allow simulation testing
    } else if (hasWarnings) {
      overallStatus = 'WARNING';
    }

    return {
      overallStatus,
      executionMode: config.EXECUTION_MODE,
      canStart,
      checks,
      timestamp: Date.now(),
    };
  }

  public logReport(report: ReadinessReport): void {
    const symbol =
      report.overallStatus === 'READY'
        ? '🟢 READY'
        : report.overallStatus === 'WARNING'
        ? '🟡 WARNING'
        : '🔴 BLOCKED';

    console.info('\n=============================================================');
    console.info(`  STARTUP READINESS REPORT: ${symbol} [${report.executionMode} MODE]`);
    console.info('=============================================================');
    for (const check of report.checks) {
      const icon = check.status === 'PASS' ? '✅' : check.status === 'WARN' ? '⚠️' : '❌';
      console.info(`  ${icon} [${check.category}] ${check.name.padEnd(28)} : ${check.message}`);
    }
    console.info('=============================================================\n');
  }
}

export const readinessValidator = new ReadinessValidator();
