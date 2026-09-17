# Low-Latency Solana Copy-Trading Bot & Copyability Evaluation Suite (MVP 2026)

A production-grade, low-latency Solana copy-trading bot and evaluation suite designed around a **dual-path architecture**:
1. **Sub-millisecond Hot Path:** Detects target transactions via Helius Preconfirmations / Preprocessed feeds, decodes swap intent across Pump.fun, PumpSwap, Raydium, and Jupiter, calculates proportional sizing, applies risk checks, and submits transactions via Paper or Live execution gateways.
2. **Reconciliation Path:** Verifies ground-truth on-chain balance deltas at `processed` commitment via LaserStream gRPC/WSS, computing actual follower vs. target entry gap ($bps$) and updating portfolio cost basis.
3. **Copyability Audit Suite:** Offline/Live transaction replay tool to evaluate whether a target wallet's alpha survives follower latency delays (0ms, 100ms, 250ms, 500ms).
4. **Real-time Web Dashboard:** Obsidian glassmorphic telemetry dashboard featuring live latency histograms, order lifecycle feeds, open positions, and circuit breaker status.

---

## Key Architectural Principles

- **Earliest Signal Hierarchy:** Helius Preconfirmations / Preprocessed (`~8ms` ahead of `processed`) $\rightarrow$ LaserStream gRPC `processed` $\rightarrow$ Webhooks.
- **Embedded Zero-Latency Persistence:** SQLite in Write-Ahead Logging (`WAL`) mode with `synchronous=NORMAL` and integer-safe BigInt strings for all u64/u128 amounts.
- **Proportional Exit Formula:**
  $$f_{\text{sell}} = \min\left(1, \frac{S_t}{B_t}\right), \quad S_m = f_{\text{sell}} \times B_m$$
  A 25% target exit results in an exact 25% follower exit, independent of capital size differences.
- **Anti-Bait Protection:**
  - Token received via transfer $\ne$ Buy (ignores transfer noise).
  - Token transferred out $\ne$ Sell (prevents fake dump triggers).
- **Comprehensive Pre-Trade Risk Engine:**
  - Hard notional cap & total open exposure cap.
  - SOL reserve floor protection (ensures gas/tip buffer is never spent).
  - Signal staleness threshold ($T_{\text{now}} - T_{\text{detected}} \le 1500\text{ms}$).
  - Entry gap bps ceiling ($+200\text{ bps}$).
  - Daily loss circuit breaker & consecutive error breaker.
- **Telemetry & Entry Gap:**
  $$\text{Entry Gap}_{bps} = 10,000 \times \left(\frac{P_{\text{mirror}}}{P_{\text{target}}} - 1\right)$$

---

## Project Structure

```
├── fixtures/
│   └── sample-transactions.json   # Recorded target swap events for testing & replay
├── src/
│   ├── api/
│   │   └── server.ts              # Express REST & Server-Sent Events (SSE) live feed
│   ├── cli/
│   │   └── replay-cli.ts          # Historical Copyability Audit Replay CLI
│   ├── config/
│   │   └── index.ts               # Zod-validated environment config and defaults
│   ├── db/
│   │   ├── database.ts            # High-performance SQLite manager (WAL mode)
│   │   └── schema.sql             # SQL schema (wallets, events, orders, positions, latency)
│   ├── engine/
│   │   ├── dedupe.ts              # Signature deduplication & lifecycle state machine
│   │   ├── position-engine.ts     # Position accounting & proportional sell calculation
│   │   └── risk-engine.ts         # Risk checks, filters, and circuit breakers
│   ├── execution/
│   │   ├── live-engine.ts         # Live trade builder (Jupiter Swap V2 & Pump.fun)
│   │   └── paper-engine.ts        # Realistic paper execution simulator
│   ├── notifications/
│   │   └── telegram.ts            # Non-blocking async Telegram alerts
│   ├── parsers/
│   │   ├── adapters/
│   │   │   ├── jupiter.ts         # Jupiter route & CPI swap decoder
│   │   │   ├── orca.ts            # Orca Whirlpool swap decoder
│   │   │   ├── pumpfun.ts         # Pump.fun bonding curve swap decoder
│   │   │   ├── pumpswap.ts        # PumpSwap AMM decoder
│   │   │   └── raydium.ts         # Raydium AMM v4, CPMM, CLMM decoder
│   │   ├── fast-decoder.ts        # Hot path transaction decoder with anti-bait checks
│   │   └── reconciler.ts          # Ground-truth post-execution balance reconciler
│   ├── streams/
│   │   ├── helius-ws.ts           # Helius LaserStream / WebSocket client
│   │   ├── replay-stream.ts       # Deterministic transaction replay streamer
│   │   ├── signal-manager.ts      # Unified signal coordinator & event bus
│   │   └── webhook-server.ts      # Helius HTTP webhook receiver
│   ├── telemetry/
│   │   └── latency-tracker.ts     # Monotonic microsecond latency metric tracker
│   ├── types/
│   │   └── index.ts               # Domain types and interfaces
│   └── index.ts                   # Main application entry point
├── dashboard/                     # React + Vite Real-time Telemetry Dashboard
│   ├── src/
│   │   ├── App.tsx                # Interactive UI with latency gauges, orders, positions
│   │   ├── index.css              # Obsidian glassmorphic styling
│   │   └── main.tsx
│   ├── index.html
│   └── vite.config.ts
├── test/                          # Comprehensive Vitest test suite
│   ├── paper-engine.test.ts
│   ├── parsers.test.ts
│   ├── position-engine.test.ts
│   └── risk-engine.test.ts
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Quick Start

### 1. Installation
```bash
npm install
```

### 2. Configuration
Copy the `.env.example` template:
```bash
cp .env.example .env
```
Key settings:
- `EXECUTION_MODE`: `PAPER` (default, zero risk) or `LIVE`
- `WATCHED_WALLETS`: Comma-separated list of target wallet public keys
- `FIXED_BUY_SOL`: Amount to buy per target signal (e.g. `0.1` SOL)
- `HELIUS_API_KEY`: Your Helius API key for live LaserStream feeds

### 3. Run Automated Tests
```bash
npm run test
```

### 4. Run Copyability Audit Replay CLI
Replays historical target transactions and calculates alpha decay across latency buckets:
```bash
npm run replay
```
Custom replay file:
```bash
npm run replay -- --file path/to/transactions.json
```

### 5. Start the Bot & Real-Time Dashboard
Start the bot backend & API server:
```bash
npm run dev
```
In another terminal, start the web dashboard:
```bash
npm run dashboard:dev
```
Open [http://localhost:3000](http://localhost:3000) to view real-time latency telemetry, open positions, order lifecycle, and risk controls.
