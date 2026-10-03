// Deterministic Test Suite Setup
// Ensures tests run completely isolated from operator/production .env values.

process.env.NODE_ENV = 'test';
process.env.DB_PATH = './data/test_copy_bot.db';
process.env.EXECUTION_MODE = 'PAPER';
process.env.FIXED_BUY_SOL = '0.01';
process.env.COPY_RATIO = '0.05';
process.env.MAX_BUY_SOL = '0.01';
process.env.MAX_TOTAL_EXPOSURE_SOL = '0.02';
process.env.MIN_SOL_RESERVE_SOL = '0.02';
process.env.MAX_SIGNAL_AGE_MS = '1500';
process.env.MAX_ENTRY_GAP_BPS = '200';
process.env.MAX_SLIPPAGE_BPS = '200';
process.env.MAX_SELL_SLIPPAGE_BPS = '1500';
process.env.DAILY_LOSS_LIMIT_SOL = '0.03';
process.env.CONSECUTIVE_ERROR_LIMIT = '5';
process.env.SMOKE_TEST_ALLOWED_SIDE = 'BUY';
process.env.MAINNET_SMOKE_TEST_MODE = 'true';
process.env.WATCHED_WALLETS = 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS';
