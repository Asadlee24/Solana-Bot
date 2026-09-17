import { ArrowRight, ExternalLink, Filter, Search } from 'lucide-react';
import React, { useState } from 'react';
import {
  formatClockTime,
  formatLatency,
  formatShortAddress,
  formatSol,
  formatTimeAgo,
} from '../../lib/format';
import { Order } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { EmptyState } from '../common/EmptyState';
import { EntryGapBadge } from './EntryGapBadge';
import { TokenIdentity } from './TokenIdentity';
import { TradeDetailDrawer } from './TradeDetailDrawer';

interface TradeFeedProps {
  orders: Order[];
  isLoading?: boolean;
  limit?: number;
}

export const TradeFeed: React.FC<TradeFeedProps> = ({ orders, isLoading, limit }) => {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredOrders = orders.filter((o) => {
    if (sideFilter !== 'ALL' && o.side !== sideFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const symbolMatch = o.metadata?.symbol?.toLowerCase().includes(q);
      const nameMatch = o.metadata?.name?.toLowerCase().includes(q);
      const mintMatch = o.token_mint.toLowerCase().includes(q);
      if (!symbolMatch && !nameMatch && !mintMatch) return false;
    }
    return true;
  });

  const displayOrders = limit ? filteredOrders.slice(0, limit) : filteredOrders;

  return (
    <div className="trade-feed-root">
      {/* Search and Filters Bar */}
      <div className="trade-feed-controls">
        <div className="search-input-wrapper">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            className="terminal-search-input"
            placeholder="Filter by token name, symbol, or mint address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-pill-group">
          <button
            type="button"
            className={`filter-pill ${sideFilter === 'ALL' ? 'active' : ''}`}
            onClick={() => setSideFilter('ALL')}
          >
            All Trades ({orders.length})
          </button>
          <button
            type="button"
            className={`filter-pill ${sideFilter === 'BUY' ? 'active' : ''}`}
            onClick={() => setSideFilter('BUY')}
          >
            Buys
          </button>
          <button
            type="button"
            className={`filter-pill ${sideFilter === 'SELL' ? 'active' : ''}`}
            onClick={() => setSideFilter('SELL')}
          >
            Sells
          </button>
        </div>
      </div>

      {/* Desktop Dense Table */}
      <div className="table-responsive-wrapper hide-mobile">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>Time / Mode</th>
              <th>Token</th>
              <th>Side</th>
              <th>Target Entry</th>
              <th>My Fill Entry</th>
              <th>Entry Gap</th>
              <th>Copy Spend</th>
              <th>Reaction</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Inspect</th>
            </tr>
          </thead>
          <tbody>
            {displayOrders.length === 0 ? (
              <tr>
                <td colSpan={10}>
                  <EmptyState
                    title="No Trades Recorded"
                    description={
                      isLoading
                        ? 'Loading incoming stream trades...'
                        : 'Mirror engine will execute and log trades when target wallet activity is detected.'
                    }
                  />
                </td>
              </tr>
            ) : (
              displayOrders.map((order) => {
                const comp = order.comparison;
                const isBuy = order.side === 'BUY';

                return (
                  <tr
                    key={order.order_id}
                    className="trade-row-interactive"
                    onClick={() => setSelectedOrder(order)}
                  >
                    {/* Time & Mode */}
                    <td>
                      <div className="time-mode-cell">
                        <span className="time-primary mono">{formatClockTime(order.quote_at)}</span>
                        <span className="time-sub text-muted">{formatTimeAgo(order.quote_at)}</span>
                        <span className="tag-mode">{order.mode}</span>
                      </div>
                    </td>

                    {/* Token */}
                    <td>
                      <TokenIdentity mint={order.token_mint} metadata={order.metadata} />
                    </td>

                    {/* Side */}
                    <td>
                      <Badge variant={isBuy ? 'buy' : 'sell'}>{order.side}</Badge>
                    </td>

                    {/* Target Entry */}
                    <td>
                      <div className="price-cell">
                        <span className="price-val mono text-amber">
                          {comp?.traderPriceSol ? `${comp.traderPriceSol.toFixed(8)} SOL` : '—'}
                        </span>
                        {comp?.isTargetPriceEstimated && (
                          <span className="tag-est" title="Estimated from pool reserve">
                            EST
                          </span>
                        )}
                      </div>
                    </td>

                    {/* My Fill Entry */}
                    <td>
                      <div className="price-cell">
                        <span className="price-val mono text-cyan">
                          {order.effective_price ? `${order.effective_price.toFixed(8)} SOL` : '—'}
                        </span>
                      </div>
                    </td>

                    {/* Entry Gap */}
                    <td>
                      <EntryGapBadge
                        entryGapPct={comp?.entryGapPct}
                        entryGapBps={comp?.entryGapBps}
                        isEstimated={comp?.isTargetPriceEstimated}
                      />
                    </td>

                    {/* Copy Spend */}
                    <td>
                      <div className="spend-cell mono">
                        <span>{comp?.followerSpentSol ? formatSol(comp.followerSpentSol, 3) : '—'}</span>
                        {comp?.followerSpentUsd ? (
                          <span className="text-muted" style={{ fontSize: 10 }}>
                            (~${comp.followerSpentUsd.toFixed(2)})
                          </span>
                        ) : null}
                      </div>
                    </td>

                    {/* Reaction */}
                    <td>
                      <div className="latency-cell mono">
                        {comp?.reactionLatencyMs !== null && comp?.reactionLatencyMs !== undefined ? (
                          <span className="text-cyan">
                            {formatLatency(comp.reactionLatencyMs)}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td>
                      <Badge
                        variant={
                          order.status === 'FILLED'
                            ? 'success'
                            : order.status === 'FAILED'
                            ? 'danger'
                            : 'neutral'
                        }
                        size="sm"
                      >
                        {order.status}
                      </Badge>
                    </td>

                    {/* Inspect Trigger */}
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn-inspect-trade"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedOrder(order);
                        }}
                      >
                        <span>Details</span>
                        <ArrowRight size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Trade Cards */}
      <div className="mobile-trade-cards show-mobile">
        {displayOrders.length === 0 ? (
          <EmptyState
            title="No Trades Recorded"
            description="Incoming target trades will display here."
          />
        ) : (
          displayOrders.map((order) => {
            const comp = order.comparison;
            const isBuy = order.side === 'BUY';

            return (
              <div
                key={order.order_id}
                className="mobile-trade-card"
                onClick={() => setSelectedOrder(order)}
              >
                <div className="card-top">
                  <TokenIdentity mint={order.token_mint} metadata={order.metadata} size="sm" />
                  <div className="card-top-badges">
                    <Badge variant={isBuy ? 'buy' : 'sell'} size="sm">
                      {order.side}
                    </Badge>
                    <Badge variant={order.status === 'FILLED' ? 'success' : 'neutral'} size="sm">
                      {order.status}
                    </Badge>
                  </div>
                </div>

                <div className="card-stats-grid">
                  <div className="card-stat">
                    <span className="lbl">My Entry</span>
                    <span className="val mono text-cyan">
                      {order.effective_price ? `${order.effective_price.toFixed(8)} SOL` : '—'}
                    </span>
                  </div>

                  <div className="card-stat">
                    <span className="lbl">Target Entry</span>
                    <span className="val mono text-amber">
                      {comp?.traderPriceSol ? `${comp.traderPriceSol.toFixed(8)} SOL` : '—'}
                    </span>
                  </div>

                  <div className="card-stat">
                    <span className="lbl">Entry Gap</span>
                    <EntryGapBadge
                      entryGapPct={comp?.entryGapPct}
                      entryGapBps={comp?.entryGapBps}
                      isEstimated={comp?.isTargetPriceEstimated}
                    />
                  </div>

                  <div className="card-stat">
                    <span className="lbl">Reaction</span>
                    <span className="val mono text-cyan">
                      {comp?.reactionLatencyMs !== null && comp?.reactionLatencyMs !== undefined
                        ? formatLatency(comp.reactionLatencyMs)
                        : '—'}
                    </span>
                  </div>
                </div>

                <div className="card-footer">
                  <span className="text-muted mono">{formatClockTime(order.quote_at)}</span>
                  <span className="btn-mobile-inspect">Inspect Details →</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Slide-in Detail Drawer */}
      <TradeDetailDrawer
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  );
};
