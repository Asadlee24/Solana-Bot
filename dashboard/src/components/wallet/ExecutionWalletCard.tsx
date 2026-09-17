import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Flame,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Wallet,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { formatShortAddress } from '../../lib/format';
import { LiveEngineStatus } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';

export const ExecutionWalletCard: React.FC = () => {
  const [liveStatus, setLiveStatus] = useState<LiveEngineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/live/status');
      if (res.ok) {
        const data = await res.json();
        setLiveStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch live execution status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 6000);
    return () => clearInterval(interval);
  }, []);

  const handleKill = async () => {
    const confirmKill = window.confirm(
      'EMERGENCY STOP LIVE TRADING?\n\nThis will immediately disarm the automated execution engine. No further live trades will be copied until explicitly re-armed.'
    );
    if (!confirmKill) return;

    try {
      setActionLoading(true);
      const res = await fetch('/api/live/kill', { method: 'POST' });
      if (res.ok) {
        await fetchStatus();
      }
    } catch (err) {
      alert('Error triggering kill switch: ' + String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleArm = async () => {
    try {
      setActionLoading(true);
      const res = await fetch('/api/live/arm', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        alert('Cannot Arm Live Execution:\n\n' + data.reason);
      }
      await fetchStatus();
    } catch (err) {
      alert('Error arming live engine: ' + String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const isLive = liveStatus?.executionMode === 'LIVE';
  const isArmed = liveStatus?.isArmed ?? false;
  const pubkey = liveStatus?.wallet.publicKey;
  const balanceSol = liveStatus?.wallet.balanceSol ?? 0;
  const reserveSol = liveStatus?.wallet.reserveSol ?? 0.05;
  const spendableSol = liveStatus?.wallet.spendableSol ?? 0;

  return (
    <div className="wallet-info-card-root">
      <div className="card-header-row">
        <div className="card-title-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '6px',
                background: isArmed ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isArmed ? '#10b981' : '#ef4444',
              }}
            >
              <Flame size={16} />
            </div>
            <div>
              <h3 className="card-title">AUTOMATED EXECUTION WALLET (HOT WALLET)</h3>
              <p className="card-subtitle">
                Dedicated backend signer for sub-millisecond Solana mainnet execution. Strictly isolated from browser wallet.
              </p>
            </div>
          </div>
        </div>

        <div className="card-actions-cluster">
          <Badge variant={isLive ? (isArmed ? 'live' : 'danger') : 'paper'} size="sm">
            {isLive
              ? (isArmed
                  ? '● LIVE ARMED'
                  : (liveStatus?.smokeTestTradesCount && liveStatus.smokeTestTradesCount >= 1
                      ? 'SMOKE TEST COMPLETE'
                      : '○ LIVE DISARMED'))
              : 'PAPER SIMULATION'}
          </Badge>
          <button
            type="button"
            className="btn-card-refresh"
            onClick={fetchStatus}
            disabled={loading}
            title="Refresh on-chain balance"
          >
            <RefreshCw size={12} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      <div className="wallet-card-grid">
        {/* Public Key */}
        <div className="wallet-stat-block">
          <div className="stat-label">HOT WALLET ADDRESS</div>
          <div className="stat-value mono text-sm" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {pubkey ? (
              <>
                <span>{formatShortAddress(pubkey, 6, 6)}</span>
                <CopyButton text={pubkey} size={11} />
                <a
                  href={`https://solscan.io/account/${pubkey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-solscan"
                  title="View Hot Wallet on Solscan"
                >
                  <ExternalLink size={12} />
                </a>
              </>
            ) : (
              <span className="text-muted">Not Configured</span>
            )}
          </div>
        </div>

        {/* Real SOL Balance */}
        <div className="wallet-stat-block">
          <div className="stat-label">ON-CHAIN BALANCE</div>
          <div className="stat-value mono text-cyan">
            {loading ? '...' : `${balanceSol.toFixed(4)} SOL`}
          </div>
        </div>

        {/* Reserve Floor */}
        <div className="wallet-stat-block">
          <div className="stat-label">RESERVE FLOOR</div>
          <div className="stat-value mono text-amber">
            {reserveSol.toFixed(4)} SOL
          </div>
        </div>

        {/* Spendable Capital */}
        <div className="wallet-stat-block">
          <div className="stat-label">SPENDABLE CAPITAL</div>
          <div className="stat-value mono text-emerald">
            {spendableSol.toFixed(4)} SOL
          </div>
        </div>
      </div>

      {/* Smoke Test Safety & Balance Verification Panel */}
      <div
        style={{
          marginTop: '14px',
          padding: '12px 16px',
          borderRadius: '8px',
          background: 'rgba(20, 241, 149, 0.04)',
          border: '1px solid rgba(20, 241, 149, 0.2)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={16} color="#14f195" />
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', color: '#14f195' }}>
              MAINNET SMOKE-TEST VERIFICATION GATEWAY
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <Badge variant="live" size="sm">SMOKE TEST MODE</Badge>
            <Badge variant="buy" size="sm">BUY ONLY</Badge>
            <Badge variant="success" size="sm">FORCE JUPITER V2</Badge>
            <Badge variant={isArmed ? 'live' : 'neutral'} size="sm">
              {isArmed ? '● LIVE ARMED' : '○ LIVE DISARMED'}
            </Badge>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', fontSize: '11px' }}>
          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>MINIMUM BALANCE TO ARM</div>
            <div className="mono" style={{ color: '#fbbf24', fontWeight: 700, fontSize: '13px' }}>
              0.03 SOL minimum
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '2px' }}>
              (0.01 SOL trade + 0.02 SOL reserve floor)
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>RECOMMENDED FUNDING</div>
            <div className="mono" style={{ color: '#14f195', fontWeight: 700, fontSize: '13px' }}>
              0.04 SOL funded test wallet
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '2px' }}>
              (Safe buffer for 0.01 trade, fees & reserve)
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>EXECUTION ROUTE & LIFECYCLE</div>
            <div className="mono" style={{ color: '#38bdf8', fontWeight: 600, fontSize: '12px' }}>
              Jupiter V2 Managed Landing
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '2px' }}>
              Strict 1-BUY execution → Auto-Disarm on broadcast
            </div>
          </div>
        </div>
      </div>

      {/* Safety Status & Controls */}
      <div
        style={{
          marginTop: '16px',
          padding: '12px 16px',
          borderRadius: '8px',
          background: isArmed ? 'rgba(16,185,129,0.05)' : 'rgba(239,68,68,0.05)',
          border: `1px solid ${isArmed ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}>
            {isArmed ? (
              <ShieldCheck size={14} color="#10b981" />
            ) : (
              <ShieldAlert size={14} color="#ef4444" />
            )}
            <span style={{ color: isArmed ? '#10b981' : '#ef4444' }}>
              {isArmed
                ? 'Execution Engine Armed and Ready'
                : (liveStatus?.smokeTestTradesCount && liveStatus.smokeTestTradesCount >= 1
                    ? 'SMOKE TEST COMPLETE — LIVE DISARMED'
                    : 'Execution Engine Disarmed')}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {liveStatus?.disarmReason || 'Safety conditions verified.'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isLive && (
            isArmed ? (
              <button
                type="button"
                onClick={handleKill}
                disabled={actionLoading}
                style={{
                  background: '#ef4444',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <ShieldX size={13} />
                <span>STOP LIVE TRADING</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleArm}
                disabled={actionLoading}
                style={{
                  background: '#10b981',
                  color: '#07090e',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <ShieldCheck size={13} />
                <span>ARM LIVE TRADING</span>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
};
