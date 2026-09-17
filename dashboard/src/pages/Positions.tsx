import React from 'react';
import { PositionsSummary } from '../components/positions/PositionsSummary';
import { PositionsTable } from '../components/positions/PositionsTable';
import { Position, Telemetry } from '../types/dashboard';

interface PositionsProps {
  positions: Position[];
  telemetry: Telemetry | null;
  isLoading?: boolean;
}

export const Positions: React.FC<PositionsProps> = ({ positions, telemetry, isLoading }) => {
  return (
    <div className="positions-page-root">
      <div className="page-header-block">
        <h2 className="page-title">Portfolio Positions & Cost Basis</h2>
        <p className="page-subtitle">
          Token inventory tracked proportionally with target trader wallets. Real-time DEX valuation and floating PnL.
        </p>
      </div>

      <PositionsSummary positions={positions} telemetry={telemetry} />

      <div style={{ marginTop: 24 }}>
        <PositionsTable positions={positions} isLoading={isLoading} />
      </div>
    </div>
  );
};
