import { DollarSign, ExternalLink, Flame, TrendingDown, TrendingUp, Zap } from 'lucide-react';
import React, { useState } from 'react';
import {
  formatMicroUsd,
  formatPct,
  formatSol,
  formatTimeAgo,
  formatTokenQty,
  formatUsd,
} from '../../lib/format';
import { Position } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { EmptyState } from '../common/EmptyState';
import { TokenIdentity } from '../trading/TokenIdentity';
import { ManualExitModal } from './ManualExitModal';

interface PositionsTableProps {
  positions: Position[];
  isLoading?: boolean;
  onRefresh?: () => void;
}

export const PositionsTable: React.FC<PositionsTableProps> = ({ positions, isLoading, onRefresh }) => {
  const [tabFilter, setTabFilter] = useState<'OPEN' | 'ALL'>('OPEN');
  const [selectedExitPos, setSelectedExitPos] = useState<Position | null>(null);

  const filtered = tabFilter === 'OPEN'
    ? positions.filter((p) => p.state === 'OPEN')
    : positions;

  return (
    <div className="positions-table-root">
      {/* Tab Filter */}
      <div className="positions-controls">
        <div className="filter-pill-group">
          <button
            type="button"
            className={`filter-pill ${tabFilter === 'OPEN' ? 'active' : ''}`}
            onClick={() => setTabFilter('OPEN')}
          >
            Active Holdings ({positions.filter((p) => p.state === 'OPEN').length})
          </button>
          <button
            type="button"
            className={`filter-pill ${tabFilter === 'ALL' ? 'active' : ''}`}
            onClick={() => setTabFilter('ALL')}
          >
            All Portfolio Positions ({positions.length})
          </button>
        </div>
      </div>

      <div className="table-responsive-wrapper">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Copied Trader</th>
              <th>Holding Qty</th>
              <th>Cost Basis (USD & SOL)</th>
              <th>Avg Entry Price</th>
              <th>Current Live Price</th>
              <th>Market Value</th>
              <th>Live Profit / Loss</th>
              <th>State</th>
              <th style={{ textAlign: 'right' }}>Manual Actions & DEX</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10}>
                  <EmptyState
                    title="No Positions Found"
                    description={
                      isLoading
                        ? 'Loading positions...'
                        : tabFilter === 'OPEN'
                        ? 'No open follower positions currently active. The bot will automatically hold positions on target buys.'
                        : 'No positions recorded yet.'
                    }
                  />
                </td>
              </tr>
            ) : (
              filtered.map((pos) => {
                const meta = pos.metadata;
                const costSol = (pos as any).costBasisSol ?? (Number(pos.costBasisLamports) / 1e9);
                const solPrice = (pos as any).solPriceUsd || 140.0;
                const costUsd = (pos as any).costBasisUsd ?? (costSol * solPrice);
                const pnlSol = pos.unrealizedPnlSol ?? 0;
                const pnlUsd = (pos.currentValueUsd ?? 0) - costUsd;
                const pnlPct = pos.unrealizedPnlPct ?? 0;
                const isProfit = pnlSol >= 0;

                const priceUsd = meta?.priceUsd || (pos.currentPriceSol ? pos.currentPriceSol * solPrice : 0);

                return (
                  <tr key={pos.id}>
                    {/* Token */}
                    <td>
                      <TokenIdentity mint={pos.tokenMint} metadata={meta} />
                    </td>

                    {/* Copied Trader */}
                    <td>
                      <div className="trader-cell" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span className="font-semibold text-cyan" style={{ fontSize: '12px' }}>
                          {(pos as any).traderLabel || 'Alpha Whale'}
                        </span>
                        {pos.targetWallet && pos.targetWallet !== 'On-Chain Wallet' ? (
                          <a
                            href={`https://solscan.io/account/${pos.targetWallet}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted mono hover:underline"
                            style={{ fontSize: '10.5px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                          >
                            <span>{`${pos.targetWallet.slice(0, 4)}...${pos.targetWallet.slice(-4)}`}</span>
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="text-muted mono" style={{ fontSize: '10.5px' }}>Hot Wallet</span>
                        )}
                      </div>
                    </td>

                    {/* Quantity */}
                    <td>
                      <div className="mono font-semibold">
                        {formatTokenQty(pos.qtyRaw, (pos as any).decimals || 6)}
                      </div>
                    </td>

                    {/* Cost Basis */}
                    <td>
                      <div className="cost-basis-cell">
                        <span className="mono font-semibold">${costUsd.toFixed(2)} USD</span>
                        <span className="mono text-muted" style={{ fontSize: 10 }}>
                          ({formatSol(costSol, 4)})
                        </span>
                      </div>
                    </td>

                    {/* Avg Entry Price */}
                    <td>
                      <div className="mono text-muted">
                        {pos.avgEntryPriceSol ? `${pos.avgEntryPriceSol.toFixed(8)} SOL` : '—'}
                      </div>
                    </td>

                    {/* Current Live Price */}
                    <td>
                      <div className="price-cell">
                        <span className="mono text-cyan font-bold">
                          ${priceUsd < 0.01 ? priceUsd.toFixed(7) : priceUsd.toFixed(4)} USD
                        </span>
                        <span className="mono text-muted" style={{ fontSize: 10 }}>
                          ({pos.currentPriceSol ? `${pos.currentPriceSol.toFixed(8)} SOL` : '—'})
                        </span>
                      </div>
                    </td>

                    {/* Current Value */}
                    <td>
                      <div className="mono font-bold">
                        {pos.currentValueUsd ? `$${pos.currentValueUsd.toFixed(2)} USD` : '—'}
                        <div className="text-muted" style={{ fontSize: 10 }}>
                          ({pos.currentValueSol ? formatSol(pos.currentValueSol, 4) : '—'})
                        </div>
                      </div>
                    </td>

                    {/* Floating PnL with Dollars & SOL */}
                    <td>
                      {pos.state === 'OPEN' ? (
                        <div>
                          <div className={`pnl-pill-dual ${isProfit ? 'pos' : 'neg'}`}>
                            <div className="pnl-header-line">
                              {isProfit ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                              <span className="mono font-bold">
                                {isProfit ? '+' : '-'}${Math.abs(pnlUsd).toFixed(2)} USD
                              </span>
                            </div>
                            <div className="pnl-sub-line mono">
                              <span>{isProfit ? '+' : ''}{pnlSol.toFixed(4)} SOL</span>
                              <span className="pnl-tag-pct">{formatPct(pnlPct, true)}</span>
                            </div>
                          </div>
                          {pos.isBreakevenLocked && (
                            <div
                              className="mono"
                              style={{
                                fontSize: 10,
                                marginTop: 4,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                color: '#34d399',
                                background: 'rgba(16, 185, 129, 0.12)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                border: '1px solid rgba(16, 185, 129, 0.3)',
                                fontWeight: 600,
                              }}
                              title={`Highest Peak: +${pos.peakPnlPct}%. Stop-loss floor locked at ${pos.trailingFloorPct ? `+${pos.trailingFloorPct}%` : 'Breakeven (+2%)'}`}
                            >
                              <span>🛡️</span>
                              <span>
                                {pos.trailingFloorPct !== null && pos.trailingFloorPct !== undefined && pos.trailingFloorPct > 2
                                  ? `Trailing Floor: +${pos.trailingFloorPct}%`
                                  : `Zero-Loss Locked`}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="mono text-muted">
                          Closed ({formatSol(Number(pos.realizedPnlLamports) / 1e9, 4)})
                        </div>
                      )}
                    </td>

                    {/* State */}
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        <Badge variant={pos.state === 'OPEN' ? 'success' : 'neutral'} size="sm">
                          {pos.state}
                        </Badge>
                        {pos.state === 'OPEN' && pos.isBreakevenLocked && (
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: '#10b981',
                              letterSpacing: 0.5,
                            }}
                          >
                            SAFE (0-LOSS) 🔒
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Manual Actions & External DEX Links */}
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions-cell-right">
                        {pos.state === 'OPEN' && (
                          <>
                            <button
                              type="button"
                              className="btn-table-action tp-btn"
                              onClick={() => setSelectedExitPos(pos)}
                              title="Manual Take Profit / Partial Exit"
                            >
                              <span>Take Profit</span>
                            </button>
                            <button
                              type="button"
                              className="btn-table-action close-btn"
                              onClick={() => setSelectedExitPos(pos)}
                              title="Close 100% Position"
                            >
                              <span>Close</span>
                            </button>
                          </>
                        )}

                        <a
                          href={meta?.dexScreenerUrl || `https://dexscreener.com/solana/${pos.tokenMint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-table-icon-link"
                          title="Open DexScreener Live Chart"
                        >
                          <span>Dex</span>
                          <ExternalLink size={11} />
                        </a>

                        <a
                          href={meta?.pumpFunUrl || `https://pump.fun/${pos.tokenMint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-table-icon-link"
                          title="Open Pump.fun Bonding Curve"
                        >
                          <span>Pump</span>
                          <ExternalLink size={11} />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Manual Take Profit / Close Modal */}
      <ManualExitModal
        position={selectedExitPos}
        isOpen={Boolean(selectedExitPos)}
        onClose={() => setSelectedExitPos(null)}
        onSuccess={onRefresh}
      />
    </div>
  );
};
