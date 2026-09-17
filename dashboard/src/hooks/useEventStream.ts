import { useEffect, useRef, useState } from 'react';
import { getApiBase } from '../lib/api';
import { LiveConsoleEvent, StreamStatus } from '../types/dashboard';

interface UseEventStreamOptions {
  onEvent?: (event: string, data: any) => void;
  maxEvents?: number;
}

export function useEventStream(options: UseEventStreamOptions = {}) {
  const { onEvent, maxEvents = 100 } = options;
  const [status, setStatus] = useState<StreamStatus>('OFFLINE');
  const [events, setEvents] = useState<LiveConsoleEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);
  const retryCountRef = useRef(0);

  const addEvent = (type: LiveConsoleEvent['type'], summary: string, payload: any) => {
    if (isPaused) return;
    const newEv: LiveConsoleEvent = {
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      type,
      summary,
      payload,
    };
    setEvents((prev) => [newEv, ...prev.slice(0, maxEvents - 1)]);
  };

  const connect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('RECONNECTING');

    try {
      const apiBase = getApiBase();
      const streamUrl = `${apiBase}/api/events/stream`;
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus('CONNECTED');
        retryCountRef.current = 0;
        addEvent('SYS_MSG', 'Connected to SSE real-time stream', { time: Date.now() });
      };

      es.onerror = () => {
        setStatus('OFFLINE');
        es.close();
        eventSourceRef.current = null;

        const delay = Math.min(1000 * Math.pow(1.5, retryCountRef.current), 15000);
        retryCountRef.current++;

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      };

      es.addEventListener('targetEvent', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addEvent('TARGET_EVENT', `Target trade detected: ${data.side || 'BUY'}`, data);
          onEvent?.('targetEvent', data);
        } catch {}
      });

      es.addEventListener('mirrorOrder', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addEvent('MIRROR_ORDER', `Mirror order ${data.status || 'FILLED'}: ${data.side || 'BUY'}`, data);
          onEvent?.('mirrorOrder', data);
        } catch {}
      });

      es.addEventListener('positionUpdate', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addEvent('POSITION_UPDATE', `Position updated: ${data.tokenMint ? data.tokenMint.substring(0, 6) : 'Position'}`, data);
          onEvent?.('positionUpdate', data);
        } catch {}
      });

      es.addEventListener('latencySample', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addEvent('LATENCY_SAMPLE', `Reaction latency sample: ${data.l_decision_ms || 0}ms`, data);
          onEvent?.('latencySample', data);
        } catch {}
      });

      es.addEventListener('telemetryTick', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('telemetryTick', data);
        } catch {}
      });

      es.addEventListener('ping', () => {
        setStatus('CONNECTED');
      });
    } catch {
      setStatus('OFFLINE');
    }
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  return {
    status,
    events,
    isPaused,
    setIsPaused,
    clearEvents: () => setEvents([]),
  };
}
