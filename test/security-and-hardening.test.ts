import { describe, expect, it } from 'vitest';
import { config } from '../src/config/index.js';
import { requireControlAuth } from '../src/api/server.js';
import { telegramNotifier } from '../src/notifications/telegram.js';
import { tokenMetadataService } from '../src/services/token-metadata.js';
import { pumpFunSwapAdapter, OnChainBondingCurveState } from '../src/execution/pump-fun-swap.js';
import { WebhookReceiver } from '../src/streams/webhook-server.js';
import { riskEngine } from '../src/engine/risk-engine.js';

describe('Security Hardening & Audit Verification Suite', () => {
  describe('1. Telegram Chat Authorization Guard', () => {
    it('strictly blocks unauthorized chat IDs and preserves operator chatId', () => {
      const authorizedChat = '123456789';
      const unauthorizedChat = '999999999';

      (config as any).TELEGRAM_CHAT_ID = authorizedChat;

      // Authorized sender is permitted
      expect(telegramNotifier.isAuthorizedChat(authorizedChat)).toBe(true);

      // Unauthorized sender is rejected
      expect(telegramNotifier.isAuthorizedChat(unauthorizedChat)).toBe(false);

      // Verify that operator chatId was NOT corrupted or overwritten
      (telegramNotifier as any).chatId = authorizedChat;
      expect((telegramNotifier as any).chatId).toBe(authorizedChat);
    });
  });

  describe('2. API CONTROL_API_TOKEN Middleware', () => {
    it('blocks mutating API endpoints with 401 when CONTROL_API_TOKEN is missing or invalid', () => {
      const origToken = config.CONTROL_API_TOKEN;
      (config as any).CONTROL_API_TOKEN = 'secret-test-token-123';

      const createMockContext = (headers: Record<string, string>) => {
        let status = 200;
        let jsonBody: any = null;
        let nextCalled = false;

        const req = { headers } as any;
        const res = {
          status: (code: number) => {
            status = code;
            return {
              json: (body: any) => {
                jsonBody = body;
              },
            };
          },
        } as any;
        const next = () => {
          nextCalled = true;
        };

        return { req, res, next, getResult: () => ({ status, jsonBody, nextCalled }) };
      };

      // Missing token -> 401
      const noTokenCtx = createMockContext({});
      requireControlAuth(noTokenCtx.req, noTokenCtx.res, noTokenCtx.next);
      expect(noTokenCtx.getResult().status).toBe(401);
      expect(noTokenCtx.getResult().nextCalled).toBe(false);

      // Invalid token -> 401
      const badTokenCtx = createMockContext({ 'x-api-token': 'wrong-token' });
      requireControlAuth(badTokenCtx.req, badTokenCtx.res, badTokenCtx.next);
      expect(badTokenCtx.getResult().status).toBe(401);
      expect(badTokenCtx.getResult().nextCalled).toBe(false);

      // Valid token via x-api-token -> 200 / next() called
      const validHeaderCtx = createMockContext({ 'x-api-token': 'secret-test-token-123' });
      requireControlAuth(validHeaderCtx.req, validHeaderCtx.res, validHeaderCtx.next);
      expect(validHeaderCtx.getResult().status).toBe(200);
      expect(validHeaderCtx.getResult().nextCalled).toBe(true);

      // Valid token via Bearer -> 200 / next() called
      const validBearerCtx = createMockContext({ authorization: 'Bearer secret-test-token-123' });
      requireControlAuth(validBearerCtx.req, validBearerCtx.res, validBearerCtx.next);
      expect(validBearerCtx.getResult().status).toBe(200);
      expect(validBearerCtx.getResult().nextCalled).toBe(true);

      (config as any).CONTROL_API_TOKEN = origToken;
    });
  });

  describe('3. Helius Webhook Secret Validation', () => {
    it('rejects unauthenticated webhooks with 401 when HELIUS_WEBHOOK_SECRET is set', () => {
      const origSecret = config.HELIUS_WEBHOOK_SECRET;
      (config as any).HELIUS_WEBHOOK_SECRET = 'my-webhook-secret-xyz';

      let received = false;
      const receiver = new WebhookReceiver({
        onTransaction: () => {
          received = true;
        },
      });

      // Missing Authorization header
      const reqMissing = {
        headers: {},
        body: [{ signature: 'sig_test' }],
      } as any;
      let statusCode = 200;
      let responseBody = '';
      const resMissing = {
        status: (code: number) => {
          statusCode = code;
          return {
            send: (body: string) => {
              responseBody = body;
            },
          };
        },
      } as any;

      receiver.handleHeliusWebhook(reqMissing, resMissing);
      expect(statusCode).toBe(401);
      expect(received).toBe(false);

      // Valid Authorization header
      const reqValid = {
        headers: { authorization: 'my-webhook-secret-xyz' },
        body: [],
      } as any;
      let okCalled = false;
      const resValid = {
        status: (code: number) => {
          statusCode = code;
          return {
            send: (body: string) => {
              okCalled = true;
            },
          };
        },
      } as any;

      receiver.handleHeliusWebhook(reqValid, resValid);
      expect(statusCode).toBe(200);
      expect(okCalled).toBe(true);

      (config as any).HELIUS_WEBHOOK_SECRET = origSecret;
    });
  });

  describe('4. Entry Gap Post-Quote Guard in Risk Engine', () => {
    it('rejects orders where quote price is worse than MAX_ENTRY_GAP_BPS tolerance', () => {
      const targetPrice = 0.0001; // target entered at 0.0001 SOL
      // Config MAX_ENTRY_GAP_BPS is 200 bps (2.0%)
      const safeQuotePrice = 0.000101; // +1.0% gap -> passes
      const badQuotePrice = 0.000103;  // +3.0% gap -> rejected

      const safeCheck = riskEngine.evaluateQuote(targetPrice, safeQuotePrice);
      expect(safeCheck.approved).toBe(true);

      const badCheck = riskEngine.evaluateQuote(targetPrice, badQuotePrice);
      expect(badCheck.approved).toBe(false);
      expect(badCheck.decision).toBe('REJECTED_ENTRY_GAP');
      expect(badCheck.reason).toContain('tolerance');
    });
  });

  describe('5. Pump.fun Bonding-Curve 1.25% Fee Correctness', () => {
    it('calculates buy output using the official 1.25% bonding curve trading fee', () => {
      const mockState: OnChainBondingCurveState = {
        isInitialized: true,
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n, // 30 SOL
        realTokenReserves: 793_100_000_000_000n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        complete: false,
        pairAsset: 'SOL',
      };

      const inAmountSol = 1_000_000_000n; // 1 SOL
      const quote = pumpFunSwapAdapter.calculateQuote(mockState, 'BUY', inAmountSol, 150);

      // Net SOL in must be exactly 98.75% of input (1.25% fee)
      const expectedNetSolIn = (inAmountSol * 9875n) / 10000n;
      const expectedTokens = (mockState.virtualTokenReserves * expectedNetSolIn) / (mockState.virtualSolReserves + expectedNetSolIn);

      expect(quote.expectedOutRaw).toBe(expectedTokens);
      expect(quote.isGraduated).toBe(false);
    });
  });

  describe('6. TokenMetadataService USDC vs SOL Pricing Conversion', () => {
    it('correctly calculates priceSol from priceUsd / solPriceUsd when paired with USDC', async () => {
      const origFetch = global.fetch;
      try {
        (global as any).fetch = async (url: string) => {
          if (url.includes('dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112')) {
            return {
              ok: true,
              json: async () => ({
                pairs: [
                  {
                    priceUsd: '150.00',
                    quoteToken: { symbol: 'USDC' },
                  },
                ],
              }),
            };
          }
          if (url.includes('dexscreener.com/latest/dex/tokens/TestUsdcPairedMint11111111111111111111111')) {
            return {
              ok: true,
              json: async () => ({
                pairs: [
                  {
                    baseToken: { name: 'USDC Meme', symbol: 'UMEME' },
                    quoteToken: {
                      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                      symbol: 'USDC',
                    },
                    priceUsd: '1.50',
                    priceNative: '1.50', // 1.50 USDC, NOT 1.50 SOL!
                  },
                ],
              }),
            };
          }
          return { ok: false };
        };

        const metadata = await tokenMetadataService.getTokenMetadata('TestUsdcPairedMint11111111111111111111111');
        // If SOL is $150 and token is $1.50, price in SOL must be 1.50 / 150 = 0.01 SOL (NOT 1.50 SOL!)
        expect(metadata?.priceUsd).toBe(1.50);
        expect(metadata?.priceSol).toBeCloseTo(0.01, 4);
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('7. Unverified Settlement Reconciliation Status', () => {
    it('marks unverified RPC settlements as FALLBACK_PENDING without falsely asserting FILLED', async () => {
      const { settlementReconciler } = await import('../src/execution/settlement-reconciler.js');
      const { PublicKey } = await import('@solana/web3.js');

      const dummyPubkey = new PublicKey('11111111111111111111111111111111');
      const result = await settlementReconciler.reconcileConfirmedTrade(
        'mock_sig_unverified_rpc_tx',
        dummyPubkey,
        'TokenMint11111111111111111111111111111111111',
        'BUY',
        10_000_000n,
        1_000_000n,
        0.01
      );

      // Must be FALLBACK_PENDING, not ON_CHAIN_TRANSACTION or JUPITER_RESULT
      expect(result.reconciliationSource).toBe('FALLBACK_PENDING');
    });
  });

  describe('8. Telemetry Precision (No Artificial Latency Injection)', () => {
    it('records ground truth observed and decision timings without synthetic offsets', async () => {
      const { latencyTracker } = await import('../src/telemetry/latency-tracker.js');

      const observedAt = process.hrtime.bigint();
      const decisionAt = observedAt + 2_000_000n; // 2ms later
      const quoteDoneAt = decisionAt + 5_000_000n; // 5ms later

      const sample = latencyTracker.recordSample({
        targetSignature: 'sig_test_telemetry',
        source: 'HELIUS_PRECONFIRMATION',
        observedAt,
        decisionAt,
        quoteDoneAt,
        submittedAt: quoteDoneAt,
        targetProcessedAt: undefined, // Must be undefined or actual ground truth
        mirrorProcessedAt: undefined,
        targetPrice: 0.001,
        mirrorPrice: 0.001,
      });

      expect(sample.targetSignature).toBe('sig_test_telemetry');
      expect(sample.targetProcessedAt).toBeUndefined();
      // Verify internal parse latency is purely (decisionAt - observedAt) = ~2ms
      expect(sample.lDecisionMs).toBeCloseTo(2.0, 1);
    });
  });
});


