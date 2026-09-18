export type SignalStage =
  | 'SEEN_PRECONF'
  | 'SEEN_PREPROCESSED'
  | 'PROCESSED_SUCCESS'
  | 'PROCESSED_FAILED'
  | 'CONFIRMED'
  | 'FINALIZED';

export type SignalSource =
  | 'HELIUS_PRECONFIRMATION'
  | 'HELIUS_PREPROCESSED'
  | 'LASERSTREAM_GRPC'
  | 'LASERSTREAM_WS'
  | 'WEBHOOK'
  | 'REPLAY_SIMULATOR'
  | 'RPC_FALLBACK';

export type DexVenue =
  | 'PUMPFUN'
  | 'PUMPSWAP'
  | 'RAYDIUM_AMM'
  | 'RAYDIUM_CLMM'
  | 'RAYDIUM_CPMM'
  | 'JUPITER'
  | 'ORCA_WHIRLPOOL'
  | 'UNKNOWN';

export type TradeSide = 'BUY' | 'SELL';

export type SizingMode =
  | 'FIXED_SIZE'
  | 'TARGET_NOTIONAL_SCALAR'
  | 'CAPPED_PROPORTIONAL_HYBRID';

export type ExecutionMode = 'PAPER' | 'LIVE';

export type PositionState =
  | 'OPEN'
  | 'CLOSED'
  | 'CLOSED_BY_RISK'
  | 'DIVERGED';

export type RiskDecision =
  | 'APPROVED'
  | 'REJECTED_STALE'
  | 'REJECTED_MAX_NOTIONAL'
  | 'REJECTED_TOTAL_EXPOSURE'
  | 'REJECTED_SOL_RESERVE'
  | 'REJECTED_ENTRY_GAP'
  | 'REJECTED_PRICE_IMPACT'
  | 'REJECTED_DAILY_LOSS_LIMIT'
  | 'REJECTED_CONSECUTIVE_ERRORS'
  | 'REJECTED_CIRCUIT_BREAKER'
  | 'REJECTED_TOKEN_SAFETY'
  | 'REJECTED_UNKNOWN_LAYOUT'
  | 'REJECTED_DUPLICATE_POSITION'
  | 'REJECTED_COOLDOWN'
  | 'REJECTED_IN_FLIGHT';

/**
 * Normalized representation of a swap intent extracted on the fast path
 */
export interface SwapIntent {
  targetSignature: string;
  slot: number;
  targetWallet: string;
  venue: DexVenue;
  side: TradeSide;
  inputMint: string;
  outputMint: string;
  tokenMint: string; // The specific asset being bought or sold
  inputAmountRaw: string; // u64 raw string
  outputAmountRaw: string; // u64 raw string
  estimatedPrice: number; // SOL per Token
  targetPreBalanceToken?: string; // Pre-sell target balance if known/queried
  observedAt: bigint; // Monotonic nanoseconds (process.hrtime.bigint())
  timestampMs: number;
  rawProgramId: string;
  confidence: number; // 0.0 to 1.0
  isTransferNoise?: boolean;
  sellFraction?: number;
}

/**
 * Ground-truth reconciliation result from transaction metadata
 */
export interface ReconciledTrade {
  signature: string;
  slot: number;
  targetWallet: string;
  venue: DexVenue;
  side: TradeSide;
  tokenMint: string;
  netSolDeltaLamports: bigint; // Negative for buy (spent), positive for sell
  netTokenDeltaRaw: bigint; // Positive for buy (received), negative for sell
  effectiveTargetPrice: number; // Realized SOL per token
  targetPreTokenBalanceRaw: bigint;
  targetPostTokenBalanceRaw: bigint;
  targetSoldFraction?: number; // S_t / B_t for sells
  reconciledAt: bigint;
  status: 'SUCCESS' | 'FAILED' | 'DROPPED';
}

/**
 * Mirror trade intent prepared by the sizing & risk engines
 */
export interface MirrorIntent {
  id: string;
  targetSignature: string;
  targetWallet: string;
  side: TradeSide;
  tokenMint: string;
  inputMint: string;
  outputMint: string;
  requestedInAmountRaw: string;
  expectedOutAmountRaw: string;
  sellFraction?: number;
  riskDecision: RiskDecision;
  riskReason?: string;
  createdAt: bigint;
}

