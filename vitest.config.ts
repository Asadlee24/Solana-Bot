import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    setupFiles: ['./test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DB_PATH: './data/test_copy_bot.db',
      EXECUTION_MODE: 'PAPER',
      FIXED_BUY_SOL: '0.01',
      COPY_RATIO: '0.05',
      MAX_BUY_SOL: '0.01',
      MAX_TOTAL_EXPOSURE_SOL: '0.02',
      MIN_SOL_RESERVE_SOL: '0.02',
      MAX_SIGNAL_AGE_MS: '1500',
      MAX_ENTRY_GAP_BPS: '200',
      MAX_SLIPPAGE_BPS: '200',
      MAX_SELL_SLIPPAGE_BPS: '1500',
      DAILY_LOSS_LIMIT_SOL: '0.03',
      CONSECUTIVE_ERROR_LIMIT: '5',
      SMOKE_TEST_ALLOWED_SIDE: 'BUY',
      MAINNET_SMOKE_TEST_MODE: 'true',
      WATCHED_WALLETS: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
    },
  },
});
