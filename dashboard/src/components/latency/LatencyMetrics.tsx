import { Activity, Clock, Gauge, Target, Zap } from 'lucide-react';
import React from 'react';
import { formatBps, formatLatency } from '../../lib/format';
import { LatencySample, Telemetry } from '../../types/dashboard';
import { MetricCard } from '../common/MetricCard';

interface LatencyMetricsProps {
  telemetry: Telemetry | null;
  samples: LatencySample[];
}

export const LatencyMetrics: React.FC<LatencyMetricsProps> = ({ telemetry, samples }) => {
  const p50 = telemetry?.latencyP50Ms || 0;
  const p95 = telemetry?.latencyP95Ms || 0;
  const p99 = telemetry?.latencyP99Ms || 0;
  const avgGap = telemetry?.avgEntryGapBps || 0;

  const latestSample = samples[0];
  const latestMs = latestSample
    ? (latestSample.l_decision_ms || 0) +
      (latestSample.l_quote_ms || 0) +
      (latestSample.l_submit_ms || 0)
    : null;

  return (
    <div className="latency-kpi-grid">
      <MetricCard
        label="Median Reaction (p50)"
        value={p50 > 0 ? formatLatency(p50) : '—'}
        subValue={p50 > 0 ? 'Optimal fast-path threshold' : 'No samples recorded'}
        icon={<Zap size={16} />}
        tone={p50 > 0 && p50 < 25 ? 'positive' : 'default'}
      />

      <MetricCard
        label="Tail Latency (p95)"
        value={p95 > 0 ? formatLatency(p95) : '—'}
        subValue={p95 > 0 ? '95% of trades settled faster' : 'Awaiting samples'}
        icon={<Clock size={16} />}
        tone={p95 > 0 && p95 < 100 ? 'cyan' : 'warning'}
      />

      <MetricCard
        label="Worst-Case (p99)"
        value={p99 > 0 ? formatLatency(p99) : '—'}
        subValue={p99 > 0 ? 'Target maximum bound' : 'Awaiting samples'}
        icon={<Gauge size={16} />}
        tone="default"
      />

      <MetricCard
        label="Average Entry Gap"
        value={avgGap !== 0 ? formatBps(avgGap) : '—'}
        subValue={
          avgGap !== 0
            ? avgGap > 0
              ? 'Moderate slippage vs trader'
              : 'Favorable follower fill price'
            : 'Awaiting trades'
        }
        icon={<Target size={16} />}
        tone={avgGap <= 50 ? 'positive' : 'warning'}
      />

      <MetricCard
        label="Latest Reaction"
        value={latestMs !== null ? formatLatency(latestMs) : '—'}
        subValue={`${samples.length} Captured Benchmarks`}
        icon={<Activity size={16} />}
        tone="cyan"
      />
    </div>
  );
};
