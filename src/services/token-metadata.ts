export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
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
    if (cached && Date.now() - cached.updatedAt < 60000) {
      // 1 minute cache
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
      const pair = data.pairs?.[0];

      if (pair) {
        return {
          mint,
          name: pair.baseToken?.name || 'Unknown Token',
          symbol: pair.baseToken?.symbol || 'TOKEN',
          priceUsd: parseFloat(pair.priceUsd || '0'),
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
}

export const tokenMetadataService = new TokenMetadataService();
