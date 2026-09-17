import {
  Check,
  Copy,
  ExternalLink,
  LogOut,
  RefreshCw,
  Repeat,
  Shield,
  Wallet,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { SolanaWalletState } from '../../hooks/useSolanaWallet';
import { CopyButton } from '../common/CopyButton';

interface WalletAccountMenuProps {
  wallet: SolanaWalletState;
  isOpen: boolean;
  onClose: () => void;
}

export const WalletAccountMenu: React.FC<WalletAccountMenuProps> = ({
  wallet,
  isOpen,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Close on Escape or click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !wallet.address) return null;

  const handleCopy = () => {
    if (wallet.address) {
      navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleRefreshBalance = async () => {
    setIsRefreshing(true);
    await wallet.refreshBalance();
    setIsRefreshing(false);
  };

  const handleChangeWallet = async () => {
    onClose();
    await wallet.openWalletModal();
  };

  const handleDisconnect = async () => {
    onClose();
    await wallet.disconnect();
  };

  return (
    <div
      ref={menuRef}
      className="wallet-account-menu"
      role="dialog"
      aria-label="Connected Wallet Menu"
      tabIndex={-1}
    >
      {/* Header */}
      <div className="wam-header">
        <div className="wam-title-row">
          <div className="wam-badge-role">
            <span className="role-dot" />
            <span>DASHBOARD WALLET</span>
          </div>
          <button
            type="button"
            className="wam-close-btn"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={14} />
          </button>
        </div>
        <div className="wam-provider-info">
          {wallet.walletIcon ? (
            <img src={wallet.walletIcon} alt={wallet.walletName} className="wam-provider-icon" />
          ) : (
            <div className="wam-provider-avatar">
              <Wallet size={14} color="#14f195" />
            </div>
          )}
          <div className="wam-provider-text">
            <span className="wam-provider-name">{wallet.walletName}</span>
            <span className="wam-network-tag">{wallet.network}</span>
          </div>
        </div>
      </div>

      {/* Address & Copy Block */}
      <div className="wam-address-box">
        <span className="wam-address-label">ACCOUNT ADDRESS</span>
        <div className="wam-address-row">
          <span className="wam-address-full mono" title={wallet.address}>
            {wallet.address}
          </span>
          <button
            type="button"
            className="wam-icon-btn"
            onClick={handleCopy}
            title="Copy address"
            aria-label="Copy full wallet address"
          >
            {copied ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* Balance Summary Box */}
      <div className="wam-balance-card">
        <div className="wam-balance-left">
          <span className="wam-balance-label">SOL BALANCE</span>
          <span className="wam-balance-value mono">{wallet.balanceFormatted}</span>
        </div>
        <button
          type="button"
          className={`wam-refresh-btn ${isRefreshing ? 'spinning' : ''}`}
          onClick={handleRefreshBalance}
          title="Refresh Balance"
          aria-label="Refresh SOL balance"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Security Context Notice */}
      <div className="wam-security-note">
        <Shield size={12} color="#29d4ff" />
        <span>Read-only UI identity. Bot execution keypair remains strictly independent.</span>
      </div>

      {/* Actions List */}
      <div className="wam-actions-list">
        <a
          href={`https://solscan.io/account/${wallet.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="wam-action-item"
        >
          <ExternalLink size={13} />
          <span>View on Solscan</span>
        </a>

        <button
          type="button"
          className="wam-action-item"
          onClick={handleChangeWallet}
        >
          <Repeat size={13} />
          <span>Change Wallet</span>
        </button>

        <button
          type="button"
          className="wam-action-item danger"
          onClick={handleDisconnect}
        >
          <LogOut size={13} />
          <span>Disconnect</span>
        </button>
      </div>
    </div>
  );
};
