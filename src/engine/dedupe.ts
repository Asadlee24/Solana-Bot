import { db } from '../db/database.js';
import { SignalSource, SignalStage } from '../types/index.js';

export interface SignatureState {
  signature: string;
  highestStage: SignalStage;
  firstSeenAt: number;
  actedOn: boolean;
}

const STAGE_ORDER: Record<SignalStage, number> = {
  SEEN_PRECONF: 1,
  SEEN_PREPROCESSED: 2,
  PROCESSED_SUCCESS: 3,
  PROCESSED_FAILED: 3,
  CONFIRMED: 4,
  FINALIZED: 5,
};

export class DeduplicationEngine {
  private cache: Map<string, SignatureState> = new Map();
  private maxCacheSize: number = 50000;

  /**
   * Process incoming signature event and determine if hot action should proceed
   */
  public registerEvent(
    signature: string,
    stage: SignalStage,
    source: SignalSource
  ): { isNew: boolean; shouldAct: boolean } {
    const isNewInDb = db.recordReceipt(signature, stage, source);
    const existing = this.cache.get(signature);

    if (!existing) {
      // First time seeing this signature
      this.evictIfNeeded();
      this.cache.set(signature, {
        signature,
        highestStage: stage,
        firstSeenAt: Date.now(),
        actedOn: false,
      });

      // We should act on hot trigger (Preconf, Preprocessed, or Processed if first seen)
      return { isNew: true, shouldAct: true };
    }

    // If already seen, check stage progression
    const currentRank = STAGE_ORDER[existing.highestStage] || 0;
    const newRank = STAGE_ORDER[stage] || 0;

    if (newRank > currentRank) {
      existing.highestStage = stage;
    }

    // Do NOT trigger another mirror trade if we already initiated an action for this signature
    const shouldAct = !existing.actedOn && (stage === 'SEEN_PRECONF' || stage === 'SEEN_PREPROCESSED' || stage === 'PROCESSED_SUCCESS');

    return { isNew: isNewInDb, shouldAct };
  }

  public markActed(signature: string): void {
    const entry = this.cache.get(signature);
    if (entry) {
      entry.actedOn = true;
    }
  }

  public hasActed(signature: string): boolean {
    return this.cache.get(signature)?.actedOn || false;
  }

  private evictIfNeeded() {
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest 5000 entries
      const iter = this.cache.keys();
      for (let i = 0; i < 5000; i++) {
        const next = iter.next();
        if (next.done) break;
        this.cache.delete(next.value);
      }
    }
  }
}

export const dedupeEngine = new DeduplicationEngine();
