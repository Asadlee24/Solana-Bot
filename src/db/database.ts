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
             opened_at as openedAt, updated_at as updatedAt, closed_at as closedAt
      FROM positions WHERE target_wallet = ? AND token_mint = ?
    `);
    const row = stmt.get(targetWallet, tokenMint) as any;
    return row || null;
  }

  public getOpenPositions(): FollowerPosition[] {
    const stmt = this.db.prepare(`
      SELECT id, target_wallet as targetWallet, token_mint as tokenMint,
             qty_raw as qtyRaw, cost_basis_raw as costBasisLamports,
             avg_entry_price as avgEntryPriceSol, realized_pnl_raw as realizedPnlLamports,
             unrealized_pnl_raw as unrealizedPnlLamports, state,
             opened_at as openedAt, updated_at as updatedAt, closed_at as closedAt
      FROM positions WHERE state = 'OPEN'
    `);
    return stmt.all() as any[];
  }

  public savePosition(pos: FollowerPosition): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        id, target_wallet, token_mint, qty_raw, cost_basis_raw,
        avg_entry_price, realized_pnl_raw, unrealized_pnl_raw,
        state, opened_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_wallet, token_mint) DO UPDATE SET
        qty_raw = excluded.qty_raw,
        cost_basis_raw = excluded.cost_basis_raw,
        avg_entry_price = excluded.avg_entry_price,
        realized_pnl_raw = excluded.realized_pnl_raw,
        unrealized_pnl_raw = excluded.unrealized_pnl_raw,
        state = excluded.state,
        updated_at = excluded.updated_at,
        closed_at = excluded.closed_at
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
      pos.closedAt ?? null
    );
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

  public close() {
    this.db.close();
  }
}

export const db = new DBManager();
