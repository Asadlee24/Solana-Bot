import {
  BlockhashWithExpiryBlockHeight,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config/index.js';
import { mintDecimalsService } from '../services/mint-decimals.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterV2OrderResponse {
  requestId: string;
  transaction: string; // Base64 unsigned assembled VersionedTransaction
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  otherAmountThreshold?: string;
  slippageBps: number;
  priceImpactPct?: string;
  lastValidBlockHeight?: number;
}

export interface JupiterV2ExecuteResponse {
  status: string; // 'Success' | 'Failed' | 'Pending'
  signature?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

export interface JupiterV2OrderBuildResult {
  transaction: VersionedTransaction;
  order: JupiterV2OrderResponse;
  outAmountRaw: string;
  effectivePriceSol: number;
  blockhashWithExpiry: BlockhashWithExpiryBlockHeight;
}

export class JupiterSwapV2Adapter {
  private apiBase: string;

  constructor(apiBase: string = 'https://api.jup.ag/swap/v2') {
    this.apiBase = apiBase;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.JUPITER_API_KEY) {
      headers['x-api-key'] = config.JUPITER_API_KEY.trim();
    }
    return headers;
  }

  /**
   * Fetches assembled swap transaction from Jupiter Swap API V2 (/order)
   */
  public async createOrder(
    inputMint: string,
    outputMint: string,
    amountRaw: string,
    takerAddress: string,
    slippageBps: number = config.MAX_SLIPPAGE_BPS
  ): Promise<JupiterV2OrderResponse> {
    const maxAttempts = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const useDirect = attempt === 1; // Attempt 1: ultra-fast direct route (<1000ms)
        const params = new URLSearchParams({
          inputMint,
          outputMint,
          amount: amountRaw,
          taker: takerAddress,
          slippageBps: slippageBps.toString(),
        });
        if (useDirect) {
          params.set('onlyDirectRoutes', 'true');
        }

        const url = `${this.apiBase}/order?${params.toString()}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 400 && attempt < maxAttempts) {
            console.warn(`[Jupiter Swap API V2] Attempt ${attempt}/${maxAttempts} (${useDirect ? 'direct' : 'multi-hop'}): "${errText.slice(0, 80)}". Retrying...`);
            await new Promise((r) => setTimeout(r, attempt * 1000));
            continue;
          }
          throw new Error(`Jupiter Swap API V2 order failed (${res.status}): ${errText}`);
        }

        const data = (await res.json()) as any;
        if (data?.errorMessage || data?.error) {
          throw new Error(`Jupiter Swap API error: ${data.errorMessage || data.error}`);
        }
        if (!data || (!data.transaction && !data.swapTransaction)) {
          const codeMsg = data?.errorCode ? ` (code: ${data.errorCode})` : '';
          throw new Error(`Jupiter Swap API: no executable transaction returned${codeMsg}`);
        }

        return {
          requestId: data.requestId || '',
          transaction: data.transaction || data.swapTransaction,
          inputMint: data.inputMint || inputMint,
          outputMint: data.outputMint || outputMint,
          inAmount: data.inAmount || amountRaw,
          outAmount: data.outAmount || '0',
          totalInputAmount: data.totalInputAmount,
          totalOutputAmount: data.totalOutputAmount,
          otherAmountThreshold: data.otherAmountThreshold,
          slippageBps: data.slippageBps || slippageBps,
          priceImpactPct: data.priceImpactPct,
          lastValidBlockHeight: data.lastValidBlockHeight,
        };
      } catch (err: any) {
        lastError = err;
        if (attempt < maxAttempts && err.message.includes('Failed to get quotes')) {
          console.warn(`[Jupiter Swap API V2] Attempt ${attempt}/${maxAttempts} failed: "${err.message}". Retrying...`);
          await new Promise((r) => setTimeout(r, attempt * 1500));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Jupiter Swap API V2 order failed after retries');
  }

  /**
   * Deserializes and signs the returned Jupiter V2 order transaction locally.
   * Dynamically calculates effective price in SOL per token based on actual on-chain mint decimals.
   */
  public async signOrder(
    keypair: Keypair,
    order: JupiterV2OrderResponse
  ): Promise<JupiterV2OrderBuildResult> {
    const txBuffer = Buffer.from(order.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // Sign locally with follower hot wallet
    transaction.sign([keypair]);

    // Resolve exact SPL mint decimals dynamically
    const inputDecimals = await mintDecimalsService.getDecimals(order.inputMint);
    const outputDecimals = await mintDecimalsService.getDecimals(order.outputMint);

    const isBuy = order.inputMint === WSOL_MINT;
    let effectivePriceSol = 0;

    const inAmountUi = mintDecimalsService.rawToUi(order.inAmount, inputDecimals);
    const outAmountUi = mintDecimalsService.rawToUi(order.outAmount, outputDecimals);

    if (isBuy) {
      // In is SOL, Out is Token -> Price = SOL / Token
      effectivePriceSol = outAmountUi > 0 ? inAmountUi / outAmountUi : 0;
    } else {
      // In is Token, Out is SOL -> Price = SOL / Token
      effectivePriceSol = inAmountUi > 0 ? outAmountUi / inAmountUi : 0;
    }

    // Preserve exact blockhash & lastValidBlockHeight from Jupiter's assembled transaction/order
    const recentBlockhash = transaction.message.recentBlockhash;
    const lastValidBlockHeight = order.lastValidBlockHeight || 0;
    const blockhashWithExpiry: BlockhashWithExpiryBlockHeight = {
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    };

    return {
      transaction,
      order,
      outAmountRaw: order.outAmount,
      effectivePriceSol,
      blockhashWithExpiry,
    };
  }

  /**
   * Submits signed transaction to Jupiter Swap API V2 (/execute)
   */
  public async executeOrder(
    signedTx: VersionedTransaction,
    requestId: string,
    lastValidBlockHeight?: number
  ): Promise<JupiterV2ExecuteResponse> {
    const url = `${this.apiBase}/execute`;
    const serializedTx = Buffer.from(signedTx.serialize()).toString('base64');

    const payload: Record<string, any> = {
      signedTransaction: serializedTx,
      requestId,
    };
    if (lastValidBlockHeight) {
      payload.lastValidBlockHeight = lastValidBlockHeight.toString();
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        status: 'Failed',
        error: `Jupiter V2 execute HTTP ${res.status}: ${errText}`,
      };
    }

    const data = (await res.json()) as any;
    return {
      status: data.status || 'Success',
      signature: data.signature,
      totalInputAmount: data.totalInputAmount,
      totalOutputAmount: data.totalOutputAmount,
      inputAmountResult: data.inputAmountResult,
      outputAmountResult: data.outputAmountResult,
      error: data.error,
    };
  }
}

export const jupiterSwapV2Adapter = new JupiterSwapV2Adapter();
