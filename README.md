# Low Latency Solana Copy-Trading Bot & Copyability Evaluation Suite (MVP 2026)

A production-ready, low-latency Solana copy-trading bot and telemetry platform. Built for high-frequency signal ingestion, deterministic pre-trade risk controls, automated profit/loss exits, and real-time observability.

---

## Key Highlights

- **Multi-Feed Ingestion:** Ingests target transactions from Helius WebSocket feeds (Preconfirmations / Preprocessed) and HTTP webhooks with sub-millisecond deduplication.
- **DEX & Protocol Coverage:** Supports Pump.fun bonding curves, Raydium (AMM v4, CPMM, CLMM), Jupiter Swap API V2 (`/order` + `/execute`), and Orca.
- **Fail-Closed Security Architecture:** Mutating API endpoints require cryptographic bearer/header authentication. Webhooks fail closed on invalid or missing secrets. Developer backdoors have been completely removed in favor of secure single-use Telegram pairing codes (`/pair <code>`).
- **Real Settlement Accounting:** Realized and unrealized PnL is derived strictly from on-chain position settlements in SQLite. Deposits and withdrawals do not distort trading metrics. All fake metrics and artificial guarantees have been purged.
- **Automated Exit Engine:**
  - **Moonbag 2x Take-Profit:** Automatically locks in original capital at +100% gain while letting 50% ride.
  - **Anti-Rug Emergency Stop-Loss:** Immediate 100% cut if a token drops below the safety floor (default: -30%).
  - **Breakeven Protection Floor:** Automatically ratchets the stop-loss to entry price (+2% cushion) when profit exceeds +20%.
  - **Dynamic Trailing Stop-Loss:** Trails peak profit by a configurable cushion (default: 15%) once gains cross +30%.
- **Zero-Latency Persistence:** SQLite in Write-Ahead Logging (`WAL`) mode with `busy_timeout=5000` and automated schema migrations.
- **Obsidian Glassmorphic Dashboard:** Built-in React + Vite operator dashboard with live order streams, entry gap histograms, position tracking, and kill-switch controls.

---

## Quick Start (Safe Default Setup)

By default, the bot initializes in **`PAPER` simulation mode** and remains **`DISARMED`**. No real funds are ever spent upon initial launch.

### 1. Prerequisites
- **Node.js:** v20.x or v22.x LTS
- **Solana RPC:** A reliable RPC endpoint (Helius recommended)
- **Telegram Bot (Optional but recommended):** A bot token from [@BotFather](https://t.me/botfather)

### 2. Installation
```bash
git clone https://github.com/Asadlee24/Solana-Bot.git
cd Solana-Bot
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your credentials:
```env
# Default starts in PAPER simulation
EXECUTION_MODE=PAPER

# Solana RPC & Helius API
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=your_helius_api_key_here
# Enhanced WSS (Developer+ plans): wss://atlas-mainnet.helius-rpc.com/?api-key=...
# Standard WSS (Free plan fallback): wss://mainnet.helius-rpc.com/?api-key=...
HELIUS_WSS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=your_helius_api_key_here

# Watched Target Wallets (comma-separated base58 public keys)
WATCHED_WALLETS=CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS

# Security Tokens (Generate with: openssl rand -hex 24)
CONTROL_API_TOKEN=your_secure_random_control_token_here
HELIUS_WEBHOOK_SECRET=your_secure_webhook_secret_here

# Telegram Notifications & Pairing
TELEGRAM_BOT_TOKEN=your_bot_father_token_here
TELEGRAM_PAIRING_CODE=secret12345
```

### 4. Build and Run
```bash
# Build dashboard assets and TypeScript
npm run dashboard:build
npm run build:server

# Start the bot
npm run dev
```

The web dashboard is accessible at: `http://localhost:3000`  
The REST and SSE backend runs at: `http://localhost:3001`

---

## Deployment Options

### Option A: Docker Compose (Recommended for VPS / Cloud)
A production `docker-compose.yml` with named persistent volume storage is provided:

```bash
# Start container with automatic restart and persistent SQLite storage
docker compose up -d --build

# View real-time logs
docker compose logs -f
```
The SQLite database is safely persisted in the named Docker volume `solana-copy-bot-data` (`/app/data`).

### Option B: Render Deployment
A `render.yaml` specification is included. It attaches a persistent SSD disk (`/app/data`) to preserve database state between redeploys:
1. Connect your GitHub repository to Render.
2. Render automatically detects `render.yaml`.
3. Fill in secret environment variables in the Render dashboard.

### Option C: Railway Deployment
Railway uses the root `Dockerfile` and `railway.json`:
1. Create a project on Railway and connect your repository.
2. **Critical Step:** In Railway Service Settings, manually add a **Persistent Volume** mounted at `/app/data` (Railway's config schema does not support automated volume creation; without this volume, SQLite state is lost on redeployment).
3. Set your environment variables in the Railway dashboard.

---

## Telegram Pairing & Operations

To prevent unauthorized access, developer backdoors have been completely removed. Operator access is authorized via a one-time setup code:

1. Configure `TELEGRAM_PAIRING_CODE=my_secret_code_987` in `.env`.
2. Open your Telegram bot and send:
   ```
   /pair my_secret_code_987
   ```
3. Your chat ID is automatically authorized and persisted securely in the database.
4. Subsequent commands are now fully operational:

| Command | Description |
|---|---|
| `/status` | View real-time bot health, execution mode, and active wallet balances |
| `/pnl` | View real settlement realized PnL, open floating PnL, and win rate |
| `/targets` | View and manage registered target wallets |
| `/score <wallet>` | Run automated win-rate and copyability score on a trader wallet |
| `/tpsl` | View and toggle Take-Profit (+100%), Stop-Loss (-30%), and Breakeven Floor |
| `/arm` | Activate automated live execution (requires acknowledgement in LIVE mode) |
| `/kill` | Instant emergency kill switch — disarms live execution immediately |
| `/sell 50%` | Execute manual partial exit on an open position |
| `/sell 100%` | Execute manual complete exit on an open position |

---

## Database Management & Backups

The bot uses SQLite in high-concurrency WAL mode (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`).

### Online Database Backup
To create a live, lock-free snapshot while the bot is actively running:
```bash
npm run db:backup
```
Backups are saved to `backups/solana_copy_bot_<timestamp>.db`.

### Database Restore
To restore from a previous backup:
```bash
npm run db:restore backups/solana_copy_bot_<timestamp>.db
```
The restore script automatically creates a `.pre-restore` safety backup of your existing database before overwriting.

---

## Going Live Safely

Before enabling real capital execution (`EXECUTION_MODE=LIVE`), complete every item in:
👉 **[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)**

Mandatory live mode safeguards:
1. **Dedicated Hot Wallet:** Only use a dedicated burner keypair with minimal SOL.
2. **Explicit Acknowledgement:** Set `LIVE_TRADING_ACK=I_UNDERSTAND_REAL_FUNDS_ARE_AT_RISK` in `.env`.
3. **Smoke-Test Mode:** Keep `MAINNET_SMOKE_TEST_MODE=true` to enforce single-trade auto-disarm verification.
4. **Readiness Engine:** The bot validates all network, cryptographic, and security parameters on startup. If any critical configuration is missing in `LIVE` mode, the bot **fails closed** and terminates immediately.

---

## Verification & Testing Suite

Run the full automated test suite:
```bash
npm test
```

Run TypeScript strict verification:
```bash
npx tsc --noEmit
```

Build production dashboard:
```bash
npm run dashboard:build
```

---

## License

MIT License. Designed and maintained for production Solana traders.
