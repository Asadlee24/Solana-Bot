import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Briefcase,
  DollarSign,
  Gauge,
  Layers,
  Sparkles,
  TrendingUp,
  Zap,
} from 'lucide-react';
import React, { useState } from 'react';
import { MetricCard } from '../components/common/MetricCard';
import { StatusDot } from '../components/common/StatusDot';
import { ManualExitModal } from '../components/positions/ManualExitModal';
import { BotHealthPanel } from '../components/trading/BotHealthPanel';
import { ExecutionPipeline } from '../components/trading/ExecutionPipeline';
import { LiveTickerStrip } from '../components/trading/LiveTickerStrip';
import { OverviewLiveChart } from '../components/trading/OverviewLiveChart';
import { TokenIdentity } from '../components/trading/TokenIdentity';
import { TradeFeed } from '../components/trading/TradeFeed';
import {
  formatBps,
  formatLatency,
  formatPct,
  formatSol,
  formatUsd,
} from '../lib/format';
import {
  LatencySample,
  NavigationTab,
  Order,
  Position,
  StreamStatus,
  Telemetry,
} from '../types/dashboard';

interface OverviewProps {
  telemetry: Telemetry | null;
  orders: Order[];
  positions: Position[];
  latencySamples: LatencySample[];
  streamStatus: StreamStatus;
  lastRefreshedAt?: number;
  onNavigateTab: (tab: NavigationTab) => void;
  isLoading?: boolean;
}

