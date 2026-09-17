import { AlertCircle, Loader2, Wallet, X } from 'lucide-react';
import React, { useState } from 'react';
import { useSolanaWallet } from '../../hooks/useSolanaWallet';
import { ConnectedWalletPill } from './ConnectedWalletPill';

export const WalletButton: React.FC = () => {
  const wallet = useSolanaWallet();
  const [showUnavailableModal, setShowUnavailableModal] = useState(false);

  // If connected, render the account pill and dropdown
  if (wallet.isConnected) {
    return <ConnectedWalletPill wallet={wallet} />;
  }

  const handleClick = async () => {
    if (!wallet.isAvailable) {
      setShowUnavailableModal(true);
      return;
    }
    await wallet.openWalletModal();
  };

  return (
    <>
      <button
        type="button"
        className="btn-wallet-connect"
        onClick={handleClick}
        disabled={wallet.isConnecting}
        title={
          !wallet.isAvailable
            ? 'Wallet Connect Unavailable: VITE_REOWN_PROJECT_ID missing'
            : 'Connect Solana Wallet'
        }
        aria-label="Connect Solana Wallet"
      >
        {wallet.isConnecting ? (
          <>
            <Loader2 size={13} className="spin-fast" />
            <span>Connecting...</span>
          </>
        ) : (
          <>
            <Wallet size={13} />
            <span>Connect Wallet</span>
          </>
        )}
      </button>

      {/* Graceful modal when Reown Project ID is not configured */}
      {showUnavailableModal && (
        <div className="wallet-unavailable-overlay" onClick={() => setShowUnavailableModal(false)}>
          <div
            className="wallet-unavailable-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Wallet Connect Unavailable"
          >
            <div className="wuc-header">
              <div className="wuc-title-group">
                <AlertCircle size={16} color="#f59e0b" />
                <span className="wuc-title">Wallet Connect Unavailable</span>
              </div>
              <button
                type="button"
                className="wuc-close-btn"
                onClick={() => setShowUnavailableModal(false)}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <p className="wuc-message">
              Reown AppKit requires a public Project ID to initialize the Solana wallet modal.
            </p>

            <div className="wuc-guide-box">
              <span className="wuc-step-num">1.</span>
              <span>Get a free Project ID at <strong>cloud.reown.com</strong></span>
            </div>
            <div className="wuc-guide-box">
              <span className="wuc-step-num">2.</span>
              <span>Add <code>VITE_REOWN_PROJECT_ID=your_id</code> to your <code>.env</code> file</span>
            </div>

            <div className="wuc-footer">
              <button
                type="button"
                className="btn-wuc-dismiss"
                onClick={() => setShowUnavailableModal(false)}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
