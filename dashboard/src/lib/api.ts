import { LatencySample, Order, Position, RiskConfig, Telemetry, WatchedWallet } from '../types/dashboard';

const API_BASE = '';

export async function fetchTelemetry(): Promise<Telemetry> {
  const res = await fetch(`${API_BASE}/api/telemetry`);
  if (!res.ok) throw new Error(`Telemetry HTTP ${res.status}`);
  return res.json();
}

export async function fetchOrders(limit = 50): Promise<Order[]> {
  const res = await fetch(`${API_BASE}/api/orders?limit=${limit}`);
  if (!res.ok) throw new Error(`Orders HTTP ${res.status}`);
  return res.json();
}

export async function fetchPositions(): Promise<Position[]> {
  const res = await fetch(`${API_BASE}/api/positions`);
  if (!res.ok) throw new Error(`Positions HTTP ${res.status}`);
  return res.json();
}

export async function fetchLatency(limit = 100): Promise<LatencySample[]> {
  const res = await fetch(`${API_BASE}/api/latency?limit=${limit}`);
  if (!res.ok) throw new Error(`Latency HTTP ${res.status}`);
  return res.json();
}

export async function fetchWallets(): Promise<WatchedWallet[]> {
  const res = await fetch(`${API_BASE}/api/wallets`);
  if (!res.ok) throw new Error(`Wallets HTTP ${res.status}`);
  return res.json();
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
  const res = await fetch(`${API_BASE}/api/wallets`, {
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
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Add wallet HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchRiskConfig(): Promise<RiskConfig> {
  const res = await fetch(`${API_BASE}/api/risk`);
  if (!res.ok) throw new Error(`Risk HTTP ${res.status}`);
  return res.json();
}

export async function resetCircuitBreaker(): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/circuit-breaker/reset`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Reset HTTP ${res.status}`);
  return res.json();
}

export async function triggerSimulationSwap(targetWallet: string, tokenMint: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/webhook/helius`, {
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
