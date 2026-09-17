import { ExternalLink, LogOut, ShieldAlert, Wallet } from 'lucide-react';
import React from 'react';
import { useSolanaWallet } from '../../hooks/useSolanaWallet';
import { Badge } from '../common/Badge';
import { CopyButton } from '../common/CopyButton';
import { StatusDot } from '../common/StatusDot';

export const WalletInfoCard: React.FC = () => {
  const wallet = useSolanaWallet();

  return (
    <div className="wallet-info-card">
      <div className="wic-header">
        <div className="wic-header-left">
          <div className="wic-icon-box">
            <Wallet size={16} color="#14f195" />
          </div>
          <div>
            <div className="wic-title-row">
              <span className="wic-title">DASHBOARD BROWSER WALLET</span>
              <span className="card-tag tag-readonly">READ-ONLY IDENTITY</span>
            </div>
            <p className="wic-sub">Connected browser wallet for account visibility & balances</p>
          </div>
        </div>

        <div className="wic-header-right">
          <Badge variant={wallet.isConnected ? 'live' : 'default'} size="sm">
            <StatusDot status={wallet.isConnected ? 'online' : 'offline'} size={6} />
            <span style={{ marginLeft: 4 }}>
              {wallet.isConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </Badge>
        </div>
      </div>

      <div className="wic-grid">
        {/* Connection Status */}
        <div className="wic-item">
          <span className="wic-label">STATUS</span>
          <span className="wic-value mono font-semibold">
            {wallet.isConnected ? 'Active Connection' : 'Disconnected'}
          </span>
          <span className="wic-hint">
            {wallet.isConnected ? 'Verified Solana namespace' : 'Click topbar to connect'}
          </span>
        </div>

        {/* Public Address */}
        <div className="wic-item">
          <span className="wic-label">ADDRESS</span>
          <div className="wic-addr-row">
            <span className="wic-value mono font-semibold">
              {wallet.shortAddress || '—'}
            </span>
            {wallet.address && <CopyButton text={wallet.address} size={11} />}
            {wallet.address && (
              <a
                href={`https://solscan.io/account/${wallet.address}`}
                target="_blank"
                rel="noreferrer"
                className="tf-link"
                title="View on Solscan"
              >
                <ExternalLink size={11} />
              </a>
            )}
          </div>
          <span className="wic-hint">Browser public key</span>
        </div>

        {/* Network */}
        <div className="wic-item">
          <span className="wic-label">NETWORK</span>
          <span className="wic-value mono font-semibold text-cyan">
            {wallet.network}
          </span>
          <span className="wic-hint">Genesis 5eykt4Us...</span>
        </div>

        {/* SOL Balance */}
        <div className="wic-item">
          <span className="wic-label">SOL BALANCE</span>
          <span className="wic-value mono font-semibold highlight-green">
            {wallet.balanceFormatted}
          </span>
          <span className="wic-hint">RPC verified balance</span>
        </div>

        {/* Wallet Provider */}
        <div className="wic-item">
          <span className="wic-label">PROVIDER</span>
          <span className="wic-value font-semibold">
            {wallet.isConnected ? wallet.walletName : '—'}
          </span>
          <span className="wic-hint">AppKit connector</span>
        </div>

        {/* Role Separation Notice */}
        <div className="wic-item wic-role-notice">
          <span className="wic-label">ROLE SEPARATION</span>
          <span className="wic-value font-semibold text-muted" style={{ fontSize: '11px' }}>
            UI Identity Only
          </span>
          <span className="wic-hint">Independent of bot trading hot wallet</span>
        </div>
      </div>

      {wallet.isConnected ? (
        <div className="wic-footer">
          <button
            type="button"
            className="btn-wic-action"
            onClick={() => wallet.openWalletModal()}
          >
            Switch Wallet
          </button>
          <button
            type="button"
            className="btn-wic-disconnect"
            onClick={() => wallet.disconnect()}
          >
            <LogOut size={12} />
            <span>Disconnect</span>
          </button>
        </div>
      ) : (
        <div className="wic-footer">
          <button
            type="button"
            className="btn-wic-connect"
            onClick={() => wallet.openWalletModal()}
          >
            Connect Dashboard Wallet
          </button>
        </div>
      )}
    </div>
  );
};
