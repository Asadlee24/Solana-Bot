import React from 'react';
import { RiskPanel } from '../components/risk/RiskPanel';
import { RiskConfig, Telemetry } from '../types/dashboard';

interface RiskProps {
  riskConfig: RiskConfig | null;
  telemetry: Telemetry | null;
  onRefresh: () => void;
}

export const Risk: React.FC<RiskProps> = ({ riskConfig, telemetry, onRefresh }) => {
  return (
    <div className="risk-page-root">
      <div className="page-header-block">
        <h2 className="page-title">Pre-Trade Risk Engine & Breakers</h2>
        <p className="page-subtitle">
          Configured safety bounds protecting your portfolio against honeypots, slippage deterioration, stale signals, and maximum daily drawdowns.
        </p>
      </div>

      <RiskPanel
        riskConfig={riskConfig}
        telemetry={telemetry}
        onRefresh={onRefresh}
      />
    </div>
  );
};
