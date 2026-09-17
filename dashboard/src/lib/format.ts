/**
 * Strict Data-Integrity Formatter Utilities
 * Follows rule: NEVER fabricate missing values. Returns '—' when data is not available.
 */

export function formatSol(amount: number | undefined | null, digits = 4): string {
  if (amount === undefined || amount === null || isNaN(amount)) return '—';
  return `${amount.toFixed(digits)} SOL`;
}

export function formatUsd(amount: number | undefined | null, digits = 2): string {
  if (amount === undefined || amount === null || isNaN(amount)) return '—';
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatMicroUsd(amount: number | undefined | null): string {
  if (amount === undefined || amount === null || isNaN(amount) || amount === 0) return '—';
  if (amount < 0.00001) {
    return `$${amount.toFixed(8)}`;
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(6)}`;
  }
  return formatUsd(amount, 4);
}

export function formatPct(pct: number | undefined | null, withSign = true): string {
  if (pct === undefined || pct === null || isNaN(pct)) return '—';
  const prefix = withSign && pct > 0 ? '+' : '';
  return `${prefix}${pct.toFixed(2)}%`;
}

export function formatBps(bps: number | undefined | null): string {
  if (bps === undefined || bps === null || isNaN(bps)) return '—';
  const prefix = bps > 0 ? '+' : '';
  return `${prefix}${bps.toLocaleString()} bps`;
}

export function formatLatency(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || isNaN(ms) || ms <= 0) return '—';
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)} µs`;
  }
  return `${ms.toFixed(2)} ms`;
}

export function formatShortAddress(address: string | undefined | null, head = 4, tail = 4): string {
  if (!address) return '—';
  if (address.length <= head + tail + 2) return address;
  return `${address.substring(0, head)}...${address.substring(address.length - tail)}`;
}

export function formatTimeAgo(timestamp: number | undefined | null): string {
  if (!timestamp || timestamp <= 0) return '—';
  // Handle microsecond/nanosecond unix timestamps if passed
  const ms = timestamp > 1e14 ? Math.floor(timestamp / 1e6) : timestamp > 1e11 ? timestamp : timestamp * 1000;
  const diffSec = Math.floor((Date.now() - ms) / 1000);

  if (diffSec < 2) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function formatClockTime(timestamp: number | undefined | null): string {
  if (!timestamp || timestamp <= 0) return '—';
  const ms = timestamp > 1e14 ? Math.floor(timestamp / 1e6) : timestamp > 1e11 ? timestamp : timestamp * 1000;
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatUptime(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTokenQty(qtyRaw: string | number | undefined | null, decimals = 6): string {
  if (!qtyRaw) return '—';
  const num = typeof qtyRaw === 'string' ? Number(qtyRaw) : qtyRaw;
  if (isNaN(num)) return '—';
  const val = num / Math.pow(10, decimals);
  return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
