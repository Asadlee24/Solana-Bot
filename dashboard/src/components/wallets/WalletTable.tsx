import { Check, Copy, ExternalLink, Plus, Power, ShieldAlert, Target } from 'lucide-react';
import React, { useState } from 'react';
import { addWallet } from '../../lib/api';
import { formatShortAddress, formatSol } from '../../lib/format';
import { WatchedWallet } from '../../types/dashboard';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';
import { EmptyState } from '../common/EmptyState';
import { AddWalletModal } from './AddWalletModal';

interface WalletTableProps {
  wallets: WatchedWallet[];
  onRefresh: () => void;
  isLoading?: boolean;
}

export const WalletTable: React.FC<WalletTableProps> = ({ wallets, onRefresh, isLoading }) => {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [togglingWallet, setTogglingWallet] = useState<string | null>(null);

  const handleToggle = async (w: WatchedWallet) => {
    setTogglingWallet(w.wallet);
    try {
      await addWallet({
        wallet: w.wallet,
        label: w.label,
        enabled: !w.enabled,
        buyMode: w.buyMode,
        fixedBuyLamports: w.fixedBuyLamports,
        copyRatio: w.copyRatio,
        maxBuyLamports: w.maxBuyLamports,
      });
      onRefresh();
    } catch (err) {
      console.warn('Failed to toggle wallet:', err);
    } finally {
      setTogglingWallet(null);
    }
  };

  return (
    <div className="wallets-table-root">
      <div className="wallets-header-bar">
        <div>
          <h3 className="section-heading">Watched Target Wallets</h3>
          <p className="section-subheading">
            Signals emitted by these addresses trigger real-time evaluation and copy-trade execution.
          </p>
        </div>

        <button
          type="button"
          className="btn-add-wallet"
          onClick={() => setIsAddModalOpen(true)}
        >
          <Plus size={14} />
          <span>Add Target Wallet</span>
        </button>
      </div>

      <div className="table-responsive-wrapper">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Label & Alias</th>
              <th>Solana Public Key</th>
              <th>Sizing Strategy</th>
              <th>Fixed Buy Size</th>
              <th>Copy Ratio</th>
              <th>Max Cap per Trade</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {wallets.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title="No Watched Wallets Registered"
                    description={
                      isLoading
                        ? 'Loading wallets...'
                        : 'Register a target trader wallet to begin copying.'
                    }
                    action={
                      <button
                        type="button"
                        className="btn-submit-primary"
                        onClick={() => setIsAddModalOpen(true)}
                      >
                        <Plus size={14} /> Add Target Wallet
                      </button>
                    }
                  />
                </td>
              </tr>
            ) : (
              wallets.map((w) => {
                const fixedSol = Number(w.fixedBuyLamports || '100000000') / 1e9;
                const maxSol = Number(w.maxBuyLamports || '1000000000') / 1e9;

                return (
                  <tr key={w.wallet}>
                    {/* Status Toggle */}
                    <td>
                      <button
                        type="button"
                        className={`btn-toggle-switch ${w.enabled ? 'active' : 'inactive'}`}
                        onClick={() => handleToggle(w)}
                        disabled={togglingWallet === w.wallet}
                        title={w.enabled ? 'Click to disable monitoring' : 'Click to enable monitoring'}
                      >
                        <Power size={11} />
                        <span>{w.enabled ? 'ACTIVE' : 'PAUSED'}</span>
                      </button>
                    </td>

                    {/* Label */}
                    <td>
                      <div className="wallet-label-cell">
                        <span className="wallet-label-text">{w.label}</span>
                      </div>
                    </td>

                    {/* Address with Copy & Solscan */}
                    <td>
                      <div className="wallet-address-cell mono">
                        <span>{formatShortAddress(w.wallet, 6, 6)}</span>
                        <CopyButton text={w.wallet} size={11} />
                        <a
                          href={`https://solscan.io/account/${w.wallet}`}
                          target="_blank"
                          rel="noreferrer"
                          className="table-ext-link"
                          title="View on Solscan"
                        >
                          <ExternalLink size={11} />
                        </a>
                      </div>
                    </td>

                    {/* Sizing Strategy */}
                    <td>
                      <Badge variant="neutral" size="sm">
                        {w.buyMode}
                      </Badge>
                    </td>

                    {/* Fixed Buy Size */}
                    <td>
                      <span className="mono font-semibold">{formatSol(fixedSol, 2)}</span>
                    </td>

                    {/* Copy Ratio */}
                    <td>
                      <span className="mono">{(w.copyRatio * 100).toFixed(0)}% of target</span>
                    </td>

                    {/* Max Cap */}
                    <td>
                      <span className="mono text-muted">{formatSol(maxSol, 2)}</span>
                    </td>

                    {/* Explorer Action */}
                    <td style={{ textAlign: 'right' }}>
                      <a
                        href={`https://solscan.io/account/${w.wallet}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-table-icon-link"
                      >
                        <span>Explorer</span>
                        <ExternalLink size={11} />
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <AddWalletModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={onRefresh}
      />
    </div>
  );
};
