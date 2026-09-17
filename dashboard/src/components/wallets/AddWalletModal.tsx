import { AlertCircle, Plus } from 'lucide-react';
import React, { useState } from 'react';
import { addWallet } from '../../lib/api';
import { Modal } from '../common/Modal';

interface AddWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const AddWalletModal: React.FC<AddWalletModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [wallet, setWallet] = useState('');
  const [label, setLabel] = useState('');
  const [buyMode, setBuyMode] = useState('FIXED_SIZE');
  const [fixedBuySol, setFixedBuySol] = useState('0.1');
  const [copyRatio, setCopyRatio] = useState('0.05');
  const [maxBuySol, setMaxBuySol] = useState('1.0');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Solana Base58 validation regex (32-44 alphanumeric base58 characters)
  const isValidSolanaPubkey = (addr: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedWallet = wallet.trim();
    if (!trimmedWallet) {
      setError('Please provide a Solana wallet public key.');
      return;
    }

    if (!isValidSolanaPubkey(trimmedWallet)) {
      setError('Invalid Solana public key format (must be 32–44 Base58 characters).');
      return;
    }

    const buyLamports = Math.floor(parseFloat(fixedBuySol || '0.1') * 1e9).toString();
    const maxLamports = Math.floor(parseFloat(maxBuySol || '1.0') * 1e9).toString();

    setIsSubmitting(true);
    try {
      await addWallet({
        wallet: trimmedWallet,
        label: label.trim() || 'Target Trader',
        buyMode,
        fixedBuyLamports: buyLamports,
        copyRatio: parseFloat(copyRatio || '0.05'),
        maxBuyLamports: maxLamports,
      });

      setWallet('');
      setLabel('');
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to add target wallet.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Watched Target Wallet"
      subtitle="Register a Solana address to monitor on-chain trades and mirror executions."
      maxWidth={520}
    >
      <form onSubmit={handleSubmit} className="terminal-modal-form">
        {error && (
          <div className="form-error-banner">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="form-field">
          <label className="field-label">
            Target Wallet Public Key <span className="text-rose">*</span>
          </label>
          <input
            type="text"
            className="terminal-text-input mono"
            placeholder="e.g. CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            disabled={isSubmitting}
            autoFocus
          />
          <span className="field-hint">Enter the target trader's public address (Base58).</span>
        </div>

        <div className="form-field">
          <label className="field-label">Custom Label / Alias</label>
          <input
            type="text"
            className="terminal-text-input"
            placeholder="e.g. Alpha Sniper 1, Pump.fun Pro"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        <div className="form-field">
          <label className="field-label">Position Sizing Strategy</label>
          <select
            className="terminal-select-input"
            value={buyMode}
            onChange={(e) => setBuyMode(e.target.value)}
            disabled={isSubmitting}
          >
            <option value="FIXED_SIZE">FIXED_SIZE (Fixed SOL per buy signal)</option>
            <option value="TARGET_NOTIONAL_SCALAR">TARGET_NOTIONAL_SCALAR (Proportional to target spend)</option>
            <option value="CAPPED_PROPORTIONAL_HYBRID">CAPPED_PROPORTIONAL_HYBRID (Proportional with hard cap)</option>
          </select>
        </div>

        <div className="form-row-grid">
          <div className="form-field">
            <label className="field-label">Fixed Buy Size (SOL)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max="10"
              className="terminal-text-input mono"
              value={fixedBuySol}
              onChange={(e) => setFixedBuySol(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div className="form-field">
            <label className="field-label">Copy Ratio (Scalar)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max="1.0"
              className="terminal-text-input mono"
              value={copyRatio}
              onChange={(e) => setCopyRatio(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
        </div>

        <div className="form-field">
          <label className="field-label">Maximum Exposure Cap per Trade (SOL)</label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="20"
            className="terminal-text-input mono"
            value={maxBuySol}
            onChange={(e) => setMaxBuySol(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        <div className="modal-actions-row">
          <button
            type="button"
            className="btn-cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-submit-primary"
            disabled={isSubmitting}
          >
            <Plus size={14} />
            <span>{isSubmitting ? 'Registering...' : 'Register Target Wallet'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
