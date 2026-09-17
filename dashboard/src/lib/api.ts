import { LatencySample, Order, Position, RiskConfig, Telemetry, WatchedWallet } from '../types/dashboard';

export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem('solana_bot_api_url');
    if (saved && saved.trim()) {
      return saved.trim().replace(/\/+$/, '');
    }
  }
  const envUrl = (import.meta as any).env?.VITE_API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  return '';
}

export function setApiBase(url: string): void {
  if (typeof window !== 'undefined') {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (trimmed) {
      window.localStorage.setItem('solana_bot_api_url', trimmed);
    } else {
      window.localStorage.removeItem('solana_bot_api_url');
    }
  }
}

async function safeJsonFetch<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  const url = `${base}${endpoint}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}: ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON but received ${contentType || 'non-JSON response'} from ${endpoint}`);
  }
  return res.json();
}

export async function fetchTelemetry(): Promise<Telemetry> {
  return safeJsonFetch<Telemetry>('/api/telemetry');
}

export async function fetchOrders(limit = 50): Promise<Order[]> {
  return safeJsonFetch<Order[]>(`/api/orders?limit=${limit}`);
}

export async function fetchPositions(): Promise<Position[]> {
  return safeJsonFetch<Position[]>('/api/positions');
}

export async function fetchLatency(limit = 100): Promise<LatencySample[]> {
  return safeJsonFetch<LatencySample[]>(`/api/latency?limit=${limit}`);
}

export async function fetchWallets(): Promise<WatchedWallet[]> {
  return safeJsonFetch<WatchedWallet[]>('/api/wallets');
}

export async function addWallet(wallet: {
  wallet: string;
  label: string;
  enabled?: boolean;
  buyMode?: string;
  fixedBuyLamports?: string;
  copyRatio?: number;
  maxBuyLamports?: string;
}): Promise<{ success: boolean }> {
  return safeJsonFetch<{ success: boolean }>('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet: wallet.wallet,
      label: wallet.label || 'Target Wallet',
      enabled: wallet.enabled !== undefined ? (wallet.enabled ? 1 : 0) : 1,
      buy_mode: wallet.buyMode || 'FIXED_SIZE',
      fixed_buy_raw: wallet.fixedBuyLamports || '100000000',
      copy_ratio: wallet.copyRatio || 0.05,
      max_buy_raw: wallet.maxBuyLamports || '1000000000',
    }),
  });
}

export async function fetchRiskConfig(): Promise<RiskConfig> {
  return safeJsonFetch<RiskConfig>('/api/risk');
}

export async function resetCircuitBreaker(): Promise<{ success: boolean }> {
  return safeJsonFetch<{ success: boolean }>('/api/circuit-breaker/reset', {
    method: 'POST',
  });
}

export async function triggerSimulationSwap(targetWallet: string, tokenMint: string): Promise<boolean> {
  const base = getApiBase();
  const url = `${base}/webhook/helius`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        signature: `sim_${Date.now()}`,
        slot: 447800000 + Math.floor(Math.random() * 1000),
        feePayer: targetWallet,
        accountData: [{ account: targetWallet }, { account: tokenMint }],
        instructions: [
          {
            programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
            accounts: [
              'Global',
              'Fee',
              tokenMint,
              'BondingCurve',
              'Assoc',
              'UserToken',
              targetWallet,
            ],
            data: 'ZgY9EgHa6+oAANkBAAAAAAAA',
          },
        ],
      },
    ]),
  });
  return res.ok;
}

export async function sellPosition(
  positionId: string,
  fraction = 1.0
): Promise<{ success: boolean; order: any; position: any }> {
  return safeJsonFetch<{ success: boolean; order: any; position: any }>(`/api/positions/${positionId}/sell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fraction }),
  });
}

export async function closePosition(
  positionId: string
): Promise<{ success: boolean; order: any; position: any }> {
  return sellPosition(positionId, 1.0);
}
