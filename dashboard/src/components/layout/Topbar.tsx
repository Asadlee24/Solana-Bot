import {
  Clock,
  Menu,
  Play,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  ShieldX,
  Target,
  Wifi,
  WifiOff,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { formatClockTime, formatShortAddress, formatUptime } from '../../lib/format';
import { NavigationTab, StreamStatus, Telemetry } from '../../types/dashboard';
import { ApiConfigModal } from '../common/ApiConfigModal';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';
import { StatusDot } from '../common/StatusDot';
import { WalletButton } from '../wallet/WalletButton';

interface TopbarProps {
  activeTab: NavigationTab;
  telemetry: Telemetry | null;
  streamStatus: StreamStatus;
  onRefresh: () => void;
  onSimulate: () => void;
  isSimulating: boolean;
  onMobileMenuToggle: () => void;
  targetWallet?: string;
}

export const Topbar: React.FC<TopbarProps> = ({
  activeTab,
  telemetry,
  streamStatus,
  onRefresh,
  onSimulate,
  isSimulating,
  onMobileMenuToggle,
  targetWallet = 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
}) => {
  const [localTime, setLocalTime] = useState<string>(formatClockTime(Date.now()));
  const [isApiConfigOpen, setIsApiConfigOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setLocalTime(formatClockTime(Date.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const tabTitles: Record<NavigationTab, { title: string; subtitle: string }> = {
    overview: { title: 'Overview', subtitle: 'Real-time hot path operations & telemetry' },
    trades: { title: 'Live Mirror Trades', subtitle: 'Target wallet trades vs follower execution' },
    positions: { title: 'Portfolio Positions', subtitle: 'Active tokens, cost basis & live PnL' },
    latency: { title: 'Latency Analytics', subtitle: 'Microsecond stage breakdown & entry gap' },
    wallets: { title: 'Watched Wallets', subtitle: 'Target wallets & copy allocation limits' },
    risk: { title: 'Risk Engine', subtitle: 'Pre-trade controls & circuit breaker status' },
    system: { title: 'System Diagnostics', subtitle: 'Process telemetry & live event console' },
  };

  const isLive = telemetry?.executionMode === 'LIVE';
  const isTripped = telemetry?.circuitBreakerTripped;

  return (
    <header className="terminal-topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="btn-mobile-menu"
          onClick={onMobileMenuToggle}
          title="Toggle Navigation Menu"
        >
          <Menu size={18} />
        </button>

        <div className="topbar-crumb">
          <span className="crumb-page">{tabTitles[activeTab].title}</span>
          <span className="crumb-sub">{tabTitles[activeTab].subtitle}</span>
        </div>
      </div>

      <div className="topbar-right">
        {/* Stream Status Cluster */}
        <div
          className="topbar-cluster-item"
          onClick={() => setIsApiConfigOpen(true)}
          title={`Signal Feed: ${streamStatus} — Click to configure Bot Backend API URL`}
          style={{ cursor: 'pointer' }}
        >
          {streamStatus === 'CONNECTED' ? (
            <Wifi size={14} color="#10b981" />
          ) : (
            <WifiOff size={14} color="#ef4444" />
          )}
          <StatusDot
            status={
              streamStatus === 'CONNECTED'
                ? 'online'
                : streamStatus === 'RECONNECTING'
                ? 'warning'
                : 'offline'
            }
            size={7}
          />
          <span className="cluster-text mono">
            {streamStatus === 'CONNECTED'
              ? 'LIVE FEED'
              : streamStatus === 'RECONNECTING'
              ? 'RECONNECTING'
              : 'OFFLINE'}
          </span>
          <Settings size={11} color="var(--text-muted)" style={{ marginLeft: 3, opacity: 0.7 }} />
        </div>

        {/* Target Trader Wallet Chip */}
        <div className="topbar-cluster-item wallet-chip" title={`Target: ${targetWallet}`}>
          <Target size={13} color="#29d4ff" />
          <span className="cluster-label">TARGET:</span>
          <span className="cluster-text mono">{formatShortAddress(targetWallet, 4, 4)}</span>
          <CopyButton text={targetWallet} size={11} />
        </div>

        {/* Execution Mode Badge */}
        <Badge variant={isLive ? 'live' : 'paper'} size="sm">
          {isLive ? '● LIVE EXECUTION' : 'PAPER SIM'}
        </Badge>

        {/* Circuit Breaker Status */}
        <div
          className={`circuit-status-chip ${isTripped ? 'tripped' : 'armed'}`}
          title={isTripped ? 'Circuit breaker is TRIPPED' : 'Risk engine is ARMED and protecting trades'}
        >
          {isTripped ? <ShieldX size={13} /> : <ShieldCheck size={13} />}
          <span>{isTripped ? 'BREAKER TRIPPED' : 'RISK ARMED'}</span>
        </div>

        {/* Uptime and Clock */}
        <div className="topbar-cluster-item clock-item hide-mobile">
          <Clock size={13} color="var(--text-muted)" />
          <span className="cluster-text mono">{localTime}</span>
          <span className="uptime-tag">UP: {formatUptime(telemetry?.uptimeSeconds)}</span>
        </div>

        {/* Backend API Config Button */}
        <button
          type="button"
          className="btn-topbar-refresh"
          onClick={() => setIsApiConfigOpen(true)}
          title="Backend API Connection Settings"
        >
          <Server size={14} />
        </button>

        {/* Developer Simulation Trigger (Secondary Button) */}
        {!isLive && (
          <button
            type="button"
            className="btn-dev-simulate"
            onClick={onSimulate}
            disabled={isSimulating}
            title="Simulate a target buy event to test pipeline and UI in paper mode"
          >
            <Play size={11} />
            <span>{isSimulating ? 'Simulating...' : 'Test Event'}</span>
          </button>
        )}

        {/* Solana Wallet Connect Control */}
        <WalletButton />

        {/* Refresh Action */}
        <button
          type="button"
          className="btn-topbar-refresh"
          onClick={onRefresh}
          title="Refresh All Dashboard Data"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <ApiConfigModal
        isOpen={isApiConfigOpen}
        onClose={() => setIsApiConfigOpen(false)}
        onSaved={onRefresh}
      />
    </header>
  );
};
