import { config, LAMPORTS_PER_SOL_BIGINT, solToLamportsBigInt } from '../config/index.js';
import { db } from '../db/database.js';
import { RiskDecision, SwapIntent } from '../types/index.js';

export interface RiskCheckResult {
  decision: RiskDecision;
  approved: boolean;
  reason?: string;
}

export class RiskEngine {
  private consecutiveErrors: number = 0;
  private dailyLossLamports: bigint = 0n;
  private circuitBreakerTripped: boolean = false;
  private mintBlacklist: Set<string> = new Set();

  constructor() {
    this.initDefaultBlacklist();
  }

  private initDefaultBlacklist() {
    // Known honeypot or malicious tokens can be added here
    this.mintBlacklist.add('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // Bonk (example excluded if wanted, or honeypot)
  }

  /**
   * Validate swap intent against all pre-trade risk controls
   */
  public evaluateIntent(
    intent: SwapIntent,
    currentFollowerSolBalanceLamports: bigint,
    totalOpenExposureLamports: bigint
  ): RiskCheckResult {
    // 1. Check Circuit Breaker
    if (this.circuitBreakerTripped) {
      return {
        decision: 'REJECTED_CIRCUIT_BREAKER',
        approved: false,
        reason: 'Circuit breaker is TRIPPED due to consecutive errors or daily loss limit',
      };
    }

    // 2. Reject noise/transfers or unknown layout
    if (intent.isTransferNoise) {
      return {
        decision: 'REJECTED_UNKNOWN_LAYOUT',
        approved: false,
        reason: 'Filtered as plain wallet transfer or noise',
      };
    }

    if (intent.confidence < 0.5) {
      return {
        decision: 'REJECTED_UNKNOWN_LAYOUT',
        approved: false,
        reason: `Low parser confidence (${intent.confidence})`,
      };
    }

    // 3. Token Blacklist Check
    if (this.mintBlacklist.has(intent.tokenMint)) {
      return {
        decision: 'REJECTED_TOKEN_SAFETY',
        approved: false,
        reason: `Token mint ${intent.tokenMint} is blacklisted`,
      };
    }

    // For SELL orders: sells to exit/reduce positions are always allowed to de-risk!
    if (intent.side === 'SELL') {
      return {
        decision: 'APPROVED',
        approved: true,
      };
    }

    // 4. Stale Signal Age Check: T_now - T_detected <= T_max
    const ageMs = Date.now() - intent.timestampMs;
    if (ageMs > config.MAX_SIGNAL_AGE_MS) {
      return {
        decision: 'REJECTED_STALE',
        approved: false,
        reason: `Signal age ${ageMs}ms exceeds max permitted ${config.MAX_SIGNAL_AGE_MS}ms`,
      };
    }

    // 5. SOL Fee/Tip Reserve Floor Check
    const minReserveLamports = solToLamportsBigInt(config.MIN_SOL_RESERVE_SOL);
    const fixedBuyLamports = solToLamportsBigInt(config.FIXED_BUY_SOL);

    if (currentFollowerSolBalanceLamports - fixedBuyLamports < minReserveLamports) {
      return {
        decision: 'REJECTED_SOL_RESERVE',
        approved: false,
        reason: `Executing buy would breach minimum SOL reserve floor (${config.MIN_SOL_RESERVE_SOL} SOL)`,
      };
    }

    // 6. Max Notional per Buy
    const maxBuyLamports = solToLamportsBigInt(config.MAX_BUY_SOL);
    if (fixedBuyLamports > maxBuyLamports) {
      return {
        decision: 'REJECTED_MAX_NOTIONAL',
        approved: false,
        reason: `Trade size exceeds max buy ceiling (${config.MAX_BUY_SOL} SOL)`,
      };
    }

    // 7. Max Total Portfolio Exposure
    const maxExposureLamports = solToLamportsBigInt(config.MAX_TOTAL_EXPOSURE_SOL);
    if (totalOpenExposureLamports + fixedBuyLamports > maxExposureLamports) {
      return {
        decision: 'REJECTED_TOTAL_EXPOSURE',
        approved: false,
        reason: `Total open exposure would exceed limit (${config.MAX_TOTAL_EXPOSURE_SOL} SOL)`,
      };
    }

    // 8. Daily Loss Circuit Breaker Check
    const dailyLossLimitLamports = solToLamportsBigInt(config.DAILY_LOSS_LIMIT_SOL);
    if (this.dailyLossLamports >= dailyLossLimitLamports) {
      this.tripCircuitBreaker('Daily loss limit reached');
      return {
        decision: 'REJECTED_DAILY_LOSS_LIMIT',
        approved: false,
        reason: `Daily loss limit breached (${config.DAILY_LOSS_LIMIT_SOL} SOL)`,
      };
    }

    return {
      decision: 'APPROVED',
      approved: true,
    };
  }

  /**
   * Post-quote check: Verify entry gap and slippage before final submission
   */
  public evaluateQuote(targetPrice: number, quotePrice: number): RiskCheckResult {
    if (targetPrice > 0 && quotePrice > 0) {
      // Entry gap bps: 10,000 * (P_quote - P_target) / P_target
      const entryGapBps = ((quotePrice - targetPrice) / targetPrice) * 10000;
      if (entryGapBps > config.MAX_ENTRY_GAP_BPS) {
        return {
          decision: 'REJECTED_ENTRY_GAP',
          approved: false,
          reason: `Entry price gap (+${entryGapBps.toFixed(1)} bps) exceeds tolerance (${config.MAX_ENTRY_GAP_BPS} bps)`,
        };
      }
    }

    return {
      decision: 'APPROVED',
      approved: true,
    };
  }

  public recordSuccess() {
    this.consecutiveErrors = 0;
  }

  public recordError(errorMsg: string) {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= config.CONSECUTIVE_ERROR_LIMIT) {
      this.tripCircuitBreaker(`Exceeded ${config.CONSECUTIVE_ERROR_LIMIT} consecutive errors: ${errorMsg}`);
    }
  }

  public recordRealizedLoss(lossLamports: bigint) {
    if (lossLamports > 0n) {
      this.dailyLossLamports += lossLamports;
      const limit = solToLamportsBigInt(config.DAILY_LOSS_LIMIT_SOL);
      if (this.dailyLossLamports >= limit) {
        this.tripCircuitBreaker('Daily loss limit exceeded');
      }
    }
  }

  public tripCircuitBreaker(reason: string) {
    this.circuitBreakerTripped = true;
    console.warn(`[RISK CIRCUIT BREAKER TRIPPED]: ${reason}`);
  }

  public resetCircuitBreaker() {
    this.circuitBreakerTripped = false;
    this.consecutiveErrors = 0;
    this.dailyLossLamports = 0n;
    console.info('[RISK] Circuit breaker reset to normal operation.');
  }

  public isTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  public getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  public getDailyLossLamports(): bigint {
    return this.dailyLossLamports;
  }

  public getMintBlacklist(): string[] {
    return Array.from(this.mintBlacklist);
  }
}

export const riskEngine = new RiskEngine();
