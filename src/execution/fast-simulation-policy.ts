import { config } from '../config/index.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface SimulationPolicyEvaluation {
  shouldSimulate: boolean;
  canBypass: boolean;
  reason: string;
}

export class FastSimulationPolicy {
  public static readonly MAX_BYPASS_SLIPPAGE_BPS = 500; // Max 5% slippage allowed for bypass

  /**
   * Evaluates if a transaction qualifies for fast simulation bypass.
   * 
   * STRICT SAFETY CRITERIA:
   * 1. FAST_COPY_MODE must be true
   * 2. FAST_COPY_SKIP_SIMULATION must be true
   * 3. Venue must be PUMPFUN
   * 4. Side must be BUY
   * 5. Slippage must be bounded (<= 500 bps)
   * 6. Bonding curve state must be verified
   * 7. Accounts must be validated
   * 8. Template must be known deterministic Direct Pump Buy
   * 9. Token program must be standard SPL Token or Token-2022
   */
  public static evaluateBypass(params: {
    venue: string;
    side: string;
    slippageBps: number;
    curveStateVerified: boolean;
    accountsValid: boolean;
    templateKnown: boolean;
    tokenProgramId: string;
  }): SimulationPolicyEvaluation {
    if (!config.FAST_COPY_MODE) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: 'FAST_COPY_MODE is false (normal hardened execution requires simulation)',
      };
    }

    if (!config.FAST_COPY_SKIP_SIMULATION) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: 'FAST_COPY_SKIP_SIMULATION is false',
      };
    }

    if (params.venue !== 'PUMPFUN') {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: `Venue ${params.venue} is not deterministic Pump.fun template`,
      };
    }

    if (params.side !== 'BUY') {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: `Side ${params.side} is not supported for simulation bypass`,
      };
    }

    if (params.slippageBps > this.MAX_BYPASS_SLIPPAGE_BPS) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: `Slippage ${params.slippageBps} bps exceeds max bypass limit (${this.MAX_BYPASS_SLIPPAGE_BPS} bps)`,
      };
    }

    if (!params.curveStateVerified) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: 'Curve state was not verified',
      };
    }

    if (!params.accountsValid) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: 'Account keys failed deterministic validation',
      };
    }

    if (!params.templateKnown) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: 'Transaction template is unknown or ambiguous',
      };
    }

    const tokenProg = params.tokenProgramId;
    const isStandardToken =
      tokenProg === TOKEN_PROGRAM_ID.toBase58() ||
      tokenProg === TOKEN_2022_PROGRAM_ID.toBase58();

    if (!isStandardToken) {
      return {
        shouldSimulate: true,
        canBypass: false,
        reason: `Unsupported token program ${tokenProg} for simulation bypass`,
      };
    }

    return {
      shouldSimulate: false,
      canBypass: true,
      reason: 'Deterministic verified Pump.fun BUY template meets all safety criteria',
    };
  }
}
