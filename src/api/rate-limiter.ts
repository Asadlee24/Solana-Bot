import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message?: string;
  statusCode?: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

export class SlidingWindowRateLimiter {
  private hits: Map<string, number[]> = new Map();
  private options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = {
      statusCode: 429,
      message: 'Too many requests. Please try again later.',
      keyGenerator: (req: Request) => {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') {
          return forwarded.split(',')[0].trim();
        }
        return req.ip || req.socket.remoteAddress || 'unknown';
      },
      ...options,
    };
  }

  public middleware = (req: Request, res: Response, next: NextFunction): void => {
    // Skip if configured or during test unless testing rate limits
    if (this.options.skip && this.options.skip(req)) {
      return next();
    }

    const key = this.options.keyGenerator!(req);
    const now = Date.now();
    const windowStart = now - this.options.windowMs;

    const timestamps = (this.hits.get(key) || []).filter((t) => t > windowStart);

    if (timestamps.length >= this.options.max) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      res.status(this.options.statusCode || 429).json({
        error: this.options.message,
        retryAfter: retryAfterSec,
      });
      return;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    next();
  };

  public recordHit(key: string): void {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const timestamps = (this.hits.get(key) || []).filter((t) => t > windowStart);
    timestamps.push(now);
    this.hits.set(key, timestamps);
  }

  public isRateLimited(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const timestamps = (this.hits.get(key) || []).filter((t) => t > windowStart);
    return timestamps.length >= this.options.max;
  }

  public reset(key?: string): void {
    if (key) {
      this.hits.delete(key);
    } else {
      this.hits.clear();
    }
  }
}

// 1. Auth failure rate limiter: 10 failed auth attempts per 60 seconds per IP
export const authFailureLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many failed authentication attempts. Please wait a minute before retrying.',
});

// 2. Mutating Control limiter: 30 requests per minute for arm, kill, circuit-breaker reset
export const mutatingControlLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Rate limit exceeded for control actions. Please slow down.',
});

// 3. Trading Exit limiter: 60 requests per minute for manual sell and close
export const tradingExitLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: 'Rate limit exceeded for manual position exits.',
});

// 4. Watched-Wallet mutation limiter: 30 requests per minute
export const walletMutationLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Rate limit exceeded for watched-wallet configuration.',
});

// 5. Helius Webhook receiver limiter: 300 requests per 10 seconds (allows 30 req/sec bursts)
export const webhookRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 10_000,
  max: 300,
  message: 'Webhook burst rate limit exceeded.',
});

export function resetAllRateLimits(): void {
  authFailureLimiter.reset();
  mutatingControlLimiter.reset();
  tradingExitLimiter.reset();
  walletMutationLimiter.reset();
  webhookRateLimiter.reset();
}
