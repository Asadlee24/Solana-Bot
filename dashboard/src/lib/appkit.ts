import { solana } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';

// Read Reown Project ID from environment (public client identifier)
const rawProjectId = import.meta.env.VITE_REOWN_PROJECT_ID;
export const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';

// Guard: Project ID must be provided to initialize AppKit cloud services
export const isAppKitAvailable = Boolean(projectId && projectId.length > 0);

// Initialize native Solana Adapter (zero EVM / wagmi dependencies)
export const solanaAdapter = new SolanaAdapter();

const origin = typeof window !== 'undefined' ? window.location.origin : 'https://solana-copy-engine.com';

export const appKitMetadata = {
  name: 'Solana Copy Engine',
  description: 'Low-Latency Mirror Trading Console',
  url: origin,
  icons: [`${origin}/favicon.ico`],
};

// Global AppKit instance - initialized only if project ID is configured
export let appKitModal: any = null;

if (isAppKitAvailable) {
  try {
    appKitModal = createAppKit({
      adapters: [solanaAdapter],
      networks: [solana],
      defaultNetwork: solana,
      metadata: appKitMetadata,
      projectId,
      themeMode: 'dark',
      themeVariables: {
        '--w3m-accent': '#14f195',
        '--w3m-color-mix': '#0b0e17',
        '--w3m-border-radius-master': '8px',
        '--w3m-font-family': 'JetBrains Mono, ui-monospace, monospace',
      },
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      },
      allWallets: 'SHOW',
    });
  } catch (err) {
    console.warn('[AppKit] Failed to initialize AppKit modal:', err);
    appKitModal = null;
  }
}
