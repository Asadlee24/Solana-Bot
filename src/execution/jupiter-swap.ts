import {
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config/index.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: any;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
}

export interface JupiterSwapBuildResult {
  transaction: VersionedTransaction;
  quote: JupiterQuoteResponse;
  outAmountRaw: string;
  effectivePriceSol: number;
}

export class JupiterSwapAdapter {
  private apiBase: string;

  constructor(apiBase: string = 'https://quote-api.jup.ag/v6') {
    this.apiBase = apiBase;
  }

  /**
   * Fetches executable quote from official Jupiter Swap v6 API.
   */
  public async getQuote(
    inputMint: string,
    outputMint: string,
    amountRaw: string,
    slippageBps: number = config.MAX_SLIPPAGE_BPS
  ): Promise<JupiterQuoteResponse> {
    const url = `${this.apiBase}/quote?inputMint=${encodeURIComponent(
      inputMint
    )}&outputMint=${encodeURIComponent(
      outputMint
    )}&amount=${encodeURIComponent(
      amountRaw
    )}&slippageBps=${encodeURIComponent(slippageBps)}&restrictIntermediateTokens=true`;

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Jupiter quote failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as JupiterQuoteResponse;
    if (!data.outAmount || data.outAmount === '0') {
      throw new Error(`Jupiter returned empty outAmount for quote: ${JSON.stringify(data)}`);
    }

    return data;
  }

  /**
   * Builds and signs a VersionedTransaction via Jupiter v6 swap endpoint.
   */
  public async buildAndSignSwap(
    keypair: Keypair,
    quoteResponse: JupiterQuoteResponse
  ): Promise<JupiterSwapBuildResult> {
    const url = `${this.apiBase}/swap`;
    const userPublicKey = keypair.publicKey.toBase58();

    const payload = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: config.PRIORITY_FEE_MICRO_LAMPORTS,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Jupiter build swap failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    if (!data || !data.swapTransaction) {
      throw new Error(`Jupiter did not return swapTransaction in response: ${JSON.stringify(data)}`);
    }

    // Deserialize VersionedTransaction from Base64
    const txBuffer = Buffer.from(data.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // Cryptographically sign with follower hot wallet
    transaction.sign([keypair]);

    // Calculate effective price in SOL per token
    const isBuy = quoteResponse.inputMint === WSOL_MINT;
    let effectivePriceSol = 0;

    if (isBuy) {
      const solSpent = Number(quoteResponse.inAmount) / 1e9;
      const tokensReceived = Number(quoteResponse.outAmount) / 1e6;
      effectivePriceSol = tokensReceived > 0 ? solSpent / tokensReceived : 0;
    } else {
      const tokensSold = Number(quoteResponse.inAmount) / 1e6;
      const solReceived = Number(quoteResponse.outAmount) / 1e9;
      effectivePriceSol = tokensSold > 0 ? solReceived / tokensSold : 0;
    }

    return {
      transaction,
      quote: quoteResponse,
      outAmountRaw: quoteResponse.outAmount,
      effectivePriceSol,
    };
  }
}

export const jupiterSwapAdapter = new JupiterSwapAdapter();