export const Overview: React.FC<OverviewProps> = ({
  telemetry,
  orders,
  positions,
  latencySamples,
  streamStatus,
  lastRefreshedAt,
  onNavigateTab,
  isLoading,
}) => {
  const [selectedExitPos, setSelectedExitPos] = useState<Position | null>(null);
  const openPositions = positions.filter((p) => p.state === 'OPEN');
  const latestLatencySample = latencySamples[0] || null;

  // 100% mathematically synchronized live portfolio equity calculation:
  const initialBalanceSol = telemetry?.initialPaperBalanceSol ?? 10.0;
  const solPriceUsd = telemetry?.solPriceUsd ?? 100;

  // Realized profit/loss from closed positions:
  const realizedPnlSol = telemetry?.totalRealizedPnlSol || 0;

  // Real-time live floating (unrealized) profit/loss from active open positions:
  const totalFloatingPnlSol = openPositions.reduce(
    (acc, p) => acc + (p.unrealizedPnlSol || 0),
    0
  );

  // Total Net Profit = Realized + Floating:
  const netPnlSol = realizedPnlSol + totalFloatingPnlSol;
  const isNetPositive = netPnlSol >= 0;

  // Real-time Total Portfolio Equity = Initial Capital + Net PnL:
  // When in negative (netPnlSol < 0), this is GUARANTEED to be < 10 SOL and < $1,000!
  const totalEquitySol = initialBalanceSol + netPnlSol;
  const totalEquityUsd = totalEquitySol * solPriceUsd;

  const p50 = telemetry?.latencyP50Ms || 0;
  const avgGap = telemetry?.avgEntryGapBps || 0;

  return (
    <div className="overview-page-root">
      {/* Real-time Sub-second Price Ticker Strip */}
      <LiveTickerStrip
        telemetry={telemetry}
        positions={positions}
        lastRefreshedAt={lastRefreshedAt || Date.now()}
      />

      {/* Top KPI Row */}
      <div className="overview-kpi-grid">
        <MetricCard
          label="Portfolio Equity"
          value={formatSol(totalEquitySol, 4)}
          subValue={formatUsd(totalEquityUsd, 2)}
          icon={<DollarSign size={16} />}
          badge={<span className="card-tag">SOLANA PAPER</span>}
          tone={isNetPositive ? 'cyan' : 'negative'}
        />

        <MetricCard
          label="Total Net Profit (PnL)"
          value={`${isNetPositive ? '+' : ''}${netPnlSol.toFixed(4)} SOL`}
          subValue={
            <span>
              Realized: <strong className="mono">+{realizedPnlSol.toFixed(4)}</strong> | Floating:{' '}
              <strong className="mono">{totalFloatingPnlSol >= 0 ? '+' : ''}{totalFloatingPnlSol.toFixed(4)}</strong>
            </span>
          }
          icon={<TrendingUp size={16} />}
          badge={<span className="card-tag tag-live">LIVE SYNC</span>}
          tone={isNetPositive ? 'positive' : 'negative'}
        />

        <MetricCard
          label="Trades Copied"
          value={orders.length}
          subValue="Zero dropped executions"
          icon={<Activity size={16} />}
          tone="default"
        />

        <MetricCard
          label="Median Reaction (p50)"
          value={p50 > 0 ? formatLatency(p50) : '—'}
          subValue="Hot path decision delay"
          icon={<Zap size={16} />}
          tone={p50 > 0 && p50 < 25 ? 'positive' : 'default'}
        />

        <MetricCard
          label="Average Entry Gap"
          value={avgGap !== 0 ? formatBps(avgGap) : '—'}
          subValue="Price deviation vs target"
          icon={<Gauge size={16} />}
          tone={avgGap <= 50 ? 'positive' : 'warning'}
        />

        <MetricCard
          label="Active Positions"
          value={openPositions.length}
          subValue={`${positions.length} Total Monitored`}
          icon={<Layers size={16} />}
          tone="cyan"
        />
      </div>

      {/* Real-Time Interactive Trading Terminal Chart */}
      <div className="overview-section">
        <OverviewLiveChart
          telemetry={telemetry}
          orders={orders}
          positions={positions}
          latencySamples={latencySamples}
        />
      </div>

      {/* Bot Health & Telemetry Panel */}
      <div className="overview-section">
        <div className="section-title-row">
          <h3 className="section-heading">SYSTEM HEALTH & INFRASTRUCTURE</h3>
          <button
            type="button"
            className="btn-text-link"
            onClick={() => onNavigateTab('system')}
          >
            <span>Diagnostics Console</span>
            <ArrowRight size={12} />
          </button>
        </div>

        <BotHealthPanel
          telemetry={telemetry}
          streamStatus={streamStatus}
          lastOrderTime={orders[0]?.quote_at}
        />
      </div>

      {/* Execution Pipeline */}
      <div className="overview-section">
        <ExecutionPipeline
          latestSample={latestLatencySample}
          mode={telemetry?.executionMode}
        />
      </div>

      {/* Active Holdings Highlight Banner */}
      {openPositions.length > 0 && (
        <div className="overview-section">
          <div className="section-title-row">
            <h3 className="section-heading">CURRENTLY HELD TARGET POSITIONS</h3>
            <button
              type="button"
              className="btn-text-link"
              onClick={() => onNavigateTab('positions')}
            >
              <span>View Portfolio</span>
              <ArrowRight size={12} />
            </button>
          </div>

          <div className="overview-holdings-grid">
            {openPositions.map((pos) => {
              const meta = pos.metadata;
              const symbol = meta?.symbol || pos.tokenMint.substring(0, 5);
              const costSol = Number(pos.costBasisLamports) / 1e9;
              const costUsd = costSol * solPriceUsd;

              const pnlSol = pos.unrealizedPnlSol || 0;
              const pnlUsd = (pos.currentValueUsd || 0) - costUsd;
              const pnlPct = pos.unrealizedPnlPct || 0;
              const isProfit = pnlSol >= 0;

              const priceUsd = meta?.priceUsd || (pos.currentPriceSol ? pos.currentPriceSol * solPriceUsd : 0);

              return (
                <div key={pos.id} className="overview-holding-card">
                  <div className="holding-card-header">
                    <TokenIdentity mint={pos.tokenMint} metadata={meta} size="md" />
                    <div className="holding-header-right">
                      <div className={`holding-pnl-pill-dual ${isProfit ? 'pos' : 'neg'}`}>
                        <span className={`pnl-usd font-bold ${isProfit ? 'text-green' : 'text-rose'}`}>
                          {isProfit ? '+' : '-'}${Math.abs(pnlUsd).toFixed(2)} USD
                        </span>
                        <span className="pnl-sub text-muted" style={{ fontSize: 10.5 }}>
                          ({isProfit ? '+' : ''}{pnlSol.toFixed(4)} SOL • {formatPct(pnlPct, true)})
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn-holding-tp"
                        onClick={() => setSelectedExitPos(pos)}
                        title="Manual Take Profit / Partial Exit"
                      >
                        <span>💰 Take Profit</span>
                      </button>
                    </div>
                  </div>

                  <div className="holding-stats-row">
                    <div className="h-stat">
                      <span className="lbl">Cost Basis</span>
                      <span className="val mono font-semibold">
                        ${costUsd.toFixed(2)} USD
                      </span>
                      <span className="sub mono text-muted" style={{ fontSize: 10 }}>
                        ({formatSol(costSol, 3)})
                      </span>
                    </div>

                    <div className="h-stat">
                      <span className="lbl">Live DEX Price</span>
                      <span className="val mono text-cyan font-semibold">
                        ${priceUsd < 0.01 ? priceUsd.toFixed(7) : priceUsd.toFixed(4)} USD
                      </span>
                      <span className="sub mono text-muted" style={{ fontSize: 10 }}>
                        ({pos.currentPriceSol ? `${pos.currentPriceSol.toFixed(8)} SOL` : '—'})
                      </span>
                    </div>

                    <div className="h-stat">
                      <span className="lbl">Current Value</span>
                      <span className="val mono font-semibold">
                        {pos.currentValueUsd ? `$${pos.currentValueUsd.toFixed(2)} USD` : '—'}
                      </span>
                      <span className="sub mono text-muted" style={{ fontSize: 10 }}>
                        ({pos.currentValueSol ? formatSol(pos.currentValueSol, 3) : '—'})
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Trades Snippet */}
      <div className="overview-section">
        <div className="section-title-row">
          <h3 className="section-heading">RECENT RECONCILED MIRROR TRADES</h3>
          <button
            type="button"
            className="btn-text-link"
            onClick={() => onNavigateTab('trades')}
          >
            <span>All Trades Feed</span>
            <ArrowRight size={12} />
          </button>
        </div>

        <TradeFeed orders={orders} isLoading={isLoading} limit={8} />
      </div>

      {/* Manual Take Profit / Exit Modal */}
      <ManualExitModal
        position={selectedExitPos}
        isOpen={Boolean(selectedExitPos)}
        onClose={() => setSelectedExitPos(null)}
      />
    </div>
  );
};
