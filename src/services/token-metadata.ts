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
      const res = await fetch(url, { headers: { 'User-Agent': 'SolanaCopyBot/1.0' } });
      if (!res.ok) return this.createFallback(mint);

      const data = (await res.json()) as any;
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      // Prefer native SOL quote pair if available
      const pair = pairs.find((p: any) =>
        p.quoteToken?.address === 'So11111111111111111111111111111111111111112' ||
        p.quoteToken?.symbol?.toUpperCase() === 'SOL'
      ) || pairs[0];

      if (pair) {
        const quoteSymbol = pair.quoteToken?.symbol?.toUpperCase();
        const priceUsd = parseFloat(pair.priceUsd || '0');
        let priceSol = 0;

        if (quoteSymbol === 'SOL' || pair.quoteToken?.address === 'So11111111111111111111111111111111111111112') {
          priceSol = parseFloat(pair.priceNative || '0');
        } else {
          // If paired with USDC/USD, compute priceSol from priceUsd / currentSolPriceUsd
          const solPriceUsd = await this.getSolPriceUsd();
          priceSol = priceUsd > 0 && solPriceUsd > 0 ? priceUsd / solPriceUsd : 0;
        }

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

      return this.createFallback(mint);
    } catch (err) {
      return this.createFallback(mint);
    }
  }

  private createFallback(mint: string): TokenMetadata {
    return {
      mint,
      name: `Token ${mint.substring(0, 4)}...${mint.substring(mint.length - 4)}`,
      symbol: mint.substring(0, 4).toUpperCase(),
      priceUsd: 0,
      fdvUsd: 0,
      liquidityUsd: 0,
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
