import React from 'react';
import { WalletTable } from '../components/wallets/WalletTable';
import { WatchedWallet } from '../types/dashboard';

interface WalletsProps {
  wallets: WatchedWallet[];
  onRefresh: () => void;
  isLoading?: boolean;
}

export const Wallets: React.FC<WalletsProps> = ({ wallets, onRefresh, isLoading }) => {
  return (
    <div className="wallets-page-root">
      <div className="page-header-block">
        <h2 className="page-title">Watched Target Wallets</h2>
        <p className="page-subtitle">
          Configure and manage monitored Solana trader wallets, customize position sizing models, and set individual maximum capital exposure caps.
        </p>
      </div>

      <WalletTable wallets={wallets} onRefresh={onRefresh} isLoading={isLoading} />
    </div>
  );
};
