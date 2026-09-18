import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  // Environment & Execution
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EXECUTION_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),

  // Live Safety Acknowledgement (MUST match exactly to arm LIVE mode)
  LIVE_TRADING_ACK: z.string().default(''),

  // Solana RPC & Helius Services
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  HELIUS_API_KEY: z.string().default(''),
  HELIUS_WSS_URL: z.string().default('wss://mainnet.helius-rpc.com/?api-key='),
  HELIUS_SENDER_URL: z.string().default(''),
  LASERSTREAM_GRPC_URL: z.string().default(''),

  // Execution Wallet Key (Base58 or JSON byte array) - Strictly isolated backend hot wallet
  FOLLOWER_PRIVATE_KEY: z.string().default(''),

  // Target Wallets to watch (comma-separated list of base58 public keys)
  WATCHED_WALLETS: z
    .string()
    .default('CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS')
    .transform((val) => val.split(',').map((w) => w.trim()).filter(Boolean)),

  // Initial Sizing Defaults (Conservative Mainnet Smoke-Test Configuration)
  DEFAULT_SIZING_MODE: z.enum(['FIXED_SIZE', 'TARGET_NOTIONAL_SCALAR', 'CAPPED_PROPORTIONAL_HYBRID']).default('FIXED_SIZE'),
  FIXED_BUY_SOL: z.coerce.number().default(0.01), // Conservative 0.01 SOL smoke test
  COPY_RATIO: z.coerce.number().default(0.05), // 5% of target spend in scalar mode
  MAX_BUY_SOL: z.coerce.number().default(0.01),

  // Risk & Safety Parameters
  MAX_TOTAL_EXPOSURE_SOL: z.coerce.number().default(0.02),
  MIN_SOL_RESERVE_SOL: z.coerce.number().default(0.02), // Floor reserved for rent and fees (0.02 SOL)
  MAX_SIGNAL_AGE_MS: z.coerce.number().default(1500), // Max ms before signal discarded as stale
  MAX_ENTRY_GAP_BPS: z.coerce.number().default(200), // 2.0% max price deterioration vs target
  MAX_SLIPPAGE_BPS: z.coerce.number().default(150), // 1.5% max AMM slippage
  DAILY_LOSS_LIMIT_SOL: z.coerce.number().default(0.03),
  CONSECUTIVE_ERROR_LIMIT: z.coerce.number().default(5),

  // Jupiter Swap API V2
  JUPITER_API_KEY: z.string().default(''), // Server-side only (never expose to frontend / VITE)

  // Simulation & Smoke-Test Safety Guards
  LIVE_REQUIRE_SIMULATION: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  MAINNET_SMOKE_TEST_MODE: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  SMOKE_TEST_ALLOWED_SIDE: z.enum(['BUY', 'SELL', 'BOTH']).default('BUY'),
  SMOKE_TEST_FORCE_JUPITER: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),

  // Helius Sender Configuration & Tip Validation
  HELIUS_SENDER_MODE: z.enum(['SWQOS', 'MAX']).default('SWQOS'),
  HELIUS_SENDER_TIP_LAMPORTS: z.coerce.number().default(100_000),

  // On-Chain Transaction Compute & Tips
  PRIORITY_FEE_MICRO_LAMPORTS: z.coerce.number().default(50_000), // Compute unit price
  JITO_TIP_LAMPORTS: z.coerce.number().default(100_000), // 0.0001 SOL tip

  // Web Server & Dashboard
  API_PORT: z.coerce.number().default(process.env.PORT ? Number(process.env.PORT) : 3001),
  DASHBOARD_PORT: z.coerce.number().default(3000),
  CONTROL_API_TOKEN: z.string().default(''), // Secret token required for mutating API actions (arm, kill, add wallet)
  HELIUS_WEBHOOK_SECRET: z.string().default(''), // Secret token to verify Helius webhook requests
  CORS_ALLOWED_ORIGINS: z.string().default(''), // Comma-separated allowed CORS origins (empty allows localhost/same-origin)

  // Telegram Notifications (Async off hot path)
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_API_ROOT: z.string().default('https://api.telegram.org'),

  // SQLite Database path
  DB_PATH: z.string().default('./data/copy_bot.db'),

  // Automated Take-Profit & Stop-Loss Engine (Moonbag 2x & Anti-Rug)
  AUTO_TP_ENABLED: z.preprocess((val) => val === 'true' || val === true || val === undefined, z.boolean()).default(true),
  AUTO_TP_GAIN_PCT: z.coerce.number().default(100), // +100% (2x) gain trigger
  AUTO_TP_SELL_FRACTION: z.coerce.number().default(0.5), // Sell 50% on 2x
  AUTO_SL_ENABLED: z.preprocess((val) => val === 'true' || val === true || val === undefined, z.boolean()).default(true),
  AUTO_SL_LOSS_PCT: z.coerce.number().default(50), // -50% loss trigger (anti-rug exit)
  AUTO_EXIT_POLL_INTERVAL_MS: z.coerce.number().default(3000), // 3-second monitoring loop

  // Target Spam & Fast-Finger Guard (Single Entry & Cooldown Guard)
  SINGLE_ENTRY_PER_TOKEN_ENABLED: z.preprocess((val) => val === 'true' || val === true || val === undefined, z.boolean()).default(true),
  TOKEN_BUY_COOLDOWN_SEC: z.coerce.number().default(300), // 5 minutes default cooldown
  NEVER_REBUY_SAME_TOKEN: z.preprocess((val) => val === 'true' || val === true || val === undefined, z.boolean()).default(true), // Lifetime 1-trade max per coin (never rebuy)
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

