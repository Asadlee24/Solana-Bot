import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { mintDecimalsService } from './mint-decimals.js';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  priceSol?: number;
  fdvUsd: number;
  liquidityUsd: number;
  dexScreenerUrl: string;
  pumpFunUrl: string;
  solscanUrl: string;
  imageUrl?: string;
  updatedAt: number;
}

export class TokenMetadataService {
  private cache: Map<string, TokenMetadata> = new Map();
  private pendingRequests: Map<string, Promise<TokenMetadata | null>> = new Map();
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  /**
   * Resolve rich token metadata from DexScreener or fallback
   */
  public async getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
    if (!mint || mint === 'UNKNOWN' || mint.length < 30) {
      return null;
    }

    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.updatedAt < 2500) {
      // 2.5 second cache for sub-second responsive real-time PnL & charts
      return cached;
    }

    if (this.pendingRequests.has(mint)) {
      return this.pendingRequests.get(mint)!;
    }

    const promise = this.fetchFromDexScreener(mint);
    this.pendingRequests.set(mint, promise);

    try {
      const result = await promise;
      if (result) {
        this.cache.set(mint, result);
      }
      return result;
    } finally {
      this.pendingRequests.delete(mint);
    }
  }

  private async fetchFromDexScreener(mint: string): Promise<TokenMetadata | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'SolanaCopyBot/1.0' }, signal: AbortSignal.timeout(3500) });
      if (!res.ok) return await this.resolveFallbackMetadata(mint);

      const data = (await res.json()) as any;
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      // Prefer native SOL quote pair if available
      const pair = pairs.find((p: any) =>
        p.quoteToken?.address === WSOL_MINT ||
        p.quoteToken?.symbol?.toUpperCase() === 'SOL'
      ) || pairs[0];

      if (pair) {
        const quoteSymbol = pair.quoteToken?.symbol?.toUpperCase();
        const priceUsd = parseFloat(pair.priceUsd || '0');
        let priceSol = 0;

        if (quoteSymbol === 'SOL' || pair.quoteToken?.address === WSOL_MINT) {
          priceSol = parseFloat(pair.priceNative || '0');
        } else {
          // If paired with USDC/USD, compute priceSol from priceUsd / currentSolPriceUsd
          const solPriceUsd = await this.getSolPriceUsd();
          priceSol = priceUsd > 0 && solPriceUsd > 0 ? priceUsd / solPriceUsd : 0;
        }

        if (priceSol > 0) {
          return {
            mint,
            name: pair.baseToken?.name || 'Unknown Token',
            symbol: pair.baseToken?.symbol || 'TOKEN',
            priceUsd,
            priceSol,
            fdvUsd: pair.fdv || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            dexScreenerUrl: pair.url || `https://dexscreener.com/solana/${mint}`,
            pumpFunUrl: `https://pump.fun/${mint}`,
            solscanUrl: `https://solscan.io/token/${mint}`,
            imageUrl: pair.info?.imageUrl,
            updatedAt: Date.now(),
          };
        }
      }

      return await this.resolveFallbackMetadata(mint, pair);
    } catch (err) {
      return await this.resolveFallbackMetadata(mint);
    }
  }

  /**
   * Resilient fallback price resolver:
   * When DexScreener has not indexed a token (e.g. brand new Pump.fun or Raydium LaunchLab token),
   * queries Jupiter Swap API V2 quote (/order) or on-chain Pump.fun bonding curve.
   */
  private async resolveFallbackMetadata(mint: string, existingPair?: any): Promise<TokenMetadata> {
    const solPriceUsd = await this.getSolPriceUsd();
    let priceSol = 0;
    let priceUsd = 0;
    let liquidityUsd = 0;

    // 1. Try Jupiter Swap API V2 Order Quote
    try {
      const decimals = await mintDecimalsService.getDecimals(mint);
      const sampleTokens = 1000;
      const sampleAmountRaw = (BigInt(sampleTokens) * BigInt(10 ** decimals)).toString();
      const jupUrl = `https://api.jup.ag/swap/v2/order?inputMint=${mint}&outputMint=${WSOL_MINT}&amount=${sampleAmountRaw}&slippageBps=200`;
      const res = await fetch(jupUrl, {
        headers: config.JUPITER_API_KEY ? { 'x-api-key': config.JUPITER_API_KEY.trim() } : undefined,
        signal: AbortSignal.timeout(3500),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.outAmount && BigInt(data.outAmount) > 0n) {
          const outSol = Number(data.outAmount) / 1e9;
          priceSol = outSol / sampleTokens;
          priceUsd = priceSol * solPriceUsd;
          liquidityUsd = 10000;
        }
      }
    } catch {}

    // 2. If Jupiter did not resolve price, check on-chain Pump.fun bonding curve
    if (priceSol <= 0) {
      try {
        const mintPubkey = new PublicKey(mint);
        const [curve] = PublicKey.findProgramAddressSync(
          [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
          PUMP_PROGRAM_ID
        );
        const acc = await this.connection.getAccountInfo(curve, 'confirmed');
        if (acc && acc.data.length >= 49) {
          const complete = acc.data.readUInt8(48) === 1;
          if (!complete) {
            const vTokens = acc.data.readBigUInt64LE(8);
            const vSol = acc.data.readBigUInt64LE(16);
            if (vTokens > 0n && vSol > 0n) {
              priceSol = (Number(vSol) / 1e9) / (Number(vTokens) / 1e6);
              priceUsd = priceSol * solPriceUsd;
              liquidityUsd = (Number(acc.data.readBigUInt64LE(32)) / 1e9) * solPriceUsd;
            }
          }
        }
      } catch {}
    }

    const shortMint = `${mint.substring(0, 4)}...${mint.substring(mint.length - 4)}`;
    const name = existingPair?.baseToken?.name || `Token ${shortMint}`;
    const symbol = existingPair?.baseToken?.symbol || mint.substring(0, 4).toUpperCase();

    return {
      mint,
      name,
      symbol,
      priceUsd,
      priceSol: priceSol > 0 ? priceSol : undefined,
      fdvUsd: priceSol > 0 ? priceSol * 1_000_000_000 * solPriceUsd : 0,
      liquidityUsd,
      dexScreenerUrl: `https://dexscreener.com/solana/${mint}`,
      pumpFunUrl: `https://pump.fun/${mint}`,
      solscanUrl: `https://solscan.io/token/${mint}`,
      updatedAt: Date.now(),
    };
  }

  private cachedSolPriceUsd: number = 105.0;
  private lastSolPriceFetchTime: number = 0;

  /**
   * Fetch current real-time SOL/USD price from DexScreener
   */
  public async getSolPriceUsd(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSolPriceFetchTime < 30000 && this.cachedSolPriceUsd > 0) {
      return this.cachedSolPriceUsd;
    }

    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
        headers: { 'User-Agent': 'SolanaCopyBot/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const price = parseFloat(data.pairs?.[0]?.priceUsd || '0');
        if (price > 0) {
          this.cachedSolPriceUsd = price;
          this.lastSolPriceFetchTime = now;
        }
      }
    } catch {}

    return this.cachedSolPriceUsd;
  }
}

export const tokenMetadataService = new TokenMetadataService();
