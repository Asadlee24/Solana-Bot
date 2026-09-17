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
            {isLive ? (isArmed ? '● LIVE ARMED' : '○ LIVE DISARMED') : 'PAPER SIMULATION'}
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
              {isArmed ? 'Execution Engine Armed and Ready' : 'Execution Engine Disarmed'}
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
