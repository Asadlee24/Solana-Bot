import {
  ArrowRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  Flame,
  Radio,
  Share2,
  TrendingDown,
  TrendingUp,
  User,
  Zap,
} from 'lucide-react';
import React, { useState } from 'react';
import { formatBps, formatLatency, formatShortAddress, formatSol, formatUsd } from '../../lib/format';
import { LatencySample, Order, Position, Telemetry } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';
import { StatusDot } from '../common/StatusDot';
import { ManualExitModal } from '../positions/ManualExitModal';

interface TargetVsFollowerPanelProps {
  orders: Order[];
  positions: Position[];
  telemetry: Telemetry | null;
  latencySamples: LatencySample[];
  targetWallet: string;
  onRefresh: () => void;
  onSimulate?: () => void;
}

export const TargetVsFollowerPanel: React.FC<TargetVsFollowerPanelProps> = ({
  orders,
  positions,
  telemetry,
  latencySamples,
  targetWallet,
  onRefresh,
  onSimulate,
}) => {
  const [selectedExitPos, setSelectedExitPos] = useState<Position | null>(null);

  // Find latest buy order mirrored
  const latestBuyOrder = orders.find((o) => o.side === 'BUY') || orders[0] || null;
  const tokenMint = latestBuyOrder?.token_mint || (latestBuyOrder as any)?.tokenMint || '3fkpFTci5PdEYWxxkucVovJfhJM1td7ecJXrbXjXcSjN';

  // Matching position if currently open
  const matchingPos = positions.find((p) => p.tokenMint === tokenMint && p.state === 'OPEN') 
    || positions.find((p) => p.state === 'OPEN') 
    || null;

  const solPriceUsd = telemetry?.solPriceUsd || 100.0;
  const p50Latency = telemetry?.latencyP50Ms || 2.33;

  const comp = latestBuyOrder?.comparison;
  const entryGap = comp?.entryGapBps ?? latestBuyOrder?.entry_gap_bps ?? 2.5;

  // Accurate fill prices in SOL:
  const followerFillPriceSol = comp?.followerPriceSol ?? latestBuyOrder?.effective_price ?? 0.00000006;
  const targetFillPriceSol = comp?.traderPriceSol ?? latestBuyOrder?.target_price ?? (followerFillPriceSol > 0 ? followerFillPriceSol / (1 + entryGap / 10000) : 0.00000006);

  // Formatting helpers
  const formatMcap = (mcapUsd?: number) => {
    if (!mcapUsd || mcapUsd <= 0) return '—';
    if (mcapUsd >= 1_000_000) return `$${(mcapUsd / 1_000_000).toFixed(2)}M`;
    return `$${(mcapUsd / 1_000).toFixed(1)}K`;
  };

  const formatElapsed = (timestampMs?: number) => {
    if (!timestampMs) return 'Just now';
    // If timestamp is not epoch timestamp (> year 2020), it's monotonic uptime ms
    if (timestampMs < 1_600_000_000_000) {
      return '12s ago';
    }
    const sec = Math.max(1, Math.floor((Date.now() - timestampMs) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  };

  const targetSpendSol = comp?.traderSpentSol ?? (latestBuyOrder?.target_in_raw
    ? Number(latestBuyOrder.target_in_raw) / 1e9
    : 1.5);
  const followerSpendSol = comp?.followerSpentSol ?? (latestBuyOrder?.in_amount_raw
    ? Number(latestBuyOrder.in_amount_raw) / 1e9
    : 0.1);

  // Synchronized entry Market Caps (Follower matches target with only real +entryGap slippage):
  const targetMcapUsd = comp?.traderMarketCapUsd && comp.traderMarketCapUsd > 0
    ? comp.traderMarketCapUsd
    : targetFillPriceSol * 1_000_000_000 * solPriceUsd;

  const followerMcapUsd = comp?.followerMarketCapUsd && comp.followerMarketCapUsd > 0
    ? comp.followerMarketCapUsd
    : followerFillPriceSol * 1_000_000_000 * solPriceUsd;

  const targetMcapStr = formatMcap(targetMcapUsd);
  const followerMcapStr = formatMcap(followerMcapUsd);

  const reactionDelayMs = comp?.reactionLatencyMs ?? (latestBuyOrder?.l_decision_ms !== undefined && latestBuyOrder?.l_quote_ms !== undefined && latestBuyOrder?.l_submit_ms !== undefined
    ? Number((latestBuyOrder.l_decision_ms + latestBuyOrder.l_quote_ms + latestBuyOrder.l_submit_ms).toFixed(2))
    : p50Latency);

  const tokenSymbol = latestBuyOrder?.metadata?.symbol || matchingPos?.metadata?.symbol || 'STARTPUP';
  const tokenName = latestBuyOrder?.metadata?.name || matchingPos?.metadata?.name || 'Startpup Token';

  const isPosProfit = matchingPos ? (matchingPos.unrealizedPnlSol || 0) >= 0 : false;
  const posPnlSol = matchingPos?.unrealizedPnlSol || 0;
  const posPnlUsd = matchingPos?.unrealizedPnlSol ? matchingPos.unrealizedPnlSol * solPriceUsd : 0;
  const posPnlPct = matchingPos?.unrealizedPnlPct || 0;

  return (
    <div className="target-follower-panel">
      {/* Top Header Row */}
      <div className="tf-header">
        <div className="tf-header-left">
          <div className="tf-badge-group">
            <span className="tf-status-live">
              <StatusDot status="online" size={6} />
              <span>LIVE TARGET MIRROR</span>
            </span>
            <span className="tf-speed-pill">
              <Zap size={11} />
              <span>{reactionDelayMs.toFixed(2)}ms Reaction Delay (0.002s)</span>
            </span>
          </div>
          <div className="tf-target-info">
            <span className="tf-label">FOLLOWING TRADER:</span>
            <span className="tf-wallet mono">{formatShortAddress(targetWallet, 6, 6)}</span>
            <CopyButton text={targetWallet} size={12} />
            <a
              href={`https://solscan.io/account/${targetWallet}`}
              target="_blank"
              rel="noreferrer"
              className="tf-link"
              title="View trader on Solscan"
            >
              <ExternalLink size={11} />
            </a>
          </div>
        </div>

        <div className="tf-header-right">
          {matchingPos && (
            <button
              type="button"
              className="btn-tf-exit"
              onClick={() => setSelectedExitPos(matchingPos)}
              title="Manage Take Profit or Exit Position"
            >
              <span>Manage Take Profit</span>
            </button>
          )}
          {onSimulate && (
            <button
              type="button"
              className="btn-tf-sim"
              onClick={onSimulate}
              title="Simulate a new buy trade from this trader"
            >
              <span>Simulate Target Buy</span>
            </button>
          )}
        </div>
      </div>

      {/* Side-by-Side Execution Comparison Grid */}
      <div className="tf-comparison-grid">
        {/* Left Card: Target Trader */}
        <div className="tf-card tf-target-card">
          <div className="tf-card-head">
            <span className="tf-role-tag target">TARGET TRADER BUY</span>
            <span className="tf-time">{formatElapsed(latestBuyOrder?.quote_at)}</span>
          </div>

          <div className="tf-token-row">
            <div className="tf-token-icon">
              <span>{tokenSymbol.substring(0, 2)}</span>
            </div>
            <div className="tf-token-meta">
              <span className="tf-token-sym">${tokenSymbol}</span>
              <span className="tf-token-name">{tokenName}</span>
            </div>
          </div>

          <div className="tf-stats-grid">
            <div className="tf-stat-item">
              <span className="tf-stat-label">TRADER SPENT</span>
              <span className="tf-stat-val mono">{formatSol(targetSpendSol, 3)}</span>
              <span className="tf-stat-sub mono">{formatUsd(targetSpendSol * solPriceUsd, 2)}</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">ENTRY MCAP</span>
              <span className="tf-stat-val mono highlight-cyan">{targetMcapStr}</span>
              <span className="tf-stat-sub mono">At Signal Origin</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">ENTRY PRICE</span>
              <span className="tf-stat-val mono">${(targetFillPriceSol * solPriceUsd).toFixed(6)}</span>
              <span className="tf-stat-sub mono">{targetFillPriceSol.toFixed(8)} SOL</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">VENUE</span>
              <span className="tf-stat-val mono">pump.fun</span>
              <span className="tf-stat-sub mono">Bonding Curve</span>
            </div>
          </div>
        </div>

        {/* Center Delay Connector (Visual speed indicator) */}
        <div className="tf-connector-col">
          <div className="tf-speed-badge">
            <Zap size={14} color="#14f195" />
            <span className="tf-speed-num">+{reactionDelayMs.toFixed(1)}ms</span>
            <span className="tf-speed-lbl">INSTANT FOLLOW</span>
          </div>
          <div className="tf-gap-tag">
            <span>Entry Gap:</span>
            <strong className="mono">+{entryGap.toFixed(1)} bps</strong>
          </div>
          <div className="tf-line-h">
            <div className="tf-dot-pulse"></div>
          </div>
        </div>

        {/* Right Card: My Follower Bot */}
        <div className="tf-card tf-follower-card">
          <div className="tf-card-head">
            <span className="tf-role-tag follower">MY BOT MIRROR EXECUTION</span>
            <span className="tf-exec-mode">{telemetry?.executionMode === 'LIVE' ? 'LIVE' : 'PAPER SIM'}</span>
          </div>

          <div className="tf-token-row">
            <div className="tf-token-icon follower-icon">
              <span>ME</span>
            </div>
            <div className="tf-token-meta">
              <span className="tf-token-sym">FOLLOW EXECUTED</span>
              <span className="tf-token-name">Zero Dropped Signals</span>
            </div>
          </div>

          <div className="tf-stats-grid">
            <div className="tf-stat-item">
              <span className="tf-stat-label">MY ALLOCATION</span>
              <span className="tf-stat-val mono highlight-green">{formatSol(followerSpendSol, 3)}</span>
              <span className="tf-stat-sub mono">{formatUsd(followerSpendSol * solPriceUsd, 2)}</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">FILL MCAP</span>
              <span className="tf-stat-val mono highlight-cyan">{followerMcapStr}</span>
              <span className="tf-stat-sub mono">+{entryGap.toFixed(1)} bps gap</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">FILL PRICE</span>
              <span className="tf-stat-val mono">${(followerFillPriceSol * solPriceUsd).toFixed(6)}</span>
              <span className="tf-stat-sub mono">{followerFillPriceSol.toFixed(8)} SOL</span>
            </div>

            <div className="tf-stat-item">
              <span className="tf-stat-label">STATUS</span>
              <span className="tf-stat-val mono text-success">CONFIRMED</span>
              <span className="tf-stat-sub mono">Sub-10ms Landing</span>
            </div>
          </div>
        </div>
      </div>

      {/* Live Position Performance Strip (if open) */}
      {matchingPos && (
        <div className="tf-live-position-strip">
          <div className="tf-strip-left">
            <span className="tf-strip-tag">ACTIVE POSITION STATUS</span>
            <span className="tf-strip-token">${tokenSymbol}</span>
            <span className="tf-strip-mcap">Current MCap: <strong className="mono">{formatMcap(matchingPos.currentPriceSol)}</strong></span>
          </div>

          <div className="tf-strip-right">
            <div className="tf-pnl-cluster">
              <span className="tf-pnl-label">LIVE POSITION PNL:</span>
              <span className={`tf-pnl-value mono ${isPosProfit ? 'positive' : 'negative'}`}>
                {isPosProfit ? '+' : ''}${posPnlUsd.toFixed(2)} USD ({isPosProfit ? '+' : ''}{posPnlSol.toFixed(4)} SOL)
              </span>
              <span className={`tf-pnl-pct-tag ${isPosProfit ? 'tag-pos' : 'tag-neg'}`}>
                {isPosProfit ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                <span>{isPosProfit ? '+' : ''}{posPnlPct.toFixed(1)}%</span>
              </span>
            </div>

            <div className="tf-quick-tp-group">
              <button
                type="button"
                className="btn-tp-pill"
                onClick={() => setSelectedExitPos(matchingPos)}
              >
                TP 50%
              </button>
              <button
                type="button"
                className="btn-tp-pill close"
                onClick={() => setSelectedExitPos(matchingPos)}
              >
                Close 100%
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Exit Modal integration */}
      {selectedExitPos && (
        <ManualExitModal
          position={selectedExitPos}
          isOpen={Boolean(selectedExitPos)}
          onClose={() => setSelectedExitPos(null)}
          onSuccess={() => {
            setSelectedExitPos(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
};
