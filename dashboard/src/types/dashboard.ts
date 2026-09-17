export type StreamStatus = 'CONNECTED' | 'RECONNECTING' | 'OFFLINE';

export type NavigationTab =
  | 'overview'
  | 'trades'
  | 'positions'
  | 'latency'
  | 'wallets'
  | 'risk'
  | 'system';

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  priceSol?: number;
  fdvUsd: number;
  liquidityUsd: number;
  dexScreenerUrl: string;
  pumpFunUrl: string;
  solscanUrl: string;
  imageUrl?: string;
  updatedAt?: number;
}

export interface Telemetry {
  uptimeSeconds: number;
  executionMode: 'PAPER' | 'LIVE';
  watchedWalletsCount: number;
  openPositionsCount: number;
  totalTradesProcessed: number;
  initialPaperBalanceSol?: number;
  currentPaperBalanceSol?: number;
  solPriceUsd?: number;
  totalPaperBalanceUsd?: number;
  totalRealizedPnlSol: number;
  totalRealizedPnlUsd?: number;
  totalUnrealizedPnlSol?: number;
  totalNetPnlSol?: number;
  totalNetPnlUsd?: number;
  roiPercent?: number;
  circuitBreakerTripped: boolean;
  consecutiveErrors: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  avgEntryGapBps: number;
  lastSignalTimestamp: number;
}

export interface OrderComparison {
  traderPriceSol: number;
  traderPriceUsd: number;
  followerPriceSol: number;
  followerPriceUsd: number;
  traderMarketCapUsd: number;
  followerMarketCapUsd: number;
  traderSpentSol: number;
  traderSpentUsd: number;
  followerSpentSol: number;
  followerSpentUsd: number;
  entryGapPct: number;
  entryGapBps: number;
  reactionLatencyMs: number | null;
  targetWallet: string;
  isTargetPriceEstimated?: boolean;
  isTargetSpentEstimated?: boolean;
  isLatencyEstimated?: boolean;
}

export interface Order {
  order_id: string;
  intent_id?: string;
  target_signature: string;
  mode: 'PAPER' | 'LIVE';
  side: 'BUY' | 'SELL';
  token_mint: string;
  in_amount_raw: string;
  out_amount_raw: string;
  min_out_raw?: string;
  effective_price: number;
  quote_at: number;
  signed_at?: number;
  submitted_at?: number;
  landed_at?: number;
  fee_raw: string;
  tip_raw: string;
  status: 'PENDING' | 'FILLED' | 'FAILED' | 'EXPIRED';
  error_message?: string | null;
  signature?: string;
  risk_decision?: string;
  risk_reason?: string;
  target_price?: number;
  metadata?: TokenMeta;
  comparison?: OrderComparison;
}

export interface Position {
  id: string;
  targetWallet: string;
  tokenMint: string;
  qtyRaw: string;
  costBasisLamports: string;
  avgEntryPriceSol: number;
  realizedPnlLamports: string;
  unrealizedPnlLamports?: string;
  currentPriceSol?: number;
  currentPriceUsd?: number;
  currentValueSol?: number;
  currentValueUsd?: number;
  unrealizedPnlSol?: number;
  unrealizedPnlPct?: number;
  state: 'OPEN' | 'CLOSED';
  openedAt: number;
  updatedAt: number;
  closedAt?: number | null;
  metadata?: TokenMeta;
}

export interface LatencySample {
  id?: number;
  target_signature: string;
  source: string;
  observed_at: number;
  decision_at: number;
  quoted_at: number;
  sent_at: number;
  target_processed_at?: number;
  mirror_processed_at?: number;
  l_detect_ms: number;
  l_decision_ms: number;
  l_quote_ms: number;
  l_submit_ms: number;
  l_landing_ms: number;
  l_economic_ms?: number;
  entry_gap_bps: number | null;
}

export interface WatchedWallet {
  wallet: string;
  label: string;
  enabled: boolean;
  buyMode: 'FIXED_SIZE' | 'TARGET_NOTIONAL_SCALAR' | 'CAPPED_PROPORTIONAL_HYBRID';
  fixedBuyLamports: string;
  copyRatio: number;
  maxBuyLamports: string;
  createdAt: number;
}

export interface RiskConfig {
  circuitBreakerTripped: boolean;
  consecutiveErrors: number;
  consecutiveErrorLimit: number;
  dailyLossSol: number;
  dailyLossLimitSol: number;
  maxTotalExposureSol: number;
  minSolReserveSol: number;
  maxSignalAgeMs: number;
  maxEntryGapBps: number;
  maxSlippageBps: number;
  mintBlacklist: string[];
  defaultSizingMode: string;
  fixedBuySol: number;
  copyRatio: number;
  maxBuySol: number;
}

export interface LiveConsoleEvent {
  id: string;
  timestamp: number;
  type: 'TARGET_EVENT' | 'MIRROR_ORDER' | 'POSITION_UPDATE' | 'LATENCY_SAMPLE' | 'PING' | 'SYS_MSG';
  summary: string;
  payload: any;
}
