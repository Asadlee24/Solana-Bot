import { ChevronDown, Wallet } from 'lucide-react';
import React, { useState } from 'react';
import { SolanaWalletState } from '../../hooks/useSolanaWallet';
import { WalletAccountMenu } from './WalletAccountMenu';

interface ConnectedWalletPillProps {
  wallet: SolanaWalletState;
}

export const ConnectedWalletPill: React.FC<ConnectedWalletPillProps> = ({ wallet }) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Generate a deterministic gradient avatar from address
  const getAvatarGradient = (addr: string | null) => {
    if (!addr || addr.length < 6) {
      return 'linear-gradient(135deg, #9945ff, #14f195)';
    }
    const c1 = `#${addr.substring(0, 6)}`;
    return `linear-gradient(135deg, #9945ff 0%, #14f195 100%)`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsMenuOpen(!isMenuOpen);
    }
  };

  return (
    <div className="connected-wallet-wrapper">
      <button
        type="button"
        className={`connected-wallet-pill ${isMenuOpen ? 'active' : ''}`}
        onClick={() => setIsMenuOpen(!isMenuOpen)}
        onKeyDown={handleKeyDown}
        aria-haspopup="dialog"
        aria-expanded={isMenuOpen}
        title={`${wallet.walletName}: ${wallet.address} (${wallet.balanceFormatted})`}
      >
        {/* Wallet Avatar / Icon */}
        <div className="wallet-pill-avatar" style={{ background: getAvatarGradient(wallet.address) }}>
          {wallet.walletIcon ? (
            <img src={wallet.walletIcon} alt="" className="avatar-img" />
          ) : (
            <Wallet size={11} color="#ffffff" />
          )}
        </div>

        {/* Short Address */}
        <span className="wallet-pill-address mono font-semibold">
          {wallet.shortAddress || 'Connected'}
        </span>

        {/* Real SOL Balance */}
        <div className="wallet-pill-balance mono">
          {wallet.balanceFormatted}
        </div>

        {/* Dropdown Indicator */}
        <ChevronDown
          size={12}
          className={`wallet-pill-chevron ${isMenuOpen ? 'open' : ''}`}
        />
      </button>

      {/* Account Menu Dropdown */}
      <WalletAccountMenu
        wallet={wallet}
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
      />
    </div>
  );
};
