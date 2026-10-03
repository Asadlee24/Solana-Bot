import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config/index.js';
import { OnChainBondingCurveState, PUMP_PROGRAM_ID, pumpFunSwapAdapter } from '../execution/pump-fun-swap.js';
import { ParsedTransactionEnvelope } from '../parsers/fast-decoder.js';

interface CachedCurveEntry {
  state: OnChainBondingCurveState;
  updatedAt: number;
  slot: number;
  source: 'STREAM_DEDUCTION' | 'RPC_READ';
}

export class CurveStateCache {
  private static instance: CurveStateCache;
  private cache: Map<string, CachedCurveEntry> = new Map();
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'processed',
    });
  }

  public static getInstance(): CurveStateCache {
    if (!CurveStateCache.instance) {
      CurveStateCache.instance = new CurveStateCache();
    }
    return CurveStateCache.instance;
  }

  /**
   * Resolves bonding curve state using strict priority:
   * 1. Target transaction balance deduction (if pre/post balances available)
   * 2. Updating verified cached state with observed target trade amounts
   * 3. Single optimized RPC read
   */
  public async resolveState(
    mintAddress: string,
    targetEnvelope?: ParsedTransactionEnvelope,
    targetSpendLamports?: bigint,
    targetTokensRaw?: bigint
  ): Promise<{ state: OnChainBondingCurveState | null; source: 'STREAM' | 'CACHE' | 'RPC'; fallbackRequired: boolean }> {
    const now = Date.now();
    const cached = this.cache.get(mintAddress);
    const ttlMs = config.FAST_CURVE_CACHE_TTL_MS || 3000;

    // 1. Priority 1 & 2: Update cached state using observed target transaction effects
    if (cached && now - cached.updatedAt <= ttlMs && targetSpendLamports && targetTokensRaw) {
      const oldState = cached.state;
      // Deduce new state after target's buy
      const updatedVirtualToken =
        oldState.virtualTokenReserves > targetTokensRaw
          ? oldState.virtualTokenReserves - targetTokensRaw
          : oldState.virtualTokenReserves;
      const updatedVirtualSol = oldState.virtualSolReserves + targetSpendLamports;
      const updatedRealToken =
        oldState.realTokenReserves > targetTokensRaw
          ? oldState.realTokenReserves - targetTokensRaw
          : 0n;
      const updatedRealSol = oldState.realSolReserves + targetSpendLamports;

      const deducedState: OnChainBondingCurveState = {
        ...oldState,
        virtualTokenReserves: updatedVirtualToken,
        virtualSolReserves: updatedVirtualSol,
        realTokenReserves: updatedRealToken,
        realSolReserves: updatedRealSol,
      };

      this.cache.set(mintAddress, {
        state: deducedState,
        updatedAt: now,
        slot: targetEnvelope?.slot || cached.slot,
        source: 'STREAM_DEDUCTION',
      });

      return {
        state: deducedState,
        source: 'STREAM',
        fallbackRequired: deducedState.complete || !deducedState.isInitialized,
      };
    }

    // 2. Fresh cached state without target adjustment
    if (cached && now - cached.updatedAt <= ttlMs) {
      return {
        state: cached.state,
        source: 'CACHE',
        fallbackRequired: cached.state.complete || !cached.state.isInitialized,
      };
    }

    // 3. Priority 3: Perform optimized on-chain RPC read
    try {
      const state = await pumpFunSwapAdapter.getBondingCurveState(mintAddress);
      if (state) {
        this.cache.set(mintAddress, {
          state,
          updatedAt: now,
          slot: targetEnvelope?.slot || 0,
          source: 'RPC_READ',
        });
        return {
          state,
          source: 'RPC',
          fallbackRequired: state.complete || !state.isInitialized,
        };
      }
    } catch (err: any) {
      console.warn(`[CurveStateCache] RPC fetch failed for ${mintAddress}:`, err.message || err);
    }

    // Cannot verify state safely -> signal fallback
    return {
      state: null,
      source: 'RPC',
      fallbackRequired: true,
    };
  }

  /**
   * Directly registers/caches a verified curve state (used during test & warmups)
   */
  public registerState(mint: string, state: OnChainBondingCurveState, slot: number = 0): void {
    this.cache.set(mint, {
      state,
      updatedAt: Date.now(),
      slot,
      source: 'RPC_READ',
    });
  }

  public async getOrFetchCurveState(
    mintAddress: string,
    targetEnvelope?: ParsedTransactionEnvelope,
    _conn?: Connection
  ): Promise<{ verified: boolean; state: OnChainBondingCurveState | null; reason?: string }> {
    const res = await this.resolveState(mintAddress, targetEnvelope);
    if (res.fallbackRequired || !res.state) {
      return { verified: false, state: null, reason: 'Curve complete or uninitialized' };
    }
    return { verified: true, state: res.state };
  }

  public calculateTokensOut(
    state: OnChainBondingCurveState,
    solAmountLamports: bigint
  ): bigint {
    if (solAmountLamports <= 0n || state.virtualSolReserves <= 0n) return 0n;
    const k = state.virtualSolReserves * state.virtualTokenReserves;
    const newSol = state.virtualSolReserves + solAmountLamports;
    const newToken = k / newSol;
    return state.virtualTokenReserves - newToken;
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const curveStateCache = CurveStateCache.getInstance();
