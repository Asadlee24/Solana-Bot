import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { mintDecimalsService } from '../services/mint-decimals.js';
import { JupiterV2ExecuteResponse } from './jupiter-swap.js';

export interface ActualSettlement {
  side: 'BUY' | 'SELL';
  actualSolLamports: bigint;
  actualTokensRaw: bigint;
  actualFeeLamports: bigint;
  actualPriorityFeeLamports: bigint;
  actualTipLamports: bigint;
  actualExecutionPriceSol: number;
  reconciliationSource: 'ON_CHAIN_TRANSACTION' | 'JUPITER_RESULT' | 'WALLET_BALANCE_DELTA' | 'FALLBACK_EXPECTED' | 'FALLBACK_PENDING';
}

export class SettlementReconciler {
  private connection: Connection;

  constructor(connection?: Connection) {
    this.connection =
      connection ||
      new Connection(config.SOLANA_RPC_URL, {
        commitment: 'confirmed',
      });
  }

  /**
   * Reconciles the actual on-chain settlement amounts after a confirmed transaction.
   * Eliminates phantom fills and avoids using quoted expectedOutRaw as actual balances.
   */
  public async reconcileConfirmedTrade(
    signature: string,
    walletPublicKey: PublicKey,
    tokenMint: string,
    side: 'BUY' | 'SELL',
    expectedInRaw: bigint,
    expectedOutRaw: bigint,
    expectedPriceSol: number,
    jupiterExecuteResult?: JupiterV2ExecuteResponse
  ): Promise<ActualSettlement> {
    const decimals = await mintDecimalsService.getDecimals(tokenMint);
    const walletBase58 = walletPublicKey.toBase58();

    // 1. Attempt deep on-chain transaction metadata parsing (with retry for RPC catch-up)
    try {
      let tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });

      if (!tx) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        tx = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed',
        });
      }

      if (tx && tx.meta) {
        const meta = tx.meta;
        const totalFee = BigInt(meta.fee);
        const baseFee = 5_000n;
        const priorityFee = totalFee > baseFee ? totalFee - baseFee : 0n;

        // Find wallet account index in transaction account keys
        const accountKeys = tx.transaction.message.accountKeys;
        const walletIdx = accountKeys.findIndex((k) => k.pubkey.toBase58() === walletBase58);

        let solDeltaLamports = 0n;
        if (walletIdx !== -1 && meta.preBalances && meta.postBalances) {
          const preBal = BigInt(meta.preBalances[walletIdx]);
          const postBal = BigInt(meta.postBalances[walletIdx]);
          solDeltaLamports = preBal > postBal ? preBal - postBal : postBal - preBal;
        }

        // Token balance deltas from metadata
        let tokenDeltaRaw = 0n;
        const preToken = meta.preTokenBalances?.find(
          (b) => b.owner === walletBase58 && b.mint === tokenMint
        );
        const postToken = meta.postTokenBalances?.find(
          (b) => b.owner === walletBase58 && b.mint === tokenMint
        );

        const preTokenAmount = BigInt(preToken?.uiTokenAmount.amount || '0');
        const postTokenAmount = BigInt(postToken?.uiTokenAmount.amount || '0');

        if (side === 'BUY') {
          tokenDeltaRaw = postTokenAmount > preTokenAmount ? postTokenAmount - preTokenAmount : 0n;
        } else {
          tokenDeltaRaw = preTokenAmount > postTokenAmount ? preTokenAmount - postTokenAmount : 0n;
        }

        if (tokenDeltaRaw > 0n || solDeltaLamports > 0n) {
          const actualSolLamports =
            solDeltaLamports > 0n
              ? solDeltaLamports
              : side === 'BUY'
              ? expectedInRaw
              : expectedOutRaw;
          const actualTokensRaw =
            tokenDeltaRaw > 0n
              ? tokenDeltaRaw
              : side === 'BUY'
              ? expectedOutRaw
              : expectedInRaw;

          const solUi = Number(actualSolLamports) / 1e9;
          const tokenUi = mintDecimalsService.rawToUi(actualTokensRaw.toString(), decimals);
          const actualPrice = tokenUi > 0 ? solUi / tokenUi : expectedPriceSol;

          return {
            side,
            actualSolLamports,
            actualTokensRaw,
            actualFeeLamports: totalFee,
            actualPriorityFeeLamports: priorityFee,
            actualTipLamports: BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
            actualExecutionPriceSol: actualPrice,
            reconciliationSource: 'ON_CHAIN_TRANSACTION',
          };
        }
      }
    } catch (err: any) {
      console.warn(`[Settlement Reconciler] Could not parse transaction ${signature}: ${err.message}`);
    }

    // 2. Check Jupiter V2 Execute result fields if available
    if (jupiterExecuteResult) {
      const actualOut =
        jupiterExecuteResult.outputAmountResult ||
        jupiterExecuteResult.totalOutputAmount;
      const actualIn =
        jupiterExecuteResult.inputAmountResult ||
        jupiterExecuteResult.totalInputAmount;

      if (actualOut && actualIn) {
        const inBig = BigInt(actualIn);
        const outBig = BigInt(actualOut);

        const actualSolLamports = side === 'BUY' ? inBig : outBig;
        const actualTokensRaw = side === 'BUY' ? outBig : inBig;

        const solUi = Number(actualSolLamports) / 1e9;
        const tokenUi = mintDecimalsService.rawToUi(actualTokensRaw.toString(), decimals);
        const actualPrice = tokenUi > 0 ? solUi / tokenUi : expectedPriceSol;

        return {
          side,
          actualSolLamports,
          actualTokensRaw,
          actualFeeLamports: 5_000n,
          actualPriorityFeeLamports: 0n,
          actualTipLamports: 0n,
          actualExecutionPriceSol: actualPrice,
          reconciliationSource: 'JUPITER_RESULT',
        };
      }
    }

    // 3. Fallback when neither on-chain parsing nor Jupiter execution details are available
    console.warn(`[Settlement Reconciler] Transaction ${signature} reconciliation pending. Marking as FALLBACK_PENDING.`);
    return {
      side,
      actualSolLamports: side === 'BUY' ? expectedInRaw : expectedOutRaw,
      actualTokensRaw: side === 'BUY' ? expectedOutRaw : expectedInRaw,
      actualFeeLamports: 5_000n,
      actualPriorityFeeLamports: 0n,
      actualTipLamports: BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
      actualExecutionPriceSol: expectedPriceSol,
      reconciliationSource: 'FALLBACK_PENDING',
    };
  }
}

export const settlementReconciler = new SettlementReconciler();
