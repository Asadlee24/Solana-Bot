import { ExternalLink, TrendingDown, TrendingUp } from 'lucide-react';
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

interface PositionsTableProps {
  positions: Position[];
  isLoading?: boolean;
}

export const PositionsTable: React.FC<PositionsTableProps> = ({ positions, isLoading }) => {
  const [tabFilter, setTabFilter] = useState<'OPEN' | 'ALL'>('OPEN');

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
              <th>Holding Qty</th>
              <th>Cost Basis</th>
              <th>Avg Entry Price</th>
              <th>Current Live Price</th>
              <th>Current Market Value</th>
              <th>Floating PnL</th>
              <th>State</th>
              <th style={{ textAlign: 'right' }}>DEX Charts</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9}>
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
                const costSol = Number(pos.costBasisLamports) / 1e9;
                const pnlSol = pos.unrealizedPnlSol ?? 0;
                const pnlPct = pos.unrealizedPnlPct ?? 0;
                const isProfit = pnlSol >= 0;

                return (
                  <tr key={pos.id}>
                    {/* Token */}
                    <td>
                      <TokenIdentity mint={pos.tokenMint} metadata={meta} />
                    </td>

                    {/* Quantity */}
                    <td>
                      <div className="mono font-semibold">
                        {formatTokenQty(pos.qtyRaw, 6)}
                      </div>
                    </td>

                    {/* Cost Basis */}
                    <td>
                      <div className="mono">
                        <span>{formatSol(costSol, 4)}</span>
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
                        <span className="mono text-cyan font-semibold">
                          {pos.currentPriceSol ? `${pos.currentPriceSol.toFixed(8)} SOL` : '—'}
                        </span>
                        {meta?.priceUsd ? (
                          <span className="text-muted" style={{ fontSize: 10 }}>
                            {formatMicroUsd(meta.priceUsd)}
                          </span>
                        ) : null}
                      </div>
                    </td>

                    {/* Current Value */}
                    <td>
                      <div className="mono font-semibold">
                        {pos.currentValueSol ? formatSol(pos.currentValueSol, 4) : '—'}
                        {pos.currentValueUsd ? (
                          <div className="text-muted" style={{ fontSize: 10 }}>
                            (~${pos.currentValueUsd.toFixed(2)})
                          </div>
                        ) : null}
                      </div>
                    </td>

                    {/* Floating PnL */}
                    <td>
                      {pos.state === 'OPEN' ? (
                        <div className={`pnl-pill ${isProfit ? 'pos' : 'neg'}`}>
                          {isProfit ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          <span className="mono">
                            {isProfit ? '+' : ''}
                            {pnlSol.toFixed(4)} SOL
                          </span>
                          <span className="pnl-pct">{formatPct(pnlPct, true)}</span>
                        </div>
                      ) : (
                        <div className="mono text-muted">
                          Closed ({formatSol(Number(pos.realizedPnlLamports) / 1e9, 4)})
                        </div>
                      )}
                    </td>

                    {/* State */}
                    <td>
                      <Badge variant={pos.state === 'OPEN' ? 'success' : 'neutral'} size="sm">
                        {pos.state}
                      </Badge>
                    </td>

                    {/* External DEX Links */}
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions-cell-right">
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
    </div>
  );
};
