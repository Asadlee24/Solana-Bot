# Production Release & Pre-Flight Checklist

This checklist must be strictly completed and signed off prior to deploying or switching any instance to `EXECUTION_MODE=LIVE`.

---

## 1. Safety & Mode Verification
- [ ] **Default Safe Mode:** Verify `EXECUTION_MODE=PAPER` upon initial startup.
- [ ] **Disarmed by Default:** Ensure the bot starts with the execution engine in `PAUSED` / `DISARMED` state. No trades should be copied automatically until an explicit operator action (`/arm` or Dashboard Activate).
- [ ] **Acknowledgement Mandatory:** Ensure `LIVE_TRADING_ACK=I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK` is configured in production `.env` before attempting to arm in `LIVE` mode.
- [ ] **Smoke Test Guard Active:** Confirm `MAINNET_SMOKE_TEST_MODE=true` for initial run to enforce single-trade auto-disarm.
- [ ] **Dedicated Hot Wallet:** Confirm `FOLLOWER_PRIVATE_KEY` belongs to a dedicated burner/smoke-test wallet, **never** a personal treasury or cold storage account.

---

## 2. Cryptographic & API Security
- [ ] **Control API Authentication:**
  - [ ] `CONTROL_API_TOKEN` is set with a high-entropy secret (`openssl rand -hex 24`).
  - [ ] `ALLOW_UNAUTHENTICATED_CONTROL` is explicitly set to `false`.
  - [ ] Mutating routes (`/api/live/arm`, `/api/live/kill`, `/api/positions/:id/sell`, `/api/wallets`, `/api/circuit-breaker/reset`) reject unauthorized requests with HTTP `401`.
- [ ] **Helius Webhook Authentication:**
  - [ ] `HELIUS_WEBHOOK_SECRET` is set in both Helius portal and `.env`.
  - [ ] `ALLOW_UNAUTHENTICATED_WEBHOOK` is set to `false`.
  - [ ] Unauthenticated incoming webhooks fail closed with HTTP `503` (if secret missing) or `401` (if signature mismatch).
- [ ] **CORS Hardening:**
  - [ ] In production, `CORS_ALLOWED_ORIGINS` is configured with the exact operator domain(s) or left restricted to prevent unauthorized cross-origin requests.
- [ ] **Telegram Authorization:**
  - [ ] Developer backdoors and hardcoded chat IDs are removed.
  - [ ] Operator account is paired via `/pair <setup_code>` or explicitly whitelisted in `TELEGRAM_CHAT_ID`.

---

## 3. Financial & Accounting Correctness
- [ ] **Zero Synthetic Metrics:**
  - [ ] Win rate is calculated strictly from settled positions in SQLite via `db.getAccountingSummary()`.
  - [ ] Total trades closed is derived from recorded database entries.
  - [ ] Fake hardcoded metrics (e.g. `100.0%`, `4 trades`) are purged.
- [ ] **Solana Price Sourcing:**
  - [ ] SOL price is dynamically retrieved from live DEX feeds or configured fallback. No hardcoded `$100`/`$140` assumptions.
- [ ] **Decimal Safety:**
  - [ ] Token decimals for trading and accounting are strictly verified on-chain. Unverified tokens reject execution in live mode.
- [ ] **Deposit/Withdrawal Isolation:**
  - [ ] PnL accounting tracks realized and unrealized token position settlements. Wallet balance fluctuations from deposits or withdrawals do not inflate trading PnL.
- [ ] **Terminology Compliance:**
  - [ ] All misleading guarantees ("Zero-Loss Guarantee", "Never Lose") are replaced with financial terms ("Breakeven Protection Floor", "Dynamic Trailing Stop").

---

## 4. Pre-Trade Risk Engine & Limits
- [ ] **Sizing Bounds:**
  - [ ] `FIXED_BUY_SOL` is set conservatively (e.g. `0.01` SOL).
  - [ ] `MAX_BUY_SOL` equals or caps `FIXED_BUY_SOL`.
- [ ] **Reserve & Loss Caps:**
  - [ ] `MIN_SOL_RESERVE_SOL` is at least `0.02` SOL (reserved for Solana rent & gas).
  - [ ] `MAX_TOTAL_EXPOSURE_SOL` is defined and within risk tolerance.
  - [ ] `DAILY_LOSS_LIMIT_SOL` is set to stop further trading if daily drawdowns occur.
  - [ ] `CONSECUTIVE_ERROR_LIMIT` is set (default: `5`) to trigger the circuit breaker on network instability.
- [ ] **Slippage & Entry Gap:**
  - [ ] `MAX_ENTRY_GAP_BPS` is set to `200` (2.0%) to reject front-run or drifted prices.
  - [ ] `MAX_SLIPPAGE_BPS` is set to `200` (2.0%).
  - [ ] `MAX_SELL_SLIPPAGE_BPS` is configured for emergency exits (`1500` bps = 15.0%).

---

## 5. Storage & Database Persistence
- [ ] **SQLite WAL Mode:** Confirm `PRAGMA journal_mode = WAL` and `busy_timeout = 5000` are active.
- [ ] **Schema Migrations:** Confirm `schema_migrations` table is applied without schema errors.
- [ ] **Container Volume Mounts:**
  - [ ] Docker: `VOLUME ["/app/data"]` declared and volume mounted (`-v bot-data:/app/data`).
  - [ ] Render: Persistent disk attached and mounted at `/app/data`.
  - [ ] Railway: Volume attached to `/app/data`.
- [ ] **Backup Verification:**
  - [ ] Run `npm run db:backup` and verify backup file is generated in `backups/`.
  - [ ] Verify `npm run db:restore` documentation is accessible to operators.

---

## 6. Build & Pre-Deployment Verification
- [ ] **TypeScript Typecheck:** `npx tsc --noEmit` exits with code 0.
- [ ] **Automated Test Suite:** `npm test` passes 100% green.
- [ ] **Dashboard Build:** `npm run dashboard:build` generates production assets without errors.
- [ ] **Server Build:** `npm run build:server` compiles server code.
- [ ] **Secret Scan:** Confirm no private keys or API keys are committed in git history.
- [ ] **Container Build:** `docker build -t solana-copy-bot:release .` passes without errors.

---

## 7. Emergency Incident Procedures
- [ ] **Telegram Emergency Stop:** Operator knows `/kill` immediately halts all trading.
- [ ] **Dashboard Emergency Stop:** Operator knows Kill Switch in Topbar immediately halts all trading.
- [ ] **Manual Position Exit:** Operator knows how to execute `/sell 100%` or use dashboard manual exit buttons.
