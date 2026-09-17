import { AlertTriangle, RotateCcw } from 'lucide-react';
import React, { useState } from 'react';
import { resetCircuitBreaker } from '../../lib/api';
import { Modal } from '../common/Modal';

interface CircuitBreakerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  isLive?: boolean;
}

export const CircuitBreakerModal: React.FC<CircuitBreakerModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  isLive = false,
}) => {
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReset = async () => {
    setIsResetting(true);
    setError(null);
    try {
      await resetCircuitBreaker();
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to reset circuit breaker.');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Reset Risk Circuit Breaker"
      subtitle="Re-arm the automated copy-trading engine and resume execution."
      maxWidth={460}
    >
      <div className="circuit-breaker-modal-content">
        <div className="warning-callout-box">
          <AlertTriangle size={20} color="#f59e0b" style={{ flexShrink: 0 }} />
          <div>
            <div className="callout-title">Confirm Breaker Reset</div>
            <div className="callout-body">
              {isLive ? (
                <strong style={{ color: '#ef4444' }}>
                  CAUTION: You are operating in LIVE MAINNET execution mode. Resetting this circuit breaker will immediately resume capital deployment upon new target signals.
                </strong>
              ) : (
                'Resetting clears consecutive error counters and daily loss limits. The mirror engine will resume evaluating and executing copy orders.'
              )}
            </div>
          </div>
        </div>

        {error && <div className="form-error-banner">{error}</div>}

        <div className="modal-actions-row" style={{ marginTop: 24 }}>
          <button
            type="button"
            className="btn-cancel"
            onClick={onClose}
            disabled={isResetting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger-confirm"
            onClick={handleReset}
            disabled={isResetting}
          >
            <RotateCcw size={14} />
            <span>{isResetting ? 'Resetting...' : 'Reset & Re-arm Engine'}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
};
