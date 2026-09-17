-- SQLite Schema for Low-Latency Solana Copy-Trading Bot

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Watched Target Wallets
CREATE TABLE IF NOT EXISTS watched_wallets (
    wallet TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    buy_mode TEXT NOT NULL DEFAULT 'FIXED_SIZE',
    fixed_buy_raw TEXT NOT NULL DEFAULT '100000000', -- 0.1 SOL in lamports
    copy_ratio REAL NOT NULL DEFAULT 0.05,
    max_buy_raw TEXT NOT NULL DEFAULT '1000000000', -- 1.0 SOL in lamports
    config_json TEXT,
    created_at INTEGER NOT NULL
);

-- Event Receipts for Multi-Feed Ingestion & Deduplication
CREATE TABLE IF NOT EXISTS event_receipts (
    signature TEXT NOT NULL,
    source TEXT NOT NULL,
    stage TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (signature, stage, source)
);
CREATE INDEX IF NOT EXISTS idx_receipts_sig ON event_receipts (signature);

-- Canonical Target Events
CREATE TABLE IF NOT EXISTS target_events (
    signature TEXT PRIMARY KEY,
    slot INTEGER,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    processed_at INTEGER,
    target_wallet TEXT NOT NULL,
    venue TEXT NOT NULL,
    side TEXT NOT NULL,
    input_mint TEXT NOT NULL,
    input_raw TEXT NOT NULL,
    output_mint TEXT NOT NULL,
    output_raw TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    estimated_price REAL NOT NULL,
    raw_program_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_target_events_wallet ON target_events (target_wallet);
CREATE INDEX IF NOT EXISTS idx_target_events_mint ON target_events (token_mint);

-- Target Wallet Balance Delts for Reconciliation
CREATE TABLE IF NOT EXISTS target_balances (
    signature TEXT NOT NULL,
    target_wallet TEXT NOT NULL,
    mint TEXT NOT NULL,
    pre_raw TEXT NOT NULL,
    post_raw TEXT NOT NULL,
    delta_raw TEXT NOT NULL,
    PRIMARY KEY (signature, target_wallet, mint)
);

-- Mirror Intents (What strategy determined to trade)
CREATE TABLE IF NOT EXISTS mirror_intents (
    id TEXT PRIMARY KEY,
    target_signature TEXT NOT NULL,
    target_wallet TEXT NOT NULL,
    side TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    requested_raw TEXT NOT NULL,
    expected_out_raw TEXT,
    sell_fraction REAL,
    risk_decision TEXT NOT NULL,
    risk_reason TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_sig ON mirror_intents (target_signature);

-- Mirror Orders (Actual execution lifecycle)
CREATE TABLE IF NOT EXISTS mirror_orders (
    order_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    target_signature TEXT NOT NULL,
    mode TEXT NOT NULL, -- PAPER or LIVE
    side TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    in_amount_raw TEXT NOT NULL,
    out_amount_raw TEXT NOT NULL,
    min_out_raw TEXT NOT NULL,
    effective_price REAL NOT NULL,
    quote_at INTEGER NOT NULL,
    signed_at INTEGER,
    submitted_at INTEGER,
    landed_at INTEGER,
    signature TEXT,
    fee_raw TEXT DEFAULT '0',
    tip_raw TEXT DEFAULT '0',
    status TEXT NOT NULL,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_mint ON mirror_orders (token_mint);
CREATE INDEX IF NOT EXISTS idx_orders_status ON mirror_orders (status);

-- Follower Positions
CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    target_wallet TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    qty_raw TEXT NOT NULL,
    cost_basis_raw TEXT NOT NULL,
    avg_entry_price REAL NOT NULL,
    realized_pnl_raw TEXT NOT NULL DEFAULT '0',
    unrealized_pnl_raw TEXT NOT NULL DEFAULT '0',
    state TEXT NOT NULL, -- OPEN, CLOSED, CLOSED_BY_RISK, DIVERGED
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    UNIQUE(target_wallet, token_mint)
);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions (token_mint);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions (state);

-- Position Lots (Audit detail for each buy/sell)
CREATE TABLE IF NOT EXISTS position_lots (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    source_signature TEXT NOT NULL,
    side TEXT NOT NULL,
    qty_raw TEXT NOT NULL,
    cost_raw TEXT NOT NULL,
    price REAL NOT NULL,
    opened_at INTEGER NOT NULL
);

-- Latency Telemetry Samples
CREATE TABLE IF NOT EXISTS latency_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_signature TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    decision_at INTEGER NOT NULL,
    quoted_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    target_processed_at INTEGER,
    mirror_processed_at INTEGER,
    l_detect_ms REAL NOT NULL,
    l_decision_ms REAL NOT NULL,
    l_quote_ms REAL NOT NULL,
    l_submit_ms REAL NOT NULL,
    l_landing_ms REAL NOT NULL,
    l_economic_ms REAL,
    entry_gap_bps REAL
);
CREATE INDEX IF NOT EXISTS idx_latency_sig ON latency_samples (target_signature);
