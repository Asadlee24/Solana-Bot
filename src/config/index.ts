import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  // Environment & Execution
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EXECUTION_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),

  // Solana RPC & Helius Services
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  HELIUS_API_KEY: z.string().default(''),
  HELIUS_WSS_URL: z.string().default('wss://mainnet.helius-rpc.com/?api-key='),
  LASERSTREAM_GRPC_URL: z.string().default(''),

  // Execution Wallet Key (Base58 or JSON byte array) - Optional for paper mode
  FOLLOWER_PRIVATE_KEY: z.string().default(''),

  // Target Wallets to watch (comma-separated list of base58 public keys)
  WATCHED_WALLETS: z
    .string()
    .default('CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS')
    .transform((val) => val.split(',').map((w) => w.trim()).filter(Boolean)),

  // Sizing Defaults
  DEFAULT_SIZING_MODE: z.enum(['FIXED_SIZE', 'TARGET_NOTIONAL_SCALAR', 'CAPPED_PROPORTIONAL_HYBRID']).default('FIXED_SIZE'),
  FIXED_BUY_SOL: z.coerce.number().default(0.1), // ~20 USD equivalent
  COPY_RATIO: z.coerce.number().default(0.05), // 5% of target spend in scalar mode
  MAX_BUY_SOL: z.coerce.number().default(1.0),

  // Risk & Safety Parameters
  MAX_TOTAL_EXPOSURE_SOL: z.coerce.number().default(5.0),
  MIN_SOL_RESERVE_SOL: z.coerce.number().default(0.2), // Always preserve for fees/rent
  MAX_SIGNAL_AGE_MS: z.coerce.number().default(1500), // Max ms before signal discarded as stale
  MAX_ENTRY_GAP_BPS: z.coerce.number().default(200), // 2.0% max price deterioration vs target
  MAX_SLIPPAGE_BPS: z.coerce.number().default(150), // 1.5% max AMM slippage
  DAILY_LOSS_LIMIT_SOL: z.coerce.number().default(2.0),
  CONSECUTIVE_ERROR_LIMIT: z.coerce.number().default(5),

  // Web Server & Dashboard
  API_PORT: z.coerce.number().default(3001),
  DASHBOARD_PORT: z.coerce.number().default(3000),

  // Telegram Notifications (Async off hot path)
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_API_ROOT: z.string().default('https://api.telegram.org'),

  // SQLite Database path
  DB_PATH: z.string().default('./data/copy_bot.db'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let parsedConfig: AppConfig;
try {
  parsedConfig = ConfigSchema.parse(process.env);
} catch (error) {
  console.error('Invalid environment configuration:', error);
  throw error;
}

export const config = parsedConfig;

// Convert SOL amounts to raw lamports (1 SOL = 1,000,000,000 Lamports)
export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;

export function solToLamportsBigInt(sol: number): bigint {
  return BigInt(Math.floor(sol * 1_000_000_000));
}

export function lamportsToSol(lamports: bigint | string | number): number {
  return Number(lamports) / 1_000_000_000;
}