/**
 * Validates configured tip against Helius Sender mode requirements.
 * Sender MAX requires minimum 0.001 SOL (1,000,000 lamports).
 * SWQOS requires minimum 10,000 lamports.
 */
export function validateHeliusSenderTip(
  mode: 'SWQOS' | 'MAX',
  tipLamports: number
): { valid: boolean; minRequired: number; error?: string } {
  if (mode === 'MAX') {
    const minRequired = 1_000_000; // 0.001 SOL
    if (tipLamports < minRequired) {
      return {
        valid: false,
        minRequired,
        error: `Helius Sender MAX requires a minimum tip of 0.001 SOL (1,000,000 lamports). Configured: ${tipLamports} lamports.`,
      };
    }
    return { valid: true, minRequired };
  } else {
    const minRequired = 10_000;
    if (tipLamports < minRequired) {
      return {
        valid: false,
        minRequired,
        error: `Helius Sender SWQOS requires a minimum tip of 10,000 lamports. Configured: ${tipLamports} lamports.`,
      };
    }
    return { valid: true, minRequired };
  }
}

/**
 * Calculates estimated transaction fees in lamports, clearly distinguishing:
 * - computeUnitPriceMicroLamports (in micro-lamports per CU, 10^-6 lamports)
 * - computeUnitLimit (number of compute units)
 * - estimatedPriorityFeeLamports = (computeUnitPriceMicroLamports * computeUnitLimit) / 1,000,000
 * - baseFeeLamports (5,000 lamports standard Solana base fee)
 * - senderTipLamports (Helius/Jito tip in lamports)
 */
export function calculateEstimatedFeesLamports(
  computeUnitPriceMicroLamports: number | bigint = config.PRIORITY_FEE_MICRO_LAMPORTS,
  computeUnitLimit: number | bigint = 250_000n,
  senderTipLamports: number | bigint = config.HELIUS_SENDER_TIP_LAMPORTS
): {
  baseFeeLamports: bigint;
  computeUnitPriceMicroLamports: bigint;
  computeUnitLimit: bigint;
  estimatedPriorityFeeLamports: bigint;
  senderTipLamports: bigint;
  totalEstimatedFeesLamports: bigint;
} {
  const baseFeeLamports = 5_000n;
  const priceMicro = BigInt(computeUnitPriceMicroLamports);
  const limitUnits = BigInt(computeUnitLimit);
  const tipLamports = BigInt(senderTipLamports);

  // 1 lamport = 1,000,000 micro-lamports
  const estimatedPriorityFeeLamports = (priceMicro * limitUnits) / 1_000_000n;
  const totalEstimatedFeesLamports = baseFeeLamports + estimatedPriorityFeeLamports + tipLamports;

  return {
    baseFeeLamports,
    computeUnitPriceMicroLamports: priceMicro,
    computeUnitLimit: limitUnits,
    estimatedPriorityFeeLamports,
    senderTipLamports: tipLamports,
    totalEstimatedFeesLamports,
  };
}

