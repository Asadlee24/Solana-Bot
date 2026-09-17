import { db } from '../db/database.js';
import { LatencyMetric, SignalSource } from '../types/index.js';

export class LatencyTracker {
  /**
   * Calculate exact latency stages and entry price gap, then persist
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

    // Entry price gap in Basis Points: 10,000 * (P_mirror / P_target - 1)
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
      lDetectMs: 0, // 0 if signal origin header not published by provider
      lDecisionMs: Number(lDecisionMs.toFixed(3)),
      lQuoteMs: Number(lQuoteMs.toFixed(3)),
      lSubmitMs: Number(lSubmitMs.toFixed(3)),
      lLandingMs: Number(lLandingMs.toFixed(3)),
      lEconomicMs: lEconomicMs !== undefined ? Number(lEconomicMs.toFixed(3)) : undefined,
      entryGapBps,
    };

    db.recordLatencySample(metric);
    return metric;
  }
}

export const latencyTracker = new LatencyTracker();
