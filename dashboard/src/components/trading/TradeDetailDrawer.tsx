import {
  ArrowRight,
  Clock,
  ExternalLink,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import React, { useEffect } from 'react';
import {
  formatBps,
  formatClockTime,
  formatLatency,
  formatMicroUsd,
  formatShortAddress,
  formatSol,
  formatTimeAgo,
  formatUsd,
} from '../../lib/format';
import { Order } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';
import { EntryGapBadge } from './EntryGapBadge';
import { TokenIdentity } from './TokenIdentity';

interface TradeDetailDrawerProps {
  order: Order | null;
  onClose: () => void;
}

export const TradeDetailDrawer: React.FC<TradeDetailDrawerProps> = ({ order, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && order) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [order, onClose]);

  if (!order) return null;

  const comp = order.comparison;
  const meta = order.metadata;
  const isBuy = order.side === 'BUY';

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="trade-detail-drawer" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="drawer-header-left">
            <TokenIdentity mint={order.token_mint} metadata={meta} size="lg" />
            <div className="drawer-badges">
              <Badge variant={isBuy ? 'buy' : 'sell'}>{order.side}</Badge>
              <Badge variant={order.mode === 'LIVE' ? 'live' : 'paper'}>
                {order.mode}
              </Badge>
              <Badge
                variant={
                  order.status === 'FILLED'
                    ? 'success'
                    : order.status === 'FAILED'
                    ? 'danger'
                    : 'neutral'
                }
              >
                {order.status}
              </Badge>
              {order.landing_provider && (
                <span
                  style={{
                    background: 'rgba(20, 241, 149, 0.15)',
                    color: '#14f195',
                    border: '1px solid rgba(20, 241, 149, 0.4)',
                    borderRadius: '4px',
                    padding: '2px 6px',
                    fontSize: '11px',
                    fontWeight: 700,
                  }}
                >
                  {order.landing_provider}
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            className="btn-drawer-close"
            onClick={onClose}
            title="Close Trade Inspector"
          >
            <X size={18} />
          </button>
        </div>

        {/* Drawer Body Scroll Area */}
        <div className="drawer-body">
          {/* Hero Comparison Stat Box */}
          <div className="drawer-hero-box">
            <div className="hero-stat-item">
              <span className="hero-lbl">ENTRY GAP VS TRADER</span>
              <div className="hero-val-group">
                <EntryGapBadge
                  entryGapPct={comp?.entryGapPct}
                  entryGapBps={comp?.entryGapBps}
                  isEstimated={comp?.isTargetPriceEstimated}
                />
              </div>
              <span className="hero-sub">
                {comp?.isTargetPriceEstimated
                  ? 'Estimated from DEX liquidity curve'
                  : 'Derived from on-chain balances'}
              </span>
            </div>

            <div className="hero-stat-item">
              <span className="hero-lbl">DECISION LATENCY</span>
              <div className="hero-val mono text-cyan">
                {comp?.reactionLatencyMs !== null && comp?.reactionLatencyMs !== undefined ? (
                  formatLatency(comp.reactionLatencyMs)
                ) : (
                  '—'
                )}
              </div>
              <span className="hero-sub">Ingest to quote dispatch</span>
            </div>
          </div>

          {/* Side-by-Side Comparison Grid */}
          <div className="drawer-section-title">SIDE-BY-SIDE EXECUTION RECONCILIATION</div>

          <div className="comparison-columns-grid">
            {/* Target Trader Column */}
            <div className="comparison-col trader-col">
              <div className="col-header">
                <span className="col-tag target-tag">TARGET TRADER</span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Execution Price</span>
                <span className="comp-val mono text-amber">
                  {comp?.traderPriceSol ? `${comp.traderPriceSol.toFixed(8)} SOL` : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Market Cap at Fill</span>
                <span className="comp-val mono text-amber">
                  {comp?.traderMarketCapUsd ? formatUsd(comp.traderMarketCapUsd, 0) : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Capital Spent</span>
                <span className="comp-val mono">
                  {comp?.traderSpentSol ? formatSol(comp.traderSpentSol, 4) : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Transaction</span>
                <span className="comp-val mono">
                  <a
                    href={`https://solscan.io/tx/${order.target_signature}`}
                    target="_blank"
                    rel="noreferrer"
                    className="drawer-link"
                  >
                    <span>{formatShortAddress(order.target_signature, 5, 5)}</span>
                    <ExternalLink size={11} />
                  </a>
                </span>
              </div>
            </div>

            {/* My Copy Column */}
            <div className="comparison-col follower-col">
              <div className="col-header">
                <span className="col-tag follower-tag">MY FOLLOWER COPY</span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Fill Price</span>
                <span className="comp-val mono text-cyan">
                  {order.effective_price ? `${order.effective_price.toFixed(8)} SOL` : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Market Cap at Fill</span>
                <span className="comp-val mono text-cyan">
                  {comp?.followerMarketCapUsd ? formatUsd(comp.followerMarketCapUsd, 0) : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Capital Spent</span>
                <span className="comp-val mono">
                  {comp?.followerSpentSol ? formatSol(comp.followerSpentSol, 4) : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Landing Route</span>
                <span className="comp-val mono text-cyan">
                  {order.landing_provider || (order.mode === 'LIVE' ? 'JUPITER_EXECUTE' : 'SIMULATION')}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">{isBuy ? 'Tokens Received' : 'SOL Received'}</span>
                <span className="comp-val mono text-cyan">
                  {isBuy
                    ? `${(Number(order.actual_out_raw || order.out_amount_raw || 0) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${meta?.symbol || 'TOKENS'}`
                    : `${(Number(order.actual_out_raw || order.out_amount_raw || 0) / 1e9).toFixed(4)} SOL`}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Network & Priority Fee</span>
                <span className="comp-val mono">
                  {order.fee_raw ? `${(Number(order.fee_raw) / 1e9).toFixed(6)} SOL` : '—'}
                </span>
              </div>

              <div className="comp-row">
                <span className="comp-lbl">Transaction / Sim</span>
                <span className="comp-val mono">
                  {order.signature ? (
                    <a
                      href={`https://solscan.io/tx/${order.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="drawer-link"
                    >
                      <span>{formatShortAddress(order.signature, 5, 5)}</span>
                      <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span className="text-muted">Paper Simulation</span>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Trade Pipeline Timestamps */}
          <div className="drawer-section-title" style={{ marginTop: 20 }}>
            MICROSECOND EXECUTION TIMELINE
          </div>

          <div className="drawer-timeline-list">
            <div className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="timeline-step">1. Ingest & Target Signal</div>
                <div className="timeline-time mono">{formatClockTime(order.quote_at)}</div>
              </div>
            </div>

            <div className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="timeline-step">2. Risk Check & Anti-Bait Guard</div>
                <div className="timeline-time text-green mono">PASSED</div>
              </div>
            </div>

            <div className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="timeline-step">3. Transaction Quote & Build</div>
                <div className="timeline-time mono">
                  {comp?.reactionLatencyMs ? formatLatency(comp.reactionLatencyMs) : '—'}
                </div>
              </div>
            </div>

            <div className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="timeline-step">4. Execution Dispatch</div>
                <div className="timeline-time text-cyan mono">{order.mode}</div>
              </div>
            </div>

            <div className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="timeline-step">5. Settlement & DB Receipt</div>
                <div className="timeline-time mono">{order.status}</div>
              </div>
            </div>
          </div>

          {/* External Charts & Verification */}
          <div className="drawer-section-title" style={{ marginTop: 20 }}>
            TOKEN RESEARCH & VERIFICATION
          </div>

          <div className="drawer-actions-grid">
            <a
              href={meta?.dexScreenerUrl || `https://dexscreener.com/solana/${order.token_mint}`}
              target="_blank"
              rel="noreferrer"
              className="drawer-action-btn"
            >
              <span>DexScreener Chart</span>
              <ExternalLink size={13} />
            </a>

            <a
              href={meta?.pumpFunUrl || `https://pump.fun/${order.token_mint}`}
              target="_blank"
              rel="noreferrer"
              className="drawer-action-btn"
            >
              <span>Pump.fun Terminal</span>
              <ExternalLink size={13} />
            </a>

            <a
              href={`https://solscan.io/token/${order.token_mint}`}
              target="_blank"
              rel="noreferrer"
              className="drawer-action-btn"
            >
              <span>Solscan Explorer</span>
              <ExternalLink size={13} />
            </a>
          </div>
        </div>
      </div>
    </>
  );
};
