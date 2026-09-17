import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLatency,
  fetchOrders,
  fetchPositions,
  fetchRiskConfig,
  fetchTelemetry,
  fetchWallets,
} from '../lib/api';
import {
  LatencySample,
  Order,
  Position,
  RiskConfig,
  Telemetry,
  WatchedWallet,
} from '../types/dashboard';
import { useEventStream } from './useEventStream';

export function useDashboardData() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [wallets, setWallets] = useState<WatchedWallet[]>([]);
  const [riskConfig, setRiskConfig] = useState<RiskConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(Date.now());
  const debounceTimerRef = useRef<any>(null);

  const loadAll = useCallback(async () => {
    try {
      const [tel, ords, pos, lat, wals, risk] = await Promise.allSettled([
        fetchTelemetry(),
        fetchOrders(50),
        fetchPositions(),
        fetchLatency(50),
        fetchWallets(),
        fetchRiskConfig(),
      ]);

      if (tel.status === 'fulfilled') setTelemetry(tel.value);
      if (ords.status === 'fulfilled') setOrders(ords.value);
      if (pos.status === 'fulfilled') setPositions(pos.value);
      if (lat.status === 'fulfilled') setLatencySamples(lat.value);
      if (wals.status === 'fulfilled') setWallets(wals.value);
      if (risk.status === 'fulfilled') setRiskConfig(risk.value);

      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.warn('Dashboard data fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced refresh handler triggered by SSE events
  const onSseEvent = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      loadAll();
    }, 250);
  }, [loadAll]);

  const eventStream = useEventStream({
    onEvent: onSseEvent,
  });

  useEffect(() => {
    loadAll();

    // Background polling reconciliation every 5s
    const pollInterval = setInterval(() => {
      loadAll();
    }, 5000);

    return () => {
      clearInterval(pollInterval);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [loadAll]);

  return {
    telemetry,
    orders,
    positions,
    latencySamples,
    wallets,
    riskConfig,
    isLoading,
    lastRefreshedAt,
    streamStatus: eventStream.status,
    liveEvents: eventStream.events,
    isStreamPaused: eventStream.isPaused,
    setIsStreamPaused: eventStream.setIsPaused,
    clearEvents: eventStream.clearEvents,
    refresh: loadAll,
  };
}
