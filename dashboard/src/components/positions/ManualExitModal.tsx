import { AlertTriangle, CheckCircle2, DollarSign, Loader2, Sparkles, TrendingUp, X } from 'lucide-react';
import React, { useState } from 'react';
import { sellPosition } from '../../lib/api';
import { formatPct, formatSol, formatTokenQty, formatUsd } from '../../lib/format';
import { Position } from '../../types/dashboard';
import { Modal } from '../common/Modal';
import { TokenIdentity } from '../trading/TokenIdentity';

interface ManualExitModalProps {
  position: Position | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const ManualExitModal: React.FC<ManualExitModalProps> = ({
  position,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [fraction, setFraction] = useState<number>(0.5); // Default 50% Take Profit
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<any | null>(null);

  if (!position) return null;

  const meta = position.metadata;
  const symbol = meta?.symbol || position.tokenMint.substring(0, 6);
  const solPrice = 100.0;

  const totalTokens = Number(position.qtyRaw) / 1e6;
  const sellTokens = totalTokens * fraction;

  const currentPriceSol = position.currentPriceSol || position.avgEntryPriceSol || 0;
  const currentPriceUsd = position.currentPriceUsd || currentPriceSol * solPrice;

  const totalValueSol = position.currentValueSol || totalTokens * currentPriceSol;
  const totalValueUsd = position.currentValueUsd || totalValueSol * solPrice;

  const expectedPayoutSol = totalValueSol * fraction;
  const expectedPayoutUsd = totalValueUsd * fraction;

  const pnlSol = position.unrealizedPnlSol ?? 0;
  const pnlUsd = (position.currentValueUsd ?? 0) - (Number(position.costBasisLamports) / 1e9) * solPrice;
  const pnlPct = position.unrealizedPnlPct ?? 0;
  const isProfit = pnlSol >= 0;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await sellPosition(position.id, fraction);
      setSuccessResult(res);
      onSuccess?.();
      setTimeout(() => {
        setSuccessResult(null);
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to execute exit');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`MANUAL TAKE PROFIT / CLOSE — $${symbol}`}
      size="md"
    >
      <div className="manual-exit-modal-content">
        {/* Token Identity Header */}
        <div className="exit-modal-token-row">
          <TokenIdentity mint={position.tokenMint} metadata={meta} size="lg" />
          <div className="exit-pnl-cluster">
            <div className={`exit-pnl-badge ${isProfit ? 'pos' : 'neg'}`}>
              <span className="mono font-bold">
                {isProfit ? 'PROFIT: +' : 'LOSS: '}${Math.abs(pnlUsd).toFixed(2)} USD
              </span>
              <span className="mono" style={{ fontSize: 11 }}>
                ({isProfit ? '+' : ''}{pnlSol.toFixed(4)} SOL • {formatPct(pnlPct, true)})
              </span>
            </div>
          </div>
        </div>

        {/* Current Position Stats Grid with Dollars & SOL */}
        <div className="exit-stats-grid">
          <div className="exit-stat-box">
            <span className="lbl">Tokens Held</span>
            <span className="val mono">{formatTokenQty(position.qtyRaw, 6)}</span>
          </div>
          <div className="exit-stat-box">
            <span className="lbl">Live Market Price</span>
            <span className="val mono text-cyan">
              ${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(7) : currentPriceUsd.toFixed(4)}
            </span>
            <span className="sub mono text-muted">({currentPriceSol.toFixed(8)} SOL)</span>
          </div>
          <div className="exit-stat-box">
            <span className="lbl">Total Position Value</span>
            <span className="val mono font-bold">
              ${totalValueUsd.toFixed(2)} USD
            </span>
            <span className="sub mono text-muted">({totalValueSol.toFixed(4)} SOL)</span>
          </div>
          <div className="exit-stat-box">
            <span className="lbl">Cost Basis</span>
            <span className="val mono">
              ${((Number(position.costBasisLamports) / 1e9) * solPrice).toFixed(2)} USD
            </span>
            <span className="sub mono text-muted">
              ({formatSol(Number(position.costBasisLamports) / 1e9, 4)})
            </span>
          </div>
        </div>

        {/* Sell Percentage Selector */}
        <div className="exit-fraction-section">
          <label className="section-label">SELECT TAKE PROFIT / EXIT SIZE:</label>
          <div className="fraction-pill-buttons">
            {[
              { val: 0.25, label: '25% Partial' },
              { val: 0.5, label: '50% Half Exit' },
              { val: 0.75, label: '75% Major' },
              { val: 1.0, label: '100% Full Close' },
            ].map((btn) => (
              <button
                key={btn.val}
                type="button"
                className={`fraction-pill ${fraction === btn.val ? 'active' : ''}`}
                onClick={() => setFraction(btn.val)}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        {/* Expected Payout Banner */}
        <div className="exit-payout-card">
          <div className="payout-row">
            <span className="payout-label">ESTIMATED PAYOUT ({Math.round(fraction * 100)}%):</span>
            <div className="payout-values">
              <span className="payout-usd mono text-green font-bold">
                +${expectedPayoutUsd.toFixed(2)} USD
              </span>
              <span className="payout-sol mono text-muted">
                (+{expectedPayoutSol.toFixed(4)} SOL)
              </span>
            </div>
          </div>
          <div className="payout-sub">
            Selling approx. <strong>{sellTokens.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong> tokens on AMM bonding curve.
          </div>
        </div>

        {error && (
          <div className="exit-error-banner">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {successResult && (
          <div className="exit-success-banner">
            <CheckCircle2 size={16} className="text-green" />
            <span>Market order submitted and filled successfully!</span>
          </div>
        )}

        {/* Actions */}
        <div className="exit-modal-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn-primary ${fraction === 1.0 ? 'btn-danger' : ''}`}
            onClick={handleConfirm}
            disabled={isSubmitting || Boolean(successResult)}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Executing Sell...</span>
              </>
            ) : fraction === 1.0 ? (
              <span>Close 100% Position Now</span>
            ) : (
              <span>Take Profit ({Math.round(fraction * 100)}%)</span>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};
