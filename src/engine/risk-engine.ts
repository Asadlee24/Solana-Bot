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
  private inFlightBuys: Set<string> = new Set();
  private lastBuyTimestampByMint: Map<string, number> = new Map();
  private lifetimeBoughtMints: Set<string> = new Set();
  private firstSeenTargetPriceByMint: Map<string, number> = new Map();

  constructor() {
    this.initDefaultBlacklist();
    this.initRecentCooldownsFromDb();
    this.initLifetimeBoughtMints();
    this.initFirstSeenTargetPrices();
  }

  private initLifetimeBoughtMints() {
    try {
      const pastMints = db.getAllEverBoughtTokens();
      for (const m of pastMints) {
        this.lifetimeBoughtMints.add(m);
      }
      const gapFailedMints = db.getEntryGapFailedTokens();
      for (const m of gapFailedMints) {
        this.lifetimeBoughtMints.add(m);
      }
    } catch {
      // db may not be initialized yet in isolated tests
    }
  }

  private initFirstSeenTargetPrices() {
    try {
      const prices = db.getAllFirstSeenTargetPrices();
      for (const [mint, price] of prices.entries()) {
        this.firstSeenTargetPriceByMint.set(mint, price);
      }
    } catch {
      // db may not be initialized yet in isolated tests
    }
  }

  private initRecentCooldownsFromDb() {
    try {
      const openOrRecent = db.getOpenPositions();
      const now = Date.now();
      const cooldownMs = config.TOKEN_BUY_COOLDOWN_SEC * 1000;
      for (const pos of openOrRecent) {
        if (now - pos.openedAt < cooldownMs) {
          this.lastBuyTimestampByMint.set(pos.tokenMint, pos.openedAt);
        }
      }
    } catch {
      // db may not be initialized yet in isolated tests
    }
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

    // 4. Target Pre-Existing Token Guard: Reject if target trader already held this token prior to this transaction
    if (intent.isTargetRebuy) {
      return {
        decision: 'REJECTED_TARGET_ALREADY_HELD',
        approved: false,
        reason: `Target trader already held pre-existing tokens in ${intent.tokenMint.slice(0, 8)}... (${intent.targetPreBalanceToken || '>0'} tokens). Only fresh initial entries are copied!`,
      };
    }

    // 5. Stale Signal Age Check: T_now - T_detected <= T_max
    const ageMs = Date.now() - intent.timestampMs;
    if (ageMs > config.MAX_SIGNAL_AGE_MS) {
      return {
        decision: 'REJECTED_STALE',
        approved: false,
        reason: `Signal age ${ageMs}ms exceeds max permitted ${config.MAX_SIGNAL_AGE_MS}ms`,
      };
    }

    // 5. Fast-Finger In-Flight Guard: Reject simultaneous duplicate buys arriving before first completes
    if (this.inFlightBuys.has(intent.tokenMint)) {
      return {
        decision: 'REJECTED_IN_FLIGHT',
        approved: false,
        reason: `Buy order for ${intent.tokenMint.slice(0, 8)}... is already in-flight (Fast-Finger Guard)`,
      };
    }

    // 6. Target Spam Single Entry Guard: Only 1 active trade per coin, reject averaging/spam
    if (config.SINGLE_ENTRY_PER_TOKEN_ENABLED && db.hasOpenPosition(intent.tokenMint)) {
      return {
        decision: 'REJECTED_DUPLICATE_POSITION',
        approved: false,
        reason: `Already holding open position in ${intent.tokenMint.slice(0, 8)}... (Single Entry Guard: 1 trade max)`,
      };
    }

    // 7. Cooldown Timer Guard: 1 trade per token per cooldown window (default 5 minutes)
    const lastBuy = this.lastBuyTimestampByMint.get(intent.tokenMint);
    const cooldownMs = config.TOKEN_BUY_COOLDOWN_SEC * 1000;
    if (lastBuy && (Date.now() - lastBuy) < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - (Date.now() - lastBuy)) / 1000);
      return {
        decision: 'REJECTED_COOLDOWN',
        approved: false,
        reason: `Token in cooldown (${remainingSec}s remaining of ${config.TOKEN_BUY_COOLDOWN_SEC}s cooldown)`,
      };
    }

    // 8. Lifetime Never-Rebuy Guard: Strictly 1 trade lifetime per coin, NEVER buy again once bought
    if (config.NEVER_REBUY_SAME_TOKEN && this.isTokenPermanentlyLocked(intent.tokenMint)) {
      return {
        decision: 'REJECTED_NEVER_REBUY',
        approved: false,
        reason: `Token ${intent.tokenMint.slice(0, 8)}... was already bought once before. Lifetime Never-Rebuy rule is ACTIVE (Strict 1 Entry Max).`,
      };
    }

    // 9. Anti-FOMO Entry Ceiling Guard: Compare target entry price against first-seen price
    if (intent.estimatedPrice > 0) {
      const firstSeenPrice = this.firstSeenTargetPriceByMint.get(intent.tokenMint);
      if (firstSeenPrice !== undefined && firstSeenPrice > 0) {
        const gapBps = ((intent.estimatedPrice - firstSeenPrice) / firstSeenPrice) * 10000;
        if (gapBps > config.MAX_ENTRY_GAP_BPS) {
          this.addLifetimeLockedToken(intent.tokenMint);
          return {
            decision: 'REJECTED_ENTRY_GAP',
            approved: false,
            reason: `Target entry price (${intent.estimatedPrice.toExponential(4)} SOL) is +${gapBps.toFixed(1)} bps higher than first seen entry (${firstSeenPrice.toExponential(4)} SOL), exceeding tolerance (${config.MAX_ENTRY_GAP_BPS} bps). Anti-FOMO Guard ACTIVE.`,
          };
        }
      } else {
        this.firstSeenTargetPriceByMint.set(intent.tokenMint, intent.estimatedPrice);
      }
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
  public evaluateQuote(targetPrice: number, quotePrice: number, tokenMint?: string): RiskCheckResult {
    if (targetPrice > 0 && quotePrice > 0) {
      let baselinePrice = targetPrice;
      if (tokenMint && this.firstSeenTargetPriceByMint.has(tokenMint)) {
        const firstSeen = this.firstSeenTargetPriceByMint.get(tokenMint)!;
        if (firstSeen > 0 && firstSeen < baselinePrice) {
          baselinePrice = firstSeen;
        }
      }

      // Entry gap bps: 10,000 * (P_quote - P_baseline) / P_baseline
      const entryGapBps = ((quotePrice - baselinePrice) / baselinePrice) * 10000;
      if (entryGapBps > config.MAX_ENTRY_GAP_BPS) {
        return {
          decision: 'REJECTED_ENTRY_GAP',
          approved: false,
          reason: `Entry price gap (+${entryGapBps.toFixed(1)} bps vs baseline ${baselinePrice.toExponential(4)} SOL) exceeds tolerance (${config.MAX_ENTRY_GAP_BPS} bps)`,
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

  // Fast-Finger & Cooldown Guard Management Methods
  public markInFlight(tokenMint: string): void {
    this.inFlightBuys.add(tokenMint);
  }

  public clearInFlightBuy(tokenMint: string): void {
    this.inFlightBuys.delete(tokenMint);
  }

  public isInFlight(tokenMint: string): boolean {
    return this.inFlightBuys.has(tokenMint);
  }

  public recordBuy(tokenMint: string): void {
    this.inFlightBuys.delete(tokenMint);
    this.lastBuyTimestampByMint.set(tokenMint, Date.now());
    this.lifetimeBoughtMints.add(tokenMint);
  }

  public addLifetimeLockedToken(tokenMint: string): void {
    this.lifetimeBoughtMints.add(tokenMint);
  }

  public isTokenPermanentlyLocked(tokenMint: string): boolean {
    if (this.lifetimeBoughtMints.has(tokenMint)) {
      return true;
    }
    if (db.hasEverBoughtToken(tokenMint) || db.hasEverFailedEntryGap(tokenMint)) {
      this.lifetimeBoughtMints.add(tokenMint);
      return true;
    }
    return false;
  }

  public getFirstSeenPrice(tokenMint: string): number | undefined {
    return this.firstSeenTargetPriceByMint.get(tokenMint);
  }

  public setFirstSeenPrice(tokenMint: string, price: number): void {
    this.firstSeenTargetPriceByMint.set(tokenMint, price);
  }

  public clearFirstSeenPrice(tokenMint?: string): void {
    if (tokenMint) {
      this.firstSeenTargetPriceByMint.delete(tokenMint);
    } else {
      this.firstSeenTargetPriceByMint.clear();
    }
  }

  public getLifetimeLockedTokens(): string[] {
    return Array.from(this.lifetimeBoughtMints);
  }

  public clearLifetimeLock(tokenMint?: string): void {
    if (tokenMint) {
      this.lifetimeBoughtMints.delete(tokenMint);
    } else {
      this.lifetimeBoughtMints.clear();
    }
  }

  public getTokenCooldownRemainingSec(tokenMint: string): number {
    const lastBuy = this.lastBuyTimestampByMint.get(tokenMint);
    if (!lastBuy) return 0;
    const cooldownMs = config.TOKEN_BUY_COOLDOWN_SEC * 1000;
    const elapsed = Date.now() - lastBuy;
    if (elapsed >= cooldownMs) return 0;
    return Math.ceil((cooldownMs - elapsed) / 1000);
  }

  public getAllActiveCooldowns(): Array<{ tokenMint: string; remainingSec: number }> {
    const result: Array<{ tokenMint: string; remainingSec: number }> = [];
    const now = Date.now();
    const cooldownMs = config.TOKEN_BUY_COOLDOWN_SEC * 1000;
    for (const [mint, lastBuy] of this.lastBuyTimestampByMint.entries()) {
      const elapsed = now - lastBuy;
      if (elapsed < cooldownMs) {
        result.push({
          tokenMint: mint,
          remainingSec: Math.ceil((cooldownMs - elapsed) / 1000),
        });
      }
    }
    return result;
  }

  public clearCooldown(tokenMint?: string): void {
    if (tokenMint) {
      this.lastBuyTimestampByMint.delete(tokenMint);
      this.inFlightBuys.delete(tokenMint);
      this.lifetimeBoughtMints.delete(tokenMint);
    } else {
      this.lastBuyTimestampByMint.clear();
      this.inFlightBuys.clear();
      this.lifetimeBoughtMints.clear();
    }
  }
}

export const riskEngine = new RiskEngine();
