import { ArrowUpRight, DollarSign, Layers, TrendingUp } from 'lucide-react';
import React from 'react';
import { formatPct, formatSol, formatUsd } from '../../lib/format';
import { Position, Telemetry } from '../../types/dashboard';
import { MetricCard } from '../common/MetricCard';

interface PositionsSummaryProps {
  positions: Position[];
  telemetry: Telemetry | null;
}

export const PositionsSummary: React.FC<PositionsSummaryProps> = ({
  positions,
  telemetry,
}) => {
  const openPositions = positions.filter((p) => p.state === 'OPEN');

  const totalCapitalDeployedLamports = openPositions.reduce(
    (acc, p) => acc + BigInt(p.costBasisLamports || '0'),
    0n
  );
  const totalCapitalDeployedSol = Number(totalCapitalDeployedLamports) / 1e9;
  const solPriceUsd = telemetry?.solPriceUsd || 100;

  const totalFloatingPnlSol = openPositions.reduce(
    (acc, p) => acc + (p.unrealizedPnlSol || 0),
    0
  );

  const realizedPnlSol = telemetry?.totalRealizedPnlSol || 0;
  const netPnlSol = realizedPnlSol + totalFloatingPnlSol;

  return (
    <div className="positions-summary-grid">
      <MetricCard
        label="Open Positions"
        value={openPositions.length}
        subValue={`${positions.length} Total Lifecycle Tokens`}
        icon={<Layers size={16} />}
        tone="cyan"
      />

      <MetricCard
        label="Capital Deployed"
        value={formatSol(totalCapitalDeployedSol, 3)}
        subValue={formatUsd(totalCapitalDeployedSol * solPriceUsd, 2)}
        icon={<DollarSign size={16} />}
        tone="default"
      />

      <MetricCard
        label="Floating Unrealized PnL"
        value={`${totalFloatingPnlSol >= 0 ? '+' : '-'}$${Math.abs(totalFloatingPnlSol * solPriceUsd).toFixed(2)} USD`}
        subValue={`${totalFloatingPnlSol >= 0 ? '+' : ''}${totalFloatingPnlSol.toFixed(4)} SOL`}
        icon={<TrendingUp size={16} />}
        tone={totalFloatingPnlSol >= 0 ? 'positive' : 'negative'}
      />

      <MetricCard
        label="Total Portfolio Net PnL"
        value={`${netPnlSol >= 0 ? '+' : '-'}$${Math.abs(netPnlSol * solPriceUsd).toFixed(2)} USD`}
        subValue={`${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL (Realized: $${(realizedPnlSol * solPriceUsd).toFixed(2)})`}
        icon={<ArrowUpRight size={16} />}
        tone={netPnlSol >= 0 ? 'positive' : 'negative'}
      />
    </div>
  );
};
