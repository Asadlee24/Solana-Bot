import React from 'react';
import { LatencySample } from '../../types/dashboard';
import { EmptyState } from '../common/EmptyState';

interface LatencyDistributionChartProps {
  samples: LatencySample[];
}

export const LatencyDistributionChart: React.FC<LatencyDistributionChartProps> = ({ samples }) => {
  if (samples.length === 0) {
    return (
      <div className="terminal-chart-box">
        <div className="chart-header">
          <span className="chart-title">LATENCY HISTOGRAM DISTRIBUTION</span>
        </div>
        <EmptyState
          title="No Distribution Data"
          description="Bucket distribution will appear as trades settle."
        />
      </div>
    );
  }

  const buckets = [
    { label: '< 25ms', min: 0, max: 25, count: 0, tone: '#14f195' },
    { label: '25–50ms', min: 25, max: 50, count: 0, tone: '#10b981' },
    { label: '50–100ms', min: 50, max: 100, count: 0, tone: '#29d4ff' },
    { label: '100–250ms', min: 100, max: 250, count: 0, tone: '#f59e0b' },
    { label: '250–500ms', min: 250, max: 500, count: 0, tone: '#f97316' },
    { label: '500ms+', min: 500, max: Infinity, count: 0, tone: '#ef4444' },
  ];

  samples.forEach((s) => {
    const totalMs = (s.l_decision_ms || 0) + (s.l_quote_ms || 0) + (s.l_submit_ms || 0);
    const b = buckets.find((b) => totalMs >= b.min && totalMs < b.max);
    if (b) b.count++;
  });

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div className="terminal-chart-box">
      <div className="chart-header">
        <div>
          <span className="chart-title">LATENCY DISTRIBUTION BUCKETS</span>
          <span className="chart-subtitle">Sample frequency across reaction windows</span>
        </div>
        <span className="chart-badge">{samples.length} Total Samples</span>
      </div>

      <div className="histogram-bars-container">
        {buckets.map((bucket) => {
          const heightPct = (bucket.count / maxCount) * 100;
          const sharePct = samples.length > 0 ? ((bucket.count / samples.length) * 100).toFixed(0) : 0;

          return (
            <div key={bucket.label} className="histogram-col">
              <div className="histogram-bar-track">
                <div
                  className="histogram-bar-fill"
                  style={{
                    height: `${Math.max(heightPct, 4)}%`,
                    backgroundColor: bucket.tone,
                  }}
                  title={`${bucket.label}: ${bucket.count} samples (${sharePct}%)`}
                >
                  {bucket.count > 0 && (
                    <span className="histogram-count-label mono">{bucket.count}</span>
                  )}
                </div>
              </div>

              <div className="histogram-x-label mono">{bucket.label}</div>
              <div className="histogram-pct-label">{sharePct}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
