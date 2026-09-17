import { useAppKit, useAppKitAccount, useAppKitNetwork, useDisconnect, useWalletInfo } from '@reown/appkit/react';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { formatShortAddress } from '../lib/format';
import { isAppKitAvailable } from '../lib/appkit';

export interface SolanaWalletState {
  isConnected: boolean;
  address: string | null;
  shortAddress: string | null;
  balanceSol: number | null;
  balanceFormatted: string;
  network: string;
  walletName: string;
  walletIcon: string | null;
  isConnecting: boolean;
  isAvailable: boolean;
  error: string | null;
  disconnect: () => Promise<void>;
  openWalletModal: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

export function useSolanaWallet(): SolanaWalletState {
  // AppKit React hooks
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount();
  const { caipNetwork } = useAppKitNetwork();
  const { disconnect: appKitDisconnect } = useDisconnect();
  const { walletInfo } = useWalletInfo('solana');

  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceStatus, setBalanceStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [walletError, setWalletError] = useState<string | null>(null);

  // Derive network name
  const networkName = caipNetwork?.name || 'Solana Mainnet';

  // Derive wallet provider name and icon
  const walletName = walletInfo?.name || 'Solana Wallet';
  const walletIcon = walletInfo?.icon || null;

  // Real-time balance fetcher using native @solana/web3.js
  const fetchSolBalance = useCallback(async (walletAddress: string) => {
    try {
      setBalanceStatus('loading');
      setWalletError(null);

      const rpcEndpoint = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const connection = new Connection(rpcEndpoint, 'confirmed');

      const pubKey = new PublicKey(walletAddress);
      const lamports = await connection.getBalance(pubKey);
      const sol = lamports / LAMPORTS_PER_SOL;

      setBalanceSol(sol);
      setBalanceStatus('success');
    } catch (err: any) {
      console.warn('[Wallet] Balance fetch failed:', err?.message || err);
      setBalanceStatus('error');
      setWalletError('RPC balance check failed');
    }
  }, []);

  // Fetch balance upon connecting or address change
  useEffect(() => {
    if (isConnected && address) {
      fetchSolBalance(address);
    } else {
      setBalanceSol(null);
      setBalanceStatus('idle');
    }
  }, [isConnected, address, fetchSolBalance]);

  const refreshBalance = useCallback(async () => {
    if (address) {
      await fetchSolBalance(address);
    }
  }, [address, fetchSolBalance]);

  const openWalletModal = useCallback(async () => {
    if (!isAppKitAvailable) {
      setWalletError('Wallet Connect Unavailable: Please configure VITE_REOWN_PROJECT_ID in .env');
      return;
    }

    try {
      setWalletError(null);
      await open();
    } catch (err: any) {
      console.error('[Wallet] Failed to open wallet modal:', err);
      setWalletError(err?.message || 'Failed to open wallet modal');
    }
  }, [open]);

  const handleDisconnect = useCallback(async () => {
    try {
      await appKitDisconnect();
      setBalanceSol(null);
      setBalanceStatus('idle');
      setWalletError(null);
    } catch (err: any) {
      console.error('[Wallet] Disconnect error:', err);
    }
  }, [appKitDisconnect]);

  // Balance display format string
  const balanceFormatted =
    balanceStatus === 'loading'
      ? '—'
      : balanceStatus === 'error'
      ? 'Unavailable'
      : balanceSol !== null
      ? `${balanceSol.toFixed(3)} SOL`
      : '—';

  return {
    isConnected: Boolean(isConnected && address),
    address: address || null,
    shortAddress: address ? formatShortAddress(address, 4, 4) : null,
    balanceSol,
    balanceFormatted,
    network: networkName,
    walletName,
    walletIcon,
    isConnecting: status === 'connecting' || status === 'reconnecting',
    isAvailable: isAppKitAvailable,
    error: walletError,
    disconnect: handleDisconnect,
    openWalletModal,
    refreshBalance,
  };
}