export type OrderStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PROCESSED'
  | 'CONFIRMED'
  | 'RECONCILED'
  | 'FILLED'
  | 'FAILED'
  | 'DROPPED'
  | 'EXPIRED';

/**
 * Actual execution order lifecycle (paper or live)
 */
export interface MirrorOrder {
  orderId: string;
  intentId: string;
  targetSignature: string;
  mode: ExecutionMode;
  side: TradeSide;
  tokenMint: string;
  // Quoted / Expected values
  inAmountRaw: string;
  outAmountRaw: string;
  minOutAmountRaw: string;
  effectivePrice: number;
  // Actual settled values (populated upon confirmed reconciliation)
  actualInAmountRaw?: string;
  actualOutAmountRaw?: string;
  actualExecutionPrice?: number;
  actualFeeLamports?: bigint;
  actualPriorityFeeLamports?: bigint;
  actualTipLamports?: bigint;
  landingProvider?: 'STANDARD_RPC' | 'HELIUS_SWQOS' | 'HELIUS_SENDER_MAX' | 'JUPITER_EXECUTE';
  reconciliationSource?: string;
  quotedAt: bigint;
  signedAt?: bigint;
  submittedAt?: bigint;
  landedAt?: bigint;
  orderSignature?: string;
  priorityFeeLamports: bigint;
  tipLamports: bigint;
  routeFeeLamports: bigint;
  status: OrderStatus;
  errorMessage?: string;
}

/**
 * Open or historical follower position
 */
export interface FollowerPosition {
  id: string;
  targetWallet: string;
  tokenMint: string;
  qtyRaw: string; // Current token balance BigInt string
  costBasisLamports: string; // Total SOL spent to acquire current position
  avgEntryPriceSol: number; // Cost basis in SOL per token
  realizedPnlLamports: string;
  unrealizedPnlLamports: string;
  state: PositionState;
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  tp1Triggered?: boolean;
  peakPnlPct?: number;
}

/**
 * Monotonic microsecond latency metrics and entry price gap
 */
export interface LatencyMetric {
  targetSignature: string;
  source: SignalSource;
  observedAt: bigint;
  decisionAt: bigint;
  quoteDoneAt: bigint;
  submittedAt: bigint;
  targetProcessedAt?: bigint;
  mirrorProcessedAt?: bigint;
  // Computed latencies in milliseconds
  lDetectMs: number; // t_observed - t_signal_origin (if origin known, else 0)
  lDecisionMs: number; // (t_decision - t_observed)
  lQuoteMs: number; // (t_quote_done - t_decision)
  lSubmitMs: number; // (t_submitted - t_quote_done)
  lLandingMs: number; // (t_mirror_processed - t_submitted)
  lEconomicMs?: number; // (t_mirror_processed - t_target_processed)
  // Entry Gap in Basis Points: 10,000 * (P_mirror / P_target - 1)
  entryGapBps?: number;
}

/**
 * Watched target wallet configuration
 */
export interface WatchedWallet {
  wallet: string;
  label: string;
  enabled: boolean;
  buyMode: SizingMode;
  fixedBuyLamports: string; // e.g. "100000000" for 0.1 SOL
  copyRatio: number; // for scalar/hybrid modes (e.g. 0.05 for 5%)
  maxBuyLamports: string;
  createdAt: number;
}

/**
 * Real-time Telemetry Snapshot for Dashboard
 */
export interface SystemTelemetry {
  uptimeSeconds: number;
  executionMode: ExecutionMode;
  watchedWalletsCount: number;
  openPositionsCount: number;
  totalTradesProcessed: number;
  initialPaperBalanceSol: number;
  currentPaperBalanceSol: number;
  solPriceUsd: number;
  totalPaperBalanceUsd: number;
  totalRealizedPnlSol: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlSol?: number;
  totalNetPnlSol?: number;
  totalNetPnlUsd?: number;
  roiPercent: number;
  circuitBreakerTripped: boolean;
  consecutiveErrors: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  avgEntryGapBps: number;
  lastSignalTimestamp: number;
  isLiveMode?: boolean;
  liveWalletPublicKey?: string;
  liveWalletBalanceSol?: number;
  liveWalletReserveSol?: number;
  liveWalletSpendableSol?: number;
  liveEngineArmed?: boolean;
}
