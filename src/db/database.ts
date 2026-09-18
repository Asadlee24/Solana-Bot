import Database, { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import {
  FollowerPosition,
  LatencyMetric,
  MirrorIntent,
  MirrorOrder,
  ReconciledTrade,
  SwapIntent,
  SystemTelemetry,
  WatchedWallet,
} from '../types/index.js';

export class DBManager {
  private db: DatabaseType;

  constructor(dbPath: string = config.DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initPragmas();
    this.initSchema();
    this.seedHistoricalTrades();
  }

  private initPragmas() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private initSchema() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    let schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      schemaPath = path.resolve('src/db/schema.sql');
    }

    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(schemaSql);
    } else {
      // Fallback inline schema if path resolution differs in bundle
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS watched_wallets (
          wallet TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          buy_mode TEXT NOT NULL DEFAULT 'FIXED_SIZE',
          fixed_buy_raw TEXT NOT NULL DEFAULT '100000000',
          copy_ratio REAL NOT NULL DEFAULT 0.05,
          max_buy_raw TEXT NOT NULL DEFAULT '1000000000',
          config_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_receipts (
          signature TEXT NOT NULL,
          source TEXT NOT NULL,
          stage TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          PRIMARY KEY (signature, stage, source)
        );
        CREATE INDEX IF NOT EXISTS idx_receipts_sig ON event_receipts (signature);
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
        CREATE TABLE IF NOT EXISTS target_balances (
          signature TEXT NOT NULL,
          target_wallet TEXT NOT NULL,
          mint TEXT NOT NULL,
          pre_raw TEXT NOT NULL,
          post_raw TEXT NOT NULL,
          delta_raw TEXT NOT NULL,
          PRIMARY KEY (signature, target_wallet, mint)
        );
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
        CREATE TABLE IF NOT EXISTS mirror_orders (
          order_id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL,
          target_signature TEXT NOT NULL,
          mode TEXT NOT NULL,
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
          error_message TEXT,
          actual_in_raw TEXT,
          actual_out_raw TEXT,
          actual_price REAL,
          actual_fee_raw TEXT,
          landing_provider TEXT,
          reconciliation_source TEXT
        );
        CREATE TABLE IF NOT EXISTS positions (
          id TEXT PRIMARY KEY,
          target_wallet TEXT NOT NULL,
          token_mint TEXT NOT NULL,
          qty_raw TEXT NOT NULL,
          cost_basis_raw TEXT NOT NULL,
          avg_entry_price REAL NOT NULL,
          realized_pnl_raw TEXT NOT NULL DEFAULT '0',
          unrealized_pnl_raw TEXT NOT NULL DEFAULT '0',
          state TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER,
          tp1_triggered INTEGER DEFAULT 0,
          peak_pnl_pct REAL DEFAULT 0,
          UNIQUE(target_wallet, token_mint)
        );
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
        CREATE INDEX IF NOT EXISTS idx_positions_mint_state ON positions (token_mint, state);
      `);
    }

    // Incremental column migrations for existing tables
    const safeAddColumn = (table: string, colDef: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
        // column already exists
      }
    };
    safeAddColumn('mirror_orders', 'actual_in_raw TEXT');
    safeAddColumn('mirror_orders', 'actual_out_raw TEXT');
    safeAddColumn('mirror_orders', 'actual_price REAL');
    safeAddColumn('mirror_orders', 'actual_fee_raw TEXT');
    safeAddColumn('mirror_orders', 'landing_provider TEXT');
    safeAddColumn('mirror_orders', 'reconciliation_source TEXT');
    safeAddColumn('positions', 'tp1_triggered INTEGER DEFAULT 0');
    safeAddColumn('positions', 'peak_pnl_pct REAL DEFAULT 0');

    // Seed default watched wallets if empty
    this.seedDefaultWallets();
  }

  private seedDefaultWallets() {
    // Ensure default config wallets exist without deleting user-added wallets
    if (config.WATCHED_WALLETS.length > 0) {
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO watched_wallets (wallet, label, enabled, buy_mode, fixed_buy_raw, copy_ratio, max_buy_raw, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `);
      for (const w of config.WATCHED_WALLETS) {
        insertStmt.run(
          w,
          'Favorite Trader',
          config.DEFAULT_SIZING_MODE,
          (config.FIXED_BUY_SOL * 1e9).toString(),
          config.COPY_RATIO,
          (config.MAX_BUY_SOL * 1e9).toString(),
          Date.now()
        );
      }
    }
  }

  public deleteWatchedWallet(wallet: string): boolean {
    const stmt = this.db.prepare('DELETE FROM watched_wallets WHERE wallet = ?');
    const res = stmt.run(wallet);
    return res.changes > 0;
  }

  // Idempotency check: record receipt and return true if brand new
  public recordReceipt(signature: string, stage: string, source: string): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO event_receipts (signature, stage, source, first_seen_at)
      VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(signature, stage, source, Date.now());
    return info.changes > 0;
  }

  // Watched Wallets Management
  public getWatchedWallets(): WatchedWallet[] {
    const stmt = this.db.prepare(`
      SELECT wallet, label, enabled, buy_mode as buyMode, fixed_buy_raw as fixedBuyLamports,
             copy_ratio as copyRatio, max_buy_raw as maxBuyLamports, created_at as createdAt
      FROM watched_wallets
    `);
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      ...r,
      enabled: Boolean(r.enabled),
    }));
  }

  public getWatchedWallet(wallet: string): WatchedWallet | null {
    const stmt = this.db.prepare(`
      SELECT wallet, label, enabled, buy_mode as buyMode, fixed_buy_raw as fixedBuyLamports,
             copy_ratio as copyRatio, max_buy_raw as maxBuyLamports, created_at as createdAt
      FROM watched_wallets WHERE wallet = ?
    `);
    const row = stmt.get(wallet) as any;
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled) };
  }

  public upsertWatchedWallet(wallet: WatchedWallet): void {
    const stmt = this.db.prepare(`
      INSERT INTO watched_wallets (wallet, label, enabled, buy_mode, fixed_buy_raw, copy_ratio, max_buy_raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        label = excluded.label,
        enabled = excluded.enabled,
        buy_mode = excluded.buy_mode,
        fixed_buy_raw = excluded.fixed_buy_raw,
        copy_ratio = excluded.copy_ratio,
        max_buy_raw = excluded.max_buy_raw
    `);
    stmt.run(
      wallet.wallet,
      wallet.label,
      wallet.enabled ? 1 : 0,
      wallet.buyMode,
      wallet.fixedBuyLamports,
      wallet.copyRatio,
      wallet.maxBuyLamports,
      wallet.createdAt || Date.now()
    );
  }

  // Target Events
  public saveTargetEvent(intent: SwapIntent, stage: string, status: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO target_events (
        signature, slot, stage, status, detected_at, target_wallet,
        venue, side, input_mint, input_raw, output_mint, output_raw,
        token_mint, estimated_price, raw_program_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      intent.targetSignature,
      intent.slot,
      stage,
      status,
      intent.timestampMs,
      intent.targetWallet,
      intent.venue,
      intent.side,
      intent.inputMint,
      intent.inputAmountRaw,
      intent.outputMint,
      intent.outputAmountRaw,
      intent.tokenMint,
      intent.estimatedPrice,
      intent.rawProgramId
    );
  }

  public saveTargetBalances(trade: ReconciledTrade): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO target_balances (
        signature, target_wallet, mint, pre_raw, post_raw, delta_raw
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      trade.signature,
      trade.targetWallet,
      trade.tokenMint,
      trade.targetPreTokenBalanceRaw.toString(),
      trade.targetPostTokenBalanceRaw.toString(),
      trade.netTokenDeltaRaw.toString()
    );
  }

  // Mirror Intent & Orders
  public saveMirrorIntent(intent: MirrorIntent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO mirror_intents (
        id, target_signature, target_wallet, side, token_mint,
        requested_raw, expected_out_raw, sell_fraction, risk_decision,
        risk_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      intent.id,
      intent.targetSignature,
      intent.targetWallet,
      intent.side,
      intent.tokenMint,
      intent.requestedInAmountRaw,
      intent.expectedOutAmountRaw,
      intent.sellFraction ?? null,
      intent.riskDecision,
      intent.riskReason ?? null,
      Number(intent.createdAt / 1_000_000n) // ms
    );
  }

  public saveMirrorOrder(order: MirrorOrder): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO mirror_orders (
        order_id, intent_id, target_signature, mode, side, token_mint,
        in_amount_raw, out_amount_raw, min_out_raw, effective_price,
        quote_at, signed_at, submitted_at, landed_at, signature,
        fee_raw, tip_raw, status, error_message,
        actual_in_raw, actual_out_raw, actual_price, actual_fee_raw,
        landing_provider, reconciliation_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      order.orderId,
      order.intentId,
      order.targetSignature,
      order.mode,
      order.side,
      order.tokenMint,
      order.inAmountRaw,
      order.outAmountRaw,
      order.minOutAmountRaw,
      order.effectivePrice,
      Number(order.quotedAt / 1_000_000n),
      order.signedAt ? Number(order.signedAt / 1_000_000n) : null,
      order.submittedAt ? Number(order.submittedAt / 1_000_000n) : null,
      order.landedAt ? Number(order.landedAt / 1_000_000n) : null,
      order.orderSignature ?? null,
      order.routeFeeLamports.toString(),
      order.tipLamports.toString(),
      order.status,
      order.errorMessage ?? null,
      order.actualInAmountRaw ?? null,
      order.actualOutAmountRaw ?? null,
      order.actualExecutionPrice ?? null,
      order.actualFeeLamports ? order.actualFeeLamports.toString() : null,
      order.landingProvider ?? null,
      order.reconciliationSource ?? null
    );
  }

  // Follower Positions
  public getPosition(targetWallet: string, tokenMint: string): FollowerPosition | null {
    const stmt = this.db.prepare(`
      SELECT id, target_wallet as targetWallet, token_mint as tokenMint,
             qty_raw as qtyRaw, cost_basis_raw as costBasisLamports,
             avg_entry_price as avgEntryPriceSol, realized_pnl_raw as realizedPnlLamports,
             unrealized_pnl_raw as unrealizedPnlLamports, state,
             opened_at as openedAt, updated_at as updatedAt, closed_at as closedAt,
             tp1_triggered as tp1Triggered, peak_pnl_pct as peakPnlPct
      FROM positions WHERE target_wallet = ? AND token_mint = ?
    `);
    const row = stmt.get(targetWallet, tokenMint) as any;
    if (!row) return null;
    return {
      ...row,
      tp1Triggered: Boolean(row.tp1Triggered),
      peakPnlPct: Number(row.peakPnlPct || 0),
    };
  }

  public getOpenPositions(): FollowerPosition[] {
    const stmt = this.db.prepare(`
      SELECT id, target_wallet as targetWallet, token_mint as tokenMint,
             qty_raw as qtyRaw, cost_basis_raw as costBasisLamports,
             avg_entry_price as avgEntryPriceSol, realized_pnl_raw as realizedPnlLamports,
             unrealized_pnl_raw as unrealizedPnlLamports, state,
             opened_at as openedAt, updated_at as updatedAt, closed_at as closedAt,
             tp1_triggered as tp1Triggered, peak_pnl_pct as peakPnlPct
      FROM positions WHERE state = 'OPEN'
    `);
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      ...r,
      tp1Triggered: Boolean(r.tp1Triggered),
      peakPnlPct: Number(r.peakPnlPct || 0),
    }));
  }

  public hasOpenPosition(tokenMint: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM positions
      WHERE token_mint = ? AND state = 'OPEN' AND qty_raw != '0'
      LIMIT 1
    `);
    return Boolean(stmt.get(tokenMint));
  }

  public hasEverBoughtToken(tokenMint: string): boolean {
    try {
      const stmtPos = this.db.prepare(`
        SELECT 1 FROM positions
        WHERE token_mint = ?
        LIMIT 1
      `);
      if (stmtPos.get(tokenMint)) return true;

      const stmtOrd = this.db.prepare(`
        SELECT 1 FROM mirror_orders
        WHERE token_mint = ? AND side = 'BUY' AND status IN ('LANDED', 'FILLED')
        LIMIT 1
      `);
      return Boolean(stmtOrd.get(tokenMint));
    } catch {
      return false;
    }
  }

  public getAllEverBoughtTokens(): string[] {
    const mints = new Set<string>();
    try {
      const posStmt = this.db.prepare(`SELECT DISTINCT token_mint as tokenMint FROM positions`);
      const posRows = posStmt.all() as any[];
      for (const r of posRows) {
        if (r.tokenMint) mints.add(r.tokenMint);
      }

      const ordStmt = this.db.prepare(`SELECT DISTINCT token_mint as tokenMint FROM mirror_orders WHERE side = 'BUY' AND status IN ('LANDED', 'FILLED')`);
      const ordRows = ordStmt.all() as any[];
      for (const r of ordRows) {
        if (r.tokenMint) mints.add(r.tokenMint);
      }
    } catch {}

    return Array.from(mints);
  }

  public getOpenPositionByMint(tokenMint: string): FollowerPosition | null {
    const stmt = this.db.prepare(`
      SELECT id, target_wallet as targetWallet, token_mint as tokenMint,
             qty_raw as qtyRaw, cost_basis_raw as costBasisLamports,
             avg_entry_price as avgEntryPriceSol, realized_pnl_raw as realizedPnlLamports,
             unrealized_pnl_raw as unrealizedPnlLamports, state,
             opened_at as openedAt, updated_at as updatedAt, closed_at as closedAt,
             tp1_triggered as tp1Triggered, peak_pnl_pct as peakPnlPct
      FROM positions
      WHERE token_mint = ? AND state = 'OPEN' AND qty_raw != '0'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const row = stmt.get(tokenMint) as any;
    if (!row) return null;
    return {
      ...row,
      tp1Triggered: Boolean(row.tp1Triggered),
      peakPnlPct: Number(row.peakPnlPct || 0),
    };
  }

  public savePosition(pos: FollowerPosition): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        id, target_wallet, token_mint, qty_raw, cost_basis_raw,
        avg_entry_price, realized_pnl_raw, unrealized_pnl_raw,
        state, opened_at, updated_at, closed_at, tp1_triggered, peak_pnl_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_wallet, token_mint) DO UPDATE SET
        qty_raw = excluded.qty_raw,
        cost_basis_raw = excluded.cost_basis_raw,
        avg_entry_price = excluded.avg_entry_price,
        realized_pnl_raw = excluded.realized_pnl_raw,
        unrealized_pnl_raw = excluded.unrealized_pnl_raw,
        state = excluded.state,
        updated_at = excluded.updated_at,
        closed_at = excluded.closed_at,
        tp1_triggered = excluded.tp1_triggered,
        peak_pnl_pct = excluded.peak_pnl_pct
    `);
    stmt.run(
      pos.id,
      pos.targetWallet,
      pos.tokenMint,
      pos.qtyRaw,
      pos.costBasisLamports,
      pos.avgEntryPriceSol,
      pos.realizedPnlLamports,
      pos.unrealizedPnlLamports,
      pos.state,
      pos.openedAt,
      pos.updatedAt,
      pos.closedAt ?? null,
      pos.tp1Triggered ? 1 : 0,
      pos.peakPnlPct || 0
    );
  }

  public markPositionTpTriggered(positionId: string, peakPnlPct: number): void {
    const stmt = this.db.prepare(`
      UPDATE positions
      SET tp1_triggered = 1, peak_pnl_pct = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(peakPnlPct, Date.now(), positionId);
  }

  // Position Lots
  public addPositionLot(lot: {
    id: string;
    positionId: string;
    sourceSignature: string;
    side: string;
    qtyRaw: string;
    costRaw: string;
    price: number;
    openedAt: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO position_lots (id, position_id, source_signature, side, qty_raw, cost_raw, price, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      lot.id,
      lot.positionId,
      lot.sourceSignature,
      lot.side,
      lot.qtyRaw,
      lot.costRaw,
      lot.price,
      lot.openedAt
    );
  }

  // Latency Metrics
  public recordLatencySample(sample: LatencyMetric): void {
    const stmt = this.db.prepare(`
      INSERT INTO latency_samples (
        target_signature, source, observed_at, decision_at, quoted_at, sent_at,
        target_processed_at, mirror_processed_at, l_detect_ms, l_decision_ms,
        l_quote_ms, l_submit_ms, l_landing_ms, l_economic_ms, entry_gap_bps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sample.targetSignature,
      sample.source,
      Number(sample.observedAt / 1_000_000n),
      Number(sample.decisionAt / 1_000_000n),
      Number(sample.quoteDoneAt / 1_000_000n),
      Number(sample.submittedAt / 1_000_000n),
      sample.targetProcessedAt ? Number(sample.targetProcessedAt / 1_000_000n) : null,
      sample.mirrorProcessedAt ? Number(sample.mirrorProcessedAt / 1_000_000n) : null,
      sample.lDetectMs,
      sample.lDecisionMs,
      sample.lQuoteMs,
      sample.lSubmitMs,
      sample.lLandingMs,
      sample.lEconomicMs ?? null,
      sample.entryGapBps ?? null
    );
  }

  public getRecentLatencySamples(limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM latency_samples ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(limit);
  }

  public updateUnrealizedPnl(id: string, unrealizedPnlLamports: string): void {
    const stmt = this.db.prepare(`
      UPDATE positions
      SET unrealized_pnl_raw = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(unrealizedPnlLamports, Date.now(), id);
  }

  public getRecentOrders(limit: number = 30): any[] {
    const stmt = this.db.prepare(`
      SELECT o.*, 
             i.risk_decision, i.risk_reason, i.sell_fraction,
             t.estimated_price as target_price,
             t.input_raw as target_in_raw,
             t.output_raw as target_out_raw,
             t.side as target_side,
             t.venue as target_venue,
             t.slot as target_slot,
             l.l_decision_ms,
             l.l_quote_ms,
             l.l_submit_ms,
             l.entry_gap_bps
      FROM mirror_orders o
      LEFT JOIN mirror_intents i ON o.intent_id = i.id
      LEFT JOIN target_events t ON o.target_signature = t.signature
      LEFT JOIN latency_samples l ON o.target_signature = l.target_signature
      ORDER BY o.quote_at DESC LIMIT ?
    `);
    return stmt.all(limit);
  }

  // Aggregated System Telemetry
  public getSystemTelemetry(): SystemTelemetry {
    const walletsRow = this.db.prepare('SELECT COUNT(*) as count FROM watched_wallets WHERE enabled = 1').get() as any;
    const positionsRow = this.db.prepare("SELECT COUNT(*) as count FROM positions WHERE state = 'OPEN'").get() as any;
    const ordersRow = this.db.prepare("SELECT COUNT(*) as count FROM mirror_orders WHERE status = 'FILLED'").get() as any;

    const pnlRow = this.db.prepare(`
      SELECT 
        COALESCE(SUM(CAST(realized_pnl_raw AS INTEGER)), 0) as totalRealizedPnl,
        COALESCE(SUM(CASE WHEN state = 'OPEN' THEN CAST(unrealized_pnl_raw AS INTEGER) ELSE 0 END), 0) as totalUnrealizedPnl
      FROM positions
    `).get() as any;

    const closedRows = this.db.prepare(`
      SELECT 
        COUNT(*) as closedCount,
        SUM(CASE WHEN CAST(realized_pnl_raw AS INTEGER) > 0 THEN 1 ELSE 0 END) as winCount
      FROM positions WHERE state = 'CLOSED'
    `).get() as any;
    const totalTradesClosed = closedRows?.closedCount || 0;
    const winTrades = closedRows?.winCount || 0;
    const winRatePct = totalTradesClosed > 0 ? Number(((winTrades / totalTradesClosed) * 100).toFixed(1)) : 0;

    const latencyRows = this.db.prepare(`
      SELECT l_decision_ms + l_quote_ms + l_submit_ms as total_ms, entry_gap_bps
      FROM latency_samples ORDER BY id DESC LIMIT 100
    `).all() as { total_ms: number; entry_gap_bps: number | null }[];

    let p50 = 0, p95 = 0, p99 = 0, avgGap = 0;
    if (latencyRows.length > 0) {
      const sorted = latencyRows.map((r) => r.total_ms).sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
      p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

      const gaps = latencyRows.map((r) => r.entry_gap_bps).filter((g): g is number => g !== null);
      if (gaps.length > 0) {
        avgGap = gaps.reduce((acc, v) => acc + v, 0) / gaps.length;
      }
    }

    const lastSample = this.db.prepare('SELECT observed_at FROM latency_samples ORDER BY id DESC LIMIT 1').get() as any;

    const totalRealizedPnlSol = (pnlRow?.totalRealizedPnl || 0) / 1e9;
    const totalUnrealizedPnlSol = (pnlRow?.totalUnrealizedPnl || 0) / 1e9;
    const totalNetPnlSol = totalRealizedPnlSol + totalUnrealizedPnlSol;

    const initialPaperBalanceSol = 10.0;
    const currentPaperBalanceSol = Number((initialPaperBalanceSol + totalNetPnlSol).toFixed(4));
    const solPriceUsd = 100.0;
    const totalPaperBalanceUsd = Number((currentPaperBalanceSol * solPriceUsd).toFixed(2));
    const totalRealizedPnlUsd = Number((totalRealizedPnlSol * solPriceUsd).toFixed(2));
    const totalNetPnlUsd = Number((totalNetPnlSol * solPriceUsd).toFixed(2));
    const roiPercent = Number(((totalNetPnlSol / initialPaperBalanceSol) * 100).toFixed(2));

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      executionMode: config.EXECUTION_MODE,
      watchedWalletsCount: walletsRow?.count || 0,
      openPositionsCount: positionsRow?.count || 0,
      totalTradesProcessed: ordersRow?.count || 0,
      totalTradesClosed,
      winRatePct,
      initialPaperBalanceSol,
      currentPaperBalanceSol,
      solPriceUsd,
      totalPaperBalanceUsd,
      totalRealizedPnlSol: Number(totalRealizedPnlSol.toFixed(4)),
      totalRealizedPnlUsd,
      totalUnrealizedPnlSol: Number(totalUnrealizedPnlSol.toFixed(4)),
      totalNetPnlSol: Number(totalNetPnlSol.toFixed(4)),
      totalNetPnlUsd,
      roiPercent,
      circuitBreakerTripped: false,
      consecutiveErrors: 0,
      latencyP50Ms: Number(p50.toFixed(2)),
      latencyP95Ms: Number(p95.toFixed(2)),
      latencyP99Ms: Number(p99.toFixed(2)),
      avgEntryGapBps: Number(avgGap.toFixed(1)),
      lastSignalTimestamp: lastSample?.observed_at || Date.now(),
    };
  }

  private seedHistoricalTrades(): void {
    const historicalTrades = [
      {
        id: 'hist_pos_cxz_917',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: 'CXZ4zAn6wV39jWQua8GfduzABUjyMadoY63A5GAnpump',
        qtyRaw: '0',
        costBasisLamports: '51580000',
        avgEntryPriceSol: 5.647e-8,
        realizedPnlLamports: '-24300000',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789665499000,
        updatedAt: 1789665887000,
        closedAt: 1789665887000,
        buySig: '4Ja2iqNBgFtEgNAGugvrEQd2451nWPjpvNWmFazF98PM54hXqXG7BezSEgc16q3uVXWTQg41iN1qGwvRjah5ppaS',
        sellSig: '4WZsaTVQe3tP6eoQSgqtrmUbgFN7nsLQ3ag5n8t4atXZP6yUejb8bn6iwq7TszFXe7nZYtaasSBodYmNWTzpdmtL',
        inTokens: '913354711223',
        outLamports: '27280000',
      },
      {
        id: 'hist_pos_bzv_917',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: 'BZV1duQoQt3znWkakzzSCLUmLbE7RFtj9FRPPxx4pump',
        qtyRaw: '0',
        costBasisLamports: '51380000',
        avgEntryPriceSol: 4.619e-8,
        realizedPnlLamports: '20300000',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789669017000,
        updatedAt: 1789669103000,
        closedAt: 1789669103000,
        buySig: '3MiZFEEYVQGGqjvaLSKQJJFGRZwpqG2w2D7cYXWmD3d3LX6ZX2GXeVzYKxgPNASz1y73tLkjnpUhEbm5MaN4MhD1',
        sellSig: '5SUJrUGeTVXq15dTYh4XMHVAepHEKR3Azfz6fcCa9vgq4fLoASNXqik3yUMcuKg3eQS1KQ5Hs1BgonVC28SGsiWL',
        inTokens: '1112305446967',
        outLamports: '71680000',
      },
      {
        id: 'hist_pos_9y6_918',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: '9y6hXFBFN1fJGfAAYgkXVVfQATG1mEJsmTrCXcT6pump',
        qtyRaw: '0',
        costBasisLamports: '51490000',
        avgEntryPriceSol: 9.442e-8,
        realizedPnlLamports: '-10730000',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789718023000,
        updatedAt: 1789718028000,
        closedAt: 1789718028000,
        buySig: '3HdjoUzsUNiH5DdQCAsn11TkDbtQtVY7W9JZXBJK7d3yzWXpF2fdsS5pGJFS65nFtLxv9hL1LRKfTPBSUnvVAxQF',
        sellSig: '5E9rcCGUxgmrNSJmMjf2FjXaJDgxcvn4oyKwcBuF2sPMTQxLFWgZ6dsvaYt6RcDqBZeGqeDfPRrr1t7tLhQLp2Bt',
        inTokens: '545325126035',
        outLamports: '40760000',
      },
      {
        id: 'hist_pos_agb_918',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: 'AgbU9crd7rgU43pnfFvwunh2RhT8m74c7eezcuBYpump',
        qtyRaw: '0',
        costBasisLamports: '50190000',
        avgEntryPriceSol: 1.167e-7,
        realizedPnlLamports: '-5570000',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789732191000,
        updatedAt: 1789732196000,
        closedAt: 1789732196000,
        buySig: '3D3bzFJxKPufvdvakMK63CDsiyv4vv1aDG1dd7Cn398oFVipUUzkkXSLMBy3acTfVqJwwSLqhAffRdE9GUwZpe3D',
        sellSig: '2wrqPB6MsXdtXE2HjNQwAN4CPB6Q6dsmyRdyeSw9iyRH7P8VkZhQhigmoZ52bkS5TbXvYpjeYqwBjByG7xHKrJhJ',
        inTokens: '430123777880',
        outLamports: '44620000',
      },
      {
        id: 'hist_pos_br1_918',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: '8T6rjb3eFjcj4gpJ2oztFg6fceqYfgrRmifPiBx5pump',
        qtyRaw: '0',
        costBasisLamports: '51510000',
        avgEntryPriceSol: 6.294e-8,
        realizedPnlLamports: '-4380000',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789747385000,
        updatedAt: 1789749342000,
        closedAt: 1789749342000,
        buySig: 'P7vjS7oKiVe1N2BYJLWKfDKfCvrv3LURXQu1Jm3T6LYNZLFuwjqJVL4psZBokumR8AbxGUb6vMKDFqU1VsmAwmG',
        sellSig: 'xdfHPnH3yJTf9qQGUAxBo4e6aLiVnTfbP9x1SdG5GPikv4ccskcc8nE2CcjGjMUbL2jQZ8oCVoShq1JYoyN4X9v',
        inTokens: '818352297559',
        outLamports: '47130000',
      },
      {
        id: 'hist_pos_1bjz_918',
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: '1BjZRVA2NDnYdw9JrVNckC93HAScUVTLJZq6iAmpQeb',
        qtyRaw: '0',
        costBasisLamports: '52984786',
        avgEntryPriceSol: 7.436e-8,
        realizedPnlLamports: '18785214',
        unrealizedPnlLamports: '0',
        state: 'CLOSED',
        openedAt: 1789749257000,
        updatedAt: 1789749405000,
        closedAt: 1789749405000,
        buySig: '45nSXTWjyQEeCZ2hdhKFnhZUSDmNS7AL5xecXaaP4AQrbNdXVcb3QFTtrZnhN5KHg7nab8B7u6p4okaWj4gEmxRF',
        sellSig: '44tLPEUDydYqoxR4F5F1o6yNWbvMGve6BhtrpMecs4hjWgayuQtnMdkgbv81XQHQRE37e8KkNJBfJcmMtWgvsP3z',
        inTokens: '712569935054',
        outLamports: '71770000',
      },
    ];

    const posStmt = this.db.prepare(`
      INSERT OR IGNORE INTO positions (
        id, target_wallet, token_mint, qty_raw, cost_basis_raw, avg_entry_price,
        realized_pnl_raw, unrealized_pnl_raw, state, opened_at, updated_at, closed_at, tp1_triggered, peak_pnl_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const orderStmt = this.db.prepare(`
      INSERT OR IGNORE INTO mirror_orders (
        order_id, intent_id, target_signature, signature, mode, side, token_mint,
        in_amount_raw, out_amount_raw, min_out_raw, effective_price, quote_at, landed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction(() => {
      for (const t of historicalTrades) {
        posStmt.run(
          t.id,
          t.targetWallet,
          t.tokenMint,
          t.qtyRaw,
          t.costBasisLamports,
          t.avgEntryPriceSol,
          t.realizedPnlLamports,
          t.unrealizedPnlLamports,
          t.state,
          t.openedAt,
          t.updatedAt,
          t.closedAt,
          0,
          0
        );

        // Buy order
        orderStmt.run(
          `ord_buy_${t.id}`,
          `int_buy_${t.id}`,
          t.buySig,
          t.buySig,
          'LIVE',
          'BUY',
          t.tokenMint,
          t.costBasisLamports,
          t.inTokens,
          t.inTokens,
          t.avgEntryPriceSol,
          t.openedAt,
          t.openedAt,
          'FILLED'
        );

        // Sell order
        orderStmt.run(
          `ord_sell_${t.id}`,
          `int_sell_${t.id}`,
          t.sellSig,
          t.sellSig,
          'LIVE',
          'SELL',
          t.tokenMint,
          t.inTokens,
          t.outLamports,
          t.outLamports,
          Number(t.outLamports) / Number(t.inTokens),
          t.closedAt,
          t.closedAt,
          'FILLED'
        );
      }
    });

    try {
      insertMany();
    } catch (err: any) {
      console.warn('[DB] Failed seeding historical trades:', err.message || err);
    }
  }

  public close() {
    this.db.close();
  }
}

export const db = new DBManager();
