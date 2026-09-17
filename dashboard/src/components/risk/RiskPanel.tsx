import {
  AlertOctagon,
  AlertTriangle,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import React, { useState } from 'react';
import { formatBps, formatLatency, formatSol } from '../../lib/format';
import { RiskConfig, Telemetry } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { CircuitBreakerModal } from './CircuitBreakerModal';

interface RiskPanelProps {
  riskConfig: RiskConfig | null;
  telemetry: Telemetry | null;
  onRefresh: () => void;
}

export const RiskPanel: React.FC<RiskPanelProps> = ({
  riskConfig,
  telemetry,
  onRefresh,
}) => {
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);

  const isTripped = telemetry?.circuitBreakerTripped || riskConfig?.circuitBreakerTripped;
  const isLive = telemetry?.executionMode === 'LIVE';

  const consecutiveErrors = riskConfig?.consecutiveErrors ?? telemetry?.consecutiveErrors ?? 0;
  const errorLimit = riskConfig?.consecutiveErrorLimit ?? 5;

  const dailyLossSol = riskConfig?.dailyLossSol ?? 0;
  const dailyLossLimitSol = riskConfig?.dailyLossLimitSol ?? 2.0;

  return (
    <div className="risk-panel-root">
      {/* Breaker Status Hero Banner */}
      <div className={`risk-hero-banner ${isTripped ? 'tripped' : 'armed'}`}>
        <div className="risk-hero-left">
          <div className="risk-hero-icon">
            {isTripped ? <ShieldAlert size={28} /> : <ShieldCheck size={28} />}
          </div>
          <div>
            <div className="risk-hero-title">
              {isTripped ? 'CIRCUIT BREAKER TRIPPED' : 'RISK ENGINE ARMED & ACTIVE'}
            </div>
            <div className="risk-hero-subtitle">
              {isTripped
                ? 'Automated trade execution is suspended. Check consecutive errors or loss thresholds.'
                : 'All pre-trade exposure limits, slippage bounds, and anti-honeypot checks are active.'}
            </div>
          </div>
        </div>

        <div className="risk-hero-right">
          <button
            type="button"
            className="btn-reset-breaker"
            onClick={() => setIsResetModalOpen(true)}
          >
            <RotateCcw size={14} />
            <span>Reset Breaker</span>
          </button>
        </div>
      </div>

      {/* Safety Trip Gauges */}
      <div className="risk-gauges-grid">
        <div className="risk-gauge-card">
          <div className="gauge-header">
            <span className="gauge-label">Consecutive Errors</span>
            <Badge variant={consecutiveErrors > 0 ? 'warn' : 'success'} size="sm">
              {consecutiveErrors} / {errorLimit} max
            </Badge>
          </div>
          <div className="gauge-track">
            <div
              className="gauge-fill"
              style={{
                width: `${Math.min((consecutiveErrors / errorLimit) * 100, 100)}%`,
                backgroundColor: consecutiveErrors >= errorLimit ? '#ef4444' : '#14f195',
              }}
            />
          </div>
          <div className="gauge-sub">
            {consecutiveErrors === 0
              ? 'Zero network or RPC submission errors'
              : `${errorLimit - consecutiveErrors} more will trip breaker`}
          </div>
        </div>

        <div className="risk-gauge-card">
          <div className="gauge-header">
            <span className="gauge-label">Daily Loss Drawdown</span>
            <Badge variant={dailyLossSol > 0 ? 'danger' : 'neutral'} size="sm">
              {formatSol(dailyLossSol, 3)} / {formatSol(dailyLossLimitSol, 2)}
            </Badge>
          </div>
          <div className="gauge-track">
            <div
              className="gauge-fill"
              style={{
                width: `${Math.min((dailyLossSol / dailyLossLimitSol) * 100, 100)}%`,
                backgroundColor: dailyLossSol >= dailyLossLimitSol ? '#ef4444' : '#10b981',
              }}
            />
          </div>
          <div className="gauge-sub">24-hour max loss threshold before automatic shutdown</div>
        </div>
      </div>

      {/* Configured Risk Controls Table */}
      <div className="risk-rules-section">
        <div className="rules-section-header">
          <Shield size={16} color="var(--neon-emerald)" />
          <span>Active Pre-Trade Protection Parameters</span>
        </div>

        <div className="risk-parameters-grid">
          <div className="param-item">
            <span className="param-label">Max Total Portfolio Exposure</span>
            <span className="param-val mono">
              {formatSol(riskConfig?.maxTotalExposureSol ?? 5.0, 1)}
            </span>
            <span className="param-hint">Prevents over-allocation across all open tokens</span>
          </div>

          <div className="param-item">
            <span className="param-label">Preserved SOL Reserve</span>
            <span className="param-val mono">
              {formatSol(riskConfig?.minSolReserveSol ?? 0.2, 2)}
            </span>
            <span className="param-hint">Untouchable balance for network rent & priority fees</span>
          </div>

          <div className="param-item">
            <span className="param-label">Signal Staleness Threshold</span>
            <span className="param-val mono">
              {riskConfig?.maxSignalAgeMs ?? 1500} ms
            </span>
            <span className="param-hint">Signals older than 1.5s are dropped to avoid front-runs</span>
          </div>

          <div className="param-item">
            <span className="param-label">Max Allowed Entry Gap</span>
            <span className="param-val mono">
              {formatBps(riskConfig?.maxEntryGapBps ?? 200)}
            </span>
            <span className="param-hint">Rejects trade if price deteriorated &gt; 2.0% vs target</span>
          </div>

          <div className="param-item">
            <span className="param-label">Maximum AMM Slippage</span>
            <span className="param-val mono">
              {formatBps(riskConfig?.maxSlippageBps ?? 150)}
            </span>
            <span className="param-hint">Bound set on Raydium/Pump bonding curve swap instruction</span>
          </div>

          <div className="param-item">
            <span className="param-label">Known Honeypot Blacklist</span>
            <span className="param-val mono">
              {riskConfig?.mintBlacklist?.length ?? 1} Mints
            </span>
            <span className="param-hint">Instant rejection without calculating quotes</span>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      <CircuitBreakerModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        onSuccess={onRefresh}
        isLive={isLive}
      />
    </div>
  );
};
