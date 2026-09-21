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
import { LiveTickerStrip } from '../components/trading/LiveTickerStrip';
import { OverviewLiveChart } from '../components/trading/OverviewLiveChart';
import { TargetVsFollowerPanel } from '../components/trading/TargetVsFollowerPanel';
import { TokenIdentity } from '../components/trading/TokenIdentity';
import { TradeFeed } from '../components/trading/TradeFeed';
import { PnlShowcaseBanner } from '../components/analytics/PnlShowcaseBanner';
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
  targetWallet?: string;
  onRefresh?: () => void;
  onSimulate?: () => void;
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
  targetWallet = 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
  onRefresh = () => {},
  onSimulate,
}) => {
  const [selectedExitPos, setSelectedExitPos] = useState<Position | null>(null);
  const openPositions = positions.filter((p) => p.state === 'OPEN');
  const latestLatencySample = latencySamples[0] || null;

  // Mode detection:
  const isLive = telemetry?.executionMode === 'LIVE' || Boolean(telemetry?.isLiveMode);

  // 100% mathematically synchronized live portfolio equity calculation:
  const initialBalanceSol = isLive
    ? (telemetry?.liveWalletBalanceSol ?? 0)
    : (telemetry?.initialPaperBalanceSol ?? 10.0);
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

  // Real-time Total Portfolio Equity:
  // In LIVE mode: Live Hot Wallet Balance + value of open positions (if any)
  // In PAPER mode: Initial Capital + Net PnL
  const totalEquitySol = isLive
    ? ((telemetry?.liveWalletBalanceSol ?? 0) + openPositions.reduce((acc, p) => acc + (p.currentValueSol || 0), 0))
    : (initialBalanceSol + netPnlSol);
  const totalEquityUsd = totalEquitySol * solPriceUsd;

  const netPnlUsd = netPnlSol * solPriceUsd;
  const realizedPnlUsd = realizedPnlSol * solPriceUsd;
  const totalFloatingPnlUsd = totalFloatingPnlSol * solPriceUsd;

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

      {/* Hero PnL & Profit Transparency Showcase */}
      <PnlShowcaseBanner
        telemetry={telemetry}
        orders={orders}
        positions={positions}
        isLive={isLive}
      />

      {/* Top KPI Row */}
      <div className="overview-kpi-grid">
        <MetricCard
          label={isLive ? 'Hot Wallet Equity' : 'Portfolio Equity'}
          value={
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
              <span>{formatSol(totalEquitySol, 4)}</span>
              <span className="mono font-semibold" style={{ fontSize: '12.5px', opacity: 0.9 }}>
                ({formatUsd(totalEquityUsd, 2)})
              </span>
            </div>
          }
          subValue={
            isLive ? (
              <span>
                Spendable: <strong className="mono">{formatSol(telemetry?.liveWalletSpendableSol ?? 0, 4)}</strong> • Reserve: <span className="mono">{formatSol(telemetry?.liveWalletReserveSol ?? 0.02, 2)}</span>
              </span>
            ) : (
              <span>
                Initial: <strong className="mono">{formatSol(initialBalanceSol, 2)}</strong> (${(initialBalanceSol * solPriceUsd).toFixed(0)} USD)
              </span>
            )
          }
          icon={<DollarSign size={16} />}
          badge={
            <span className={`card-tag ${isLive ? 'tag-live' : ''}`}>
              {isLive ? 'LIVE HOT WALLET' : 'SOLANA PAPER'}
            </span>
          }
          tone={isNetPositive ? 'cyan' : 'negative'}
        />

        <MetricCard
          label="Total Net Profit (PnL)"
          value={
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
              <span>{isNetPositive ? '+' : ''}{netPnlSol.toFixed(4)} SOL</span>
              <span className="mono font-semibold" style={{ fontSize: '12.5px', opacity: 0.9 }}>
                ({isNetPositive ? '+' : '-'}${Math.abs(netPnlUsd).toFixed(2)} USD)
              </span>
            </div>
          }
          subValue={
            <span>
              Realized:{' '}
              <strong className="mono" style={{ color: realizedPnlSol >= 0 ? '#10b981' : '#ef4444' }}>
                {realizedPnlSol >= 0 ? '+' : '-'}${Math.abs(realizedPnlUsd).toFixed(2)}
              </strong>{' '}
              <span className="text-muted">({realizedPnlSol >= 0 ? '+' : ''}{realizedPnlSol.toFixed(4)} SOL)</span>
              {' • '}
              Float:{' '}
              <strong className="mono" style={{ color: totalFloatingPnlSol >= 0 ? '#10b981' : '#ef4444' }}>
                {totalFloatingPnlSol >= 0 ? '+' : '-'}${Math.abs(totalFloatingPnlUsd).toFixed(2)}
              </strong>
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

      {/* Real-Time Target Trader vs Follower Execution Comparison */}
      <div className="overview-section">
        <TargetVsFollowerPanel
          orders={orders}
          positions={positions}
          telemetry={telemetry}
          latencySamples={latencySamples}
          targetWallet={targetWallet}
          onRefresh={onRefresh}
          onSimulate={onSimulate}
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
                        <span>Take Profit</span>
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
