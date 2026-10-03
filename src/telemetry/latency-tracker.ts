import { db } from '../db/database.js';
import { FastPathTimestamps, LatencyMetric, SignalSource } from '../types/index.js';

export interface FastPathTelemetryRecord {
  targetSignature: string;
  followerSignature?: string;
  mint: string;
  timestamps: FastPathTimestamps;
  stagesMs: {
    signal_to_decode?: number;
    signal_to_build?: number;
    signal_to_broadcast?: number;
    broadcast_to_landed?: number;
    signal_to_landed?: number;
    landed_to_confirmed?: number;
    persistence_cost_ms?: number;
  };
}

export class LatencyTracker {
  private fastPathSamples: FastPathTelemetryRecord[] = [];
  private readonly maxSamples = 1000;

  /**
   * Existing normal path latency recording (preserves backward compatibility)
   */
  public recordSample(params: {
    targetSignature: string;
    source: SignalSource;
    observedAt: bigint;
    decisionAt: bigint;
    quoteDoneAt: bigint;
    submittedAt: bigint;
    targetProcessedAt?: bigint;
    mirrorProcessedAt?: bigint;
    targetPrice?: number;
    mirrorPrice?: number;
  }): LatencyMetric {
    const lDecisionMs = Number(params.decisionAt - params.observedAt) / 1_000_000;
    const lQuoteMs = Number(params.quoteDoneAt - params.decisionAt) / 1_000_000;
    const lSubmitMs = Number(params.submittedAt - params.quoteDoneAt) / 1_000_000;

    let lLandingMs = 0;
    if (params.mirrorProcessedAt) {
      lLandingMs = Number(params.mirrorProcessedAt - params.submittedAt) / 1_000_000;
    }

    let lEconomicMs: number | undefined = undefined;
    if (params.mirrorProcessedAt && params.targetProcessedAt) {
      lEconomicMs = Number(params.mirrorProcessedAt - params.targetProcessedAt) / 1_000_000;
    }

    let entryGapBps: number | undefined = undefined;
    if (params.targetPrice && params.mirrorPrice && params.targetPrice > 0) {
      entryGapBps = Number((((params.mirrorPrice - params.targetPrice) / params.targetPrice) * 10000).toFixed(1));
    }

    const metric: LatencyMetric = {
      targetSignature: params.targetSignature,
      source: params.source,
      observedAt: params.observedAt,
      decisionAt: params.decisionAt,
      quoteDoneAt: params.quoteDoneAt,
      submittedAt: params.submittedAt,
      targetProcessedAt: params.targetProcessedAt,
      mirrorProcessedAt: params.mirrorProcessedAt,
      lDetectMs: 0,
      lDecisionMs: Number(lDecisionMs.toFixed(3)),
      lQuoteMs: Number(lQuoteMs.toFixed(3)),
      lSubmitMs: Number(lSubmitMs.toFixed(3)),
      lLandingMs: Number(lLandingMs.toFixed(3)),
      lEconomicMs: lEconomicMs !== undefined ? Number(lEconomicMs.toFixed(3)) : undefined,
      entryGapBps,
    };

    setImmediate(() => {
      try {
        db.recordLatencySample(metric);
      } catch {}
    });
    return metric;
  }

  /**
   * Fast-Path specific high-resolution monotonic telemetry
   */
  public recordFastPathTelemetry(record: {
    targetSignature: string;
    followerSignature?: string;
    mint: string;
    timestamps: FastPathTimestamps;
  }): FastPathTelemetryRecord {
    const ts = record.timestamps;

    const toMs = (start?: bigint, end?: bigint): number | undefined => {
      if (start === undefined || end === undefined) return undefined;
      return Number(end - start) / 1_000_000;
    };

    const stagesMs = {
      signal_to_decode: toMs(ts.signal_received, ts.decoded),
      signal_to_build: toMs(ts.signal_received, ts.tx_built),
      signal_to_broadcast: toMs(ts.signal_received, ts.broadcast_completed),
      broadcast_to_landed: toMs(ts.broadcast_completed, ts.landed),
      signal_to_landed: toMs(ts.signal_received, ts.landed),
      landed_to_confirmed: toMs(ts.landed, ts.confirmed),
      persistence_cost_ms: toMs(ts.tx_signed, ts.persistence_completed),
    };

    const sample: FastPathTelemetryRecord = {
      targetSignature: record.targetSignature,
      followerSignature: record.followerSignature,
      mint: record.mint,
      timestamps: ts,
      stagesMs,
    };

    this.fastPathSamples.push(sample);
    if (this.fastPathSamples.length > this.maxSamples) {
      this.fastPathSamples.shift();
    }

    return sample;
  }

  public getFastPathSamples(): FastPathTelemetryRecord[] {
    return [...this.fastPathSamples];
  }

  public getFastPathSummary(): {
    count: number;
    signal_to_broadcast: { p50: number; p90: number; p95: number; min: number; max: number };
    signal_to_decode: { p50: number; p90: number; p95: number; min: number; max: number };
    signal_to_build: { p50: number; p90: number; p95: number; min: number; max: number };
    persistence_cost: { p50: number; p90: number; p95: number; min: number; max: number };
  } {
    const calcStats = (vals: number[]) => {
      if (vals.length === 0) return { p50: 0, p90: 0, p95: 0, min: 0, max: 0 };
      const sorted = [...vals].sort((a, b) => a - b);
      const p = (pct: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
      return {
        p50: Number(p(0.5).toFixed(3)),
        p90: Number(p(0.9).toFixed(3)),
        p95: Number(p(0.95).toFixed(3)),
        min: Number(sorted[0].toFixed(3)),
        max: Number(sorted[sorted.length - 1].toFixed(3)),
      };
    };

    const sToB = this.fastPathSamples.map((s) => s.stagesMs.signal_to_broadcast).filter((v): v is number => v !== undefined);
    const sToD = this.fastPathSamples.map((s) => s.stagesMs.signal_to_decode).filter((v): v is number => v !== undefined);
    const sToBuild = this.fastPathSamples.map((s) => s.stagesMs.signal_to_build).filter((v): v is number => v !== undefined);
    const persist = this.fastPathSamples.map((s) => s.stagesMs.persistence_cost_ms).filter((v): v is number => v !== undefined);

    return {
      count: this.fastPathSamples.length,
      signal_to_broadcast: calcStats(sToB),
      signal_to_decode: calcStats(sToD),
      signal_to_build: calcStats(sToBuild),
      persistence_cost: calcStats(persist),
    };
  }
}

export const latencyTracker = new LatencyTracker();
