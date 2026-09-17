import {
  Cpu,
  Database,
  Globe,
  HardDrive,
  Radio,
  Server,
  Shield,
  Zap,
} from 'lucide-react';
import React from 'react';
import { formatUptime } from '../../lib/format';
import { StreamStatus, Telemetry } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { MetricCard } from '../common/MetricCard';
import { StatusDot } from '../common/StatusDot';

interface SystemDiagnosticsProps {
  telemetry: Telemetry | null;
  streamStatus: StreamStatus;
}

export const SystemDiagnostics: React.FC<SystemDiagnosticsProps> = ({
  telemetry,
  streamStatus,
}) => {
  const isLive = telemetry?.executionMode === 'LIVE';

  return (
    <div className="system-diag-root">
      <div className="diag-kpi-grid">
        <MetricCard
          label="Process Uptime"
          value={formatUptime(telemetry?.uptimeSeconds)}
          subValue="Zero-crash active daemon"
          icon={<Server size={16} />}
          tone="cyan"
        />

        <MetricCard
          label="Execution Engine Mode"
          value={telemetry?.executionMode || 'PAPER'}
          subValue={isLive ? 'Real on-chain capital active' : 'Zero-risk simulation'}
          icon={<Zap size={16} />}
          tone={isLive ? 'warning' : 'purple'}
        />

        <MetricCard
          label="Total Trades Handled"
          value={telemetry?.totalTradesProcessed || 0}
          subValue="Hot path reconciled trades"
          icon={<Database size={16} />}
          tone="positive"
        />

        <MetricCard
          label="SSE Feed Status"
          value={streamStatus}
          subValue="Server-sent events streaming"
          icon={<Radio size={16} />}
          tone={streamStatus === 'CONNECTED' ? 'positive' : 'negative'}
        />
      </div>

      <div className="diag-table-section">
        <h3 className="section-heading">Service Layer Status Matrix</h3>

        <div className="service-matrix-grid">
          <div className="service-row-card">
            <div className="service-left">
              <Radio size={16} color="#10b981" />
              <div>
                <div className="service-name">Helius LaserStream / Geyser WS</div>
                <div className="service-desc">Sub-millisecond on-chain pre-confirmation transactions</div>
              </div>
            </div>
            <Badge variant="success" size="sm">ACTIVE & STREAMING</Badge>
          </div>

          <div className="service-row-card">
            <div className="service-left">
              <Globe size={16} color="#29d4ff" />
              <div>
                <div className="service-name">Mainnet RPC Redundant Poller</div>
                <div className="service-desc">Secondary failover polling loop at 500ms intervals</div>
              </div>
            </div>
            <Badge variant="success" size="sm">ONLINE & POLLING</Badge>
          </div>

          <div className="service-row-card">
            <div className="service-left">
              <HardDrive size={16} color="#c084fc" />
              <div>
                <div className="service-name">SQLite State & Analytics DB</div>
                <div className="service-desc">Write-Ahead Logging (WAL) mode with synchronous NORMAL</div>
              </div>
            </div>
            <Badge variant="paper" size="sm">WAL PERSISTENT</Badge>
          </div>

          <div className="service-row-card">
            <div className="service-left">
              <Shield size={16} color={telemetry?.circuitBreakerTripped ? '#ef4444' : '#14f195'} />
              <div>
                <div className="service-name">Risk Guard & Honeypot Filter</div>
                <div className="service-desc">Pre-trade size check, slippage boundary, error trip breaker</div>
              </div>
            </div>
            <Badge variant={telemetry?.circuitBreakerTripped ? 'danger' : 'success'} size="sm">
              {telemetry?.circuitBreakerTripped ? 'TRIPPED' : 'ARMED'}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  );
};
