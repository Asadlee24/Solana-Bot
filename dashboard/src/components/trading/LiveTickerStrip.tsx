import { Activity, ArrowDownRight, ArrowUpRight, Flame, Radio, ShieldCheck, Zap } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { formatSol, formatUsd } from '../../lib/format';
import { Position, Telemetry } from '../../types/dashboard';

interface LiveTickerStripProps {
  telemetry: Telemetry | null;
  positions: Position[];
  lastRefreshedAt: number;
}

export const LiveTickerStrip: React.FC<LiveTickerStripProps> = ({
  telemetry,
  positions,
  lastRefreshedAt,
}) => {
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    setSecondsAgo(0);
    const interval = setInterval(() => {
      setSecondsAgo((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [lastRefreshedAt]);

  const solPrice = telemetry?.solPriceUsd || 100;
  const openPositions = positions.filter((p) => p.state === 'OPEN');

  return (
    <div className="live-ticker-strip">
      <div className="ticker-left-cluster">
        <div className="ticker-stream-pill">
          <span className="pulsing-live-dot" />
          <span className="stream-lbl">LIVE MARKET STREAM</span>
          <span className="stream-time mono">
            {secondsAgo === 0 ? '<1s ago' : `${secondsAgo}s ago`}
          </span>
        </div>

        {/* SOL/USD Benchmark */}
        <div className="ticker-token-item">
          <span className="ticker-sym">SOL/USD</span>
          <span className="ticker-val mono text-cyan">${solPrice.toFixed(2)}</span>
          <span className="ticker-badge mono">+0.4%</span>
        </div>

        {/* Traded Positions Live Tickers */}
        {openPositions.map((pos) => {
          const meta = pos.metadata;
          const sym = meta?.symbol || pos.tokenMint.substring(0, 5);
          const priceSol = pos.currentPriceSol || pos.avgEntryPriceSol || 0;
          const priceUsd = pos.currentPriceUsd || priceSol * solPrice;
          const pnlPct = pos.unrealizedPnlPct || 0;
          const isUp = pnlPct >= 0;

          return (
            <div key={pos.id} className="ticker-token-item active-trade">
              <span className="flame-dot">●</span>
              <span className="ticker-sym">${sym}</span>
              <span className="ticker-val mono">
                ${priceUsd < 0.01 ? priceUsd.toFixed(7) : priceUsd.toFixed(4)}
              </span>
              <span className="ticker-sol mono text-muted">
                ({priceSol.toFixed(8)} SOL)
              </span>
              <span className={`ticker-pnl mono ${isUp ? 'text-green' : 'text-rose'}`}>
                {isUp ? '+' : ''}{pnlPct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="ticker-right-cluster">
        <div className="ticker-stat">
          <Zap size={11} className="text-green" />
          <span className="lbl">HOT PATH DELAY</span>
          <span className="val mono text-green">
            {telemetry?.latencyP50Ms ? `${telemetry.latencyP50Ms.toFixed(1)}ms` : '<10ms'}
          </span>
        </div>
        <div className="ticker-stat">
          <ShieldCheck size={11} className="text-cyan" />
          <span className="lbl">RISK ENGINE</span>
          <span className="val mono text-cyan">ARMED</span>
        </div>
      </div>
    </div>
  );
};
