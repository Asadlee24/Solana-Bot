import React from 'react';
import { EntryGapChart } from '../components/latency/EntryGapChart';
import { LatencyDistributionChart } from '../components/latency/LatencyDistributionChart';
import { LatencyMetrics } from '../components/latency/LatencyMetrics';
import { ReactionScatterChart } from '../components/latency/ReactionScatterChart';
import { LatencySample, Telemetry } from '../types/dashboard';

interface LatencyProps {
  telemetry: Telemetry | null;
  samples: LatencySample[];
}

export const Latency: React.FC<LatencyProps> = ({ telemetry, samples }) => {
  return (
    <div className="latency-page-root">
      <div className="page-header-block">
        <h2 className="page-title">Latency Telemetry & Execution Analytics</h2>
        <p className="page-subtitle">
          Microsecond pipeline telemetry benchmarks measured across pre-confirmation ingest, CPI parsing, risk evaluation, and preflight dispatch.
        </p>
      </div>

      <LatencyMetrics telemetry={telemetry} samples={samples} />

      <div className="latency-charts-grid">
        <ReactionScatterChart samples={samples} />
        <LatencyDistributionChart samples={samples} />
      </div>

      <div style={{ marginTop: 24 }}>
        <EntryGapChart samples={samples} />
      </div>
    </div>
  );
};
