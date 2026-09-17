import {
  Activity,
  CheckCircle2,
  Database,
  Radio,
  RadioTower,
  Server,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import React from 'react';
import { formatTimeAgo } from '../../lib/format';
import { StreamStatus, Telemetry } from '../../types/dashboard';
import { StatusDot } from '../common/StatusDot';

interface BotHealthPanelProps {
  telemetry: Telemetry | null;
  streamStatus: StreamStatus;
  lastOrderTime?: number;
}

export const BotHealthPanel: React.FC<BotHealthPanelProps> = ({
  telemetry,
  streamStatus,
  lastOrderTime,
}) => {
  const isTripped = telemetry?.circuitBreakerTripped;
  const isLive = telemetry?.executionMode === 'LIVE';

  const healthItems = [
    {
      title: 'Stream Ingest',
      status: streamStatus === 'CONNECTED' ? 'online' : 'offline',
      statusText: streamStatus === 'CONNECTED' ? 'LaserStream Active' : 'Disconnected',
      icon: <Radio size={14} />,
      detail: 'Helius WebSocket RPC',
    },
    {
      title: 'Execution Mode',
      status: isLive ? 'warning' : 'purple',
      statusText: isLive ? 'LIVE MAINNET' : 'PAPER SIMULATION',
      icon: <Server size={14} />,
      detail: isLive ? 'Zero-tolerance capital' : 'Zero capital risk',
    },
    {
      title: 'Risk Guard',
      status: isTripped ? 'offline' : 'online',
      statusText: isTripped ? 'CIRCUIT TRIPPED' : 'ARMED & ACTIVE',
      icon: isTripped ? <ShieldX size={14} /> : <ShieldCheck size={14} />,
      detail: isTripped ? 'Trading suspended' : 'Max exposure protected',
    },
    {
      title: 'Storage & State',
      status: 'online',
      statusText: 'SQLite WAL OK',
      icon: <Database size={14} />,
      detail: 'Zero-latency local DB',
    },
    {
      title: 'Last Target Signal',
      status: telemetry?.lastSignalTimestamp ? 'online' : 'neutral',
      statusText: formatTimeAgo(telemetry?.lastSignalTimestamp),
      icon: <RadioTower size={14} />,
      detail: 'Watched wallet activity',
    },
    {
      title: 'Last Executed Order',
      status: lastOrderTime ? 'online' : 'neutral',
      statusText: formatTimeAgo(lastOrderTime),
      icon: <Activity size={14} />,
      detail: 'Mirror order dispatch',
    },
  ];

  return (
    <div className="terminal-health-grid">
      {healthItems.map((item) => (
        <div key={item.title} className="health-card">
          <div className="health-card-top">
            <span className="health-icon">{item.icon}</span>
            <span className="health-title">{item.title}</span>
            <StatusDot status={item.status as any} size={7} />
          </div>

          <div className="health-status-text">{item.statusText}</div>
          <div className="health-detail-text">{item.detail}</div>
        </div>
      ))}
    </div>
  );
};
