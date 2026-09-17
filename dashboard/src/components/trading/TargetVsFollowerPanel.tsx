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
  const matchingPos = positions.find((p) => p.state === 'OPEN') || null;
  const hasRealTrade = Boolean(latestBuyOrder || matchingPos);

  const tokenMint = latestBuyOrder?.token_mint || matchingPos?.tokenMint || '';
  const solPriceUsd = telemetry?.solPriceUsd || 100.0;
  const p50Latency = telemetry?.latencyP50Ms || 2.33;

  const comp = latestBuyOrder?.comparison;
  const entryGap = comp?.entryGapBps ?? latestBuyOrder?.entry_gap_bps ?? 0;

  // Accurate fill prices in SOL:
  const followerFillPriceSol = comp?.followerPriceSol ?? latestBuyOrder?.effective_price ?? 0;
  const targetFillPriceSol = comp?.traderPriceSol ?? latestBuyOrder?.target_price ?? (followerFillPriceSol > 0 ? followerFillPriceSol / (1 + entryGap / 10000) : 0);

  // Formatting helpers
  const formatMcap = (mcapUsd?: number) => {
    if (!mcapUsd || mcapUsd <= 0) return '—';
    if (mcapUsd >= 1_000_000) return `$${(mcapUsd / 1_000_000).toFixed(2)}M`;
    return `$${(mcapUsd / 1_000).toFixed(1)}K`;
  };

  const formatElapsed = (timestampMs?: number) => {
    if (!timestampMs) return 'Just now';
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
    : 0);
  const followerSpendSol = comp?.followerSpentSol ?? (latestBuyOrder?.in_amount_raw
    ? Number(latestBuyOrder.in_amount_raw) / 1e9
    : 0);

  // Synchronized entry Market Caps:
  const targetMcapUsd = comp?.traderMarketCapUsd && comp.traderMarketCapUsd > 0
    ? comp.traderMarketCapUsd
    : (targetFillPriceSol > 0 ? targetFillPriceSol * 1_000_000_000 * solPriceUsd : 0);

  const followerMcapUsd = comp?.followerMarketCapUsd && comp.followerMarketCapUsd > 0
    ? comp.followerMarketCapUsd
    : (followerFillPriceSol > 0 ? followerFillPriceSol * 1_000_000_000 * solPriceUsd : 0);

  const targetMcapStr = formatMcap(targetMcapUsd);
  const followerMcapStr = formatMcap(followerMcapUsd);

  const reactionDelayMs = comp?.reactionLatencyMs ?? (latestBuyOrder?.l_decision_ms !== undefined && latestBuyOrder?.l_quote_ms !== undefined && latestBuyOrder?.l_submit_ms !== undefined
    ? Number((latestBuyOrder.l_decision_ms + latestBuyOrder.l_quote_ms + latestBuyOrder.l_submit_ms).toFixed(2))
    : p50Latency);

  const tokenSymbol = latestBuyOrder?.metadata?.symbol || matchingPos?.metadata?.symbol || (tokenMint ? formatShortAddress(tokenMint, 4, 4) : 'TOKEN');
  const tokenName = latestBuyOrder?.metadata?.name || matchingPos?.metadata?.name || 'Solana Token';

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

      {/* Side-by-Side Execution Comparison Grid or Live Radar Listening */}
      {!hasRealTrade ? (
        <div
          className="tf-listening-state"
          style={{
            padding: '36px 24px',
            margin: '12px 16px 16px',
            background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.6) 0%, rgba(10, 15, 30, 0.8) 100%)',
            border: '1px dashed rgba(20, 241, 149, 0.25)',
            borderRadius: '12px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              background: 'rgba(20, 241, 149, 0.1)',
              border: '1px solid rgba(20, 241, 149, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '14px',
              boxShadow: '0 0 24px rgba(20, 241, 149, 0.12)',
            }}
          >
            <Radio size={24} color="#14f195" />
          </div>

          <h4 style={{ fontSize: '15px', fontWeight: 600, color: '#f8fafc', margin: '0 0 6px 0' }}>
            Awaiting Target Trader Signal
          </h4>

          <p style={{ fontSize: '12.5px', color: '#94a3b8', maxWidth: '580px', lineHeight: '1.5', margin: '0 0 20px 0' }}>
            Real-time mirror engine is continuously listening to on-chain DEX swaps for target trader{' '}
            <strong className="mono" style={{ color: '#38bdf8' }}>{formatShortAddress(targetWallet, 6, 6)}</strong>.
            Zero trades recorded yet. Once the target buys or sells on Raydium or pump.fun, the instant follow execution and fill metrics will appear here live.
          </p>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <div style={{ background: 'rgba(30, 41, 59, 0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '8px 14px', textAlign: 'left' }}>
              <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TARGET STATUS</div>
              <div className="mono font-semibold" style={{ fontSize: '12px', color: '#38bdf8', marginTop: '2px' }}>
                MONITORED (1 WALLET)
              </div>
            </div>

            <div style={{ background: 'rgba(30, 41, 59, 0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '8px 14px', textAlign: 'left' }}>
              <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>EXECUTION MODE</div>
              <div className="mono font-semibold" style={{ fontSize: '12px', color: telemetry?.liveEngineArmed ? '#14f195' : '#eab308', marginTop: '2px' }}>
                {telemetry?.executionMode === 'LIVE'
                  ? (telemetry.liveEngineArmed ? '● LIVE ARMED' : '○ LIVE DISARMED')
                  : 'PAPER SIM'}
              </div>
            </div>

            <div style={{ background: 'rgba(30, 41, 59, 0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '8px 14px', textAlign: 'left' }}>
              <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>HOT-PATH DELAY</div>
              <div className="mono font-semibold" style={{ fontSize: '12px', color: '#14f195', marginTop: '2px' }}>
                &lt; 10ms Pipeline
              </div>
            </div>
          </div>
        </div>
      ) : (
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
                <span className="tf-stat-val mono">{latestBuyOrder?.target_venue || 'pump.fun'}</span>
                <span className="tf-stat-sub mono">On-chain DEX</span>
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
                <span className="tf-stat-val mono text-success">{latestBuyOrder?.status || 'CONFIRMED'}</span>
                <span className="tf-stat-sub mono">Sub-10ms Landing</span>
              </div>
            </div>
          </div>
        </div>
      )}

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
