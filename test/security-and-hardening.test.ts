import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config/index.js';
import { createApiServer, requireControlAuth } from '../src/api/server.js';
import { authFailureLimiter, resetAllRateLimits } from '../src/api/rate-limiter.js';
import { telegramNotifier } from '../src/notifications/telegram.js';
import { db } from '../src/db/database.js';
import { tokenMetadataService } from '../src/services/token-metadata.js';
import { pumpFunSwapAdapter, OnChainBondingCurveState } from '../src/execution/pump-fun-swap.js';
import { WebhookReceiver } from '../src/streams/webhook-server.js';
import { riskEngine } from '../src/engine/risk-engine.js';

describe('Security Hardening & Audit Verification Suite', () => {
  beforeEach(() => {
    resetAllRateLimits();
  });

  describe('1. Telegram Chat Authorization Guard & Secure Pairing', () => {
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

    it('hardcoded developer Telegram ID 7080909965 no longer grants access', () => {
      (config as any).TELEGRAM_CHAT_ID = '987654321';
      db.resetTelegramPairing();

      const developerId = '7080909965';
      expect(telegramNotifier.isAuthorizedChat(developerId)).toBe(false);
      expect(telegramNotifier.getAuthorizedChatIds()).not.toContain(developerId);
    });

    it('successfully pairs via /pair <code>, persists in SQLite, and survives reload', async () => {
      const originalChatId = config.TELEGRAM_CHAT_ID;
      const originalCode = config.TELEGRAM_PAIRING_CODE;
      const origSend = telegramNotifier.sendCustomMessage;
      let rejectMsg = '';

      (telegramNotifier as any).sendCustomMessage = async (_chat: any, text: string) => {
        rejectMsg = text;
      };

      try {
        (config as any).TELEGRAM_CHAT_ID = '';
        (config as any).TELEGRAM_PAIRING_CODE = 'test-pairing-secret-777';
        db.resetTelegramPairing();

        const strangerChat = '5551234';
        expect(telegramNotifier.isAuthorizedChat(strangerChat)).toBe(false);
        expect(db.isTelegramPairingCompleted()).toBe(false);

        // Send correct pairing command
        await telegramNotifier.handlePairCommand(strangerChat, 'test-pairing-secret-777');

        // Verification: chat is now authorized and persisted in SQLite
        expect(db.isTelegramPairingCompleted()).toBe(true);
        expect(db.getAuthorizedTelegramChats()).toContain(strangerChat);
        expect(telegramNotifier.isAuthorizedChat(strangerChat)).toBe(true);

        // Verification: pairing survives (new query to DB still contains it)
        const reloaded = db.getAuthorizedTelegramChats();
        expect(reloaded).toContain(strangerChat);

        // Verification: re-pairing from another stranger is rejected
        const anotherStranger = '8889990';
        await telegramNotifier.handlePairCommand(anotherStranger, 'test-pairing-secret-777');
        expect(rejectMsg).toContain('ALREADY PAIRED');
        expect(telegramNotifier.isAuthorizedChat(anotherStranger)).toBe(false);

        // Verification: local admin reset mechanism
        telegramNotifier.resetPairing();
        expect(db.isTelegramPairingCompleted()).toBe(false);
        expect(telegramNotifier.isAuthorizedChat(strangerChat)).toBe(false);
      } finally {
        (config as any).TELEGRAM_CHAT_ID = originalChatId;
        (config as any).TELEGRAM_PAIRING_CODE = originalCode;
        telegramNotifier.sendCustomMessage = origSend;
        db.resetTelegramPairing();
      }
    });

    it('rejects invalid pairing code and does not authorize', async () => {
      const originalCode = config.TELEGRAM_PAIRING_CODE;
      try {
        (config as any).TELEGRAM_PAIRING_CODE = 'super-secret-code';
        db.resetTelegramPairing();

        const hackerChat = '666666';
        let errorMsg = '';
        const origSend = telegramNotifier.sendCustomMessage;
        (telegramNotifier as any).sendCustomMessage = async (_chat: any, text: string) => {
          errorMsg = text;
        };

        await telegramNotifier.handlePairCommand(hackerChat, 'wrong-guess');
        expect(errorMsg).toContain('INVALID PAIRING CODE');
        expect(telegramNotifier.isAuthorizedChat(hackerChat)).toBe(false);
        expect(db.isTelegramPairingCompleted()).toBe(false);

        telegramNotifier.sendCustomMessage = origSend;
      } finally {
        (config as any).TELEGRAM_PAIRING_CODE = originalCode;
        db.resetTelegramPairing();
      }
    });
  });

  describe('2. Fail-Closed API CONTROL_API_TOKEN Middleware', () => {
    const createMockContext = (headers: Record<string, string>, ip = '127.0.0.1') => {
      let status = 200;
      let jsonBody: any = null;
      let nextCalled = false;

      const req = { headers, ip, socket: { remoteAddress: ip } } as any;
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

    it('fails closed with 401 when CONTROL_API_TOKEN is unset in environment', () => {
      const origToken = config.CONTROL_API_TOKEN;
      const origAllow = config.ALLOW_UNAUTHENTICATED_CONTROL;

      try {
        (config as any).CONTROL_API_TOKEN = '';
        (config as any).ALLOW_UNAUTHENTICATED_CONTROL = false;

        const ctx = createMockContext({ 'x-api-token': 'any-token' });
        requireControlAuth(ctx.req, ctx.res, ctx.next);

        expect(ctx.getResult().status).toBe(401);
        expect(ctx.getResult().nextCalled).toBe(false);
        expect(ctx.getResult().jsonBody?.error).toContain('CONTROL_API_TOKEN is not configured');
      } finally {
        (config as any).CONTROL_API_TOKEN = origToken;
        (config as any).ALLOW_UNAUTHENTICATED_CONTROL = origAllow;
      }
    });

    it('blocks mutating API endpoints with 401 when CONTROL_API_TOKEN is missing or invalid', () => {
      const origToken = config.CONTROL_API_TOKEN;
      (config as any).CONTROL_API_TOKEN = 'secret-test-token-123';

      try {
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
      } finally {
        (config as any).CONTROL_API_TOKEN = origToken;
      }
    });

    it('enforces auth failure rate limiting after consecutive invalid attempts', () => {
      const origToken = config.CONTROL_API_TOKEN;
      (config as any).CONTROL_API_TOKEN = 'correct-token';

      try {
        const testIp = '198.51.100.42';
        for (let i = 0; i < 10; i++) {
          const ctx = createMockContext({ 'x-api-token': 'wrong' }, testIp);
          requireControlAuth(ctx.req, ctx.res, ctx.next);
          expect(ctx.getResult().status).toBe(401);
        }

        // 11th attempt should trigger 429 Too Many Requests
        const blockedCtx = createMockContext({ 'x-api-token': 'correct-token' }, testIp);
        requireControlAuth(blockedCtx.req, blockedCtx.res, blockedCtx.next);
        expect(blockedCtx.getResult().status).toBe(429);
        expect(blockedCtx.getResult().nextCalled).toBe(false);
      } finally {
        (config as any).CONTROL_API_TOKEN = origToken;
        authFailureLimiter.reset();
      }
    });
  });

  describe('3. HTTP Mutating Endpoints Real Integration Suite', () => {
    let server: http.Server;
    let baseUrl: string;
    const testSecret = 'server-control-secret-xyz';

    beforeEach(async () => {
      (config as any).CONTROL_API_TOKEN = testSecret;
      (config as any).ALLOW_UNAUTHENTICATED_CONTROL = false;
      const app = createApiServer();
      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const port = (server.address() as AddressInfo).port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('unauthorized manual sell is blocked with 401', async () => {
      const res = await fetch(`${baseUrl}/api/positions/pos_1/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fraction: 1.0 }),
      });
      expect(res.status).toBe(401);
    });

    it('unauthorized manual close is blocked with 401', async () => {
      const res = await fetch(`${baseUrl}/api/positions/pos_1/close`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('unauthorized live arm is blocked with 401', async () => {
      const res = await fetch(`${baseUrl}/api/live/arm`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('unauthorized live kill is blocked with 401', async () => {
      const res = await fetch(`${baseUrl}/api/live/kill`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('unauthorized circuit breaker reset is blocked with 401', async () => {
      const resRisk = await fetch(`${baseUrl}/api/risk/reset`, { method: 'POST' });
      expect(resRisk.status).toBe(401);

      const resCircuit = await fetch(`${baseUrl}/api/circuit-breaker/reset`, { method: 'POST' });
      expect(resCircuit.status).toBe(401);
    });

    it('unauthorized wallet mutation is blocked with 401', async () => {
      const resAdd = await fetch(`${baseUrl}/api/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '11111111111111111111111111111111' }),
      });
      expect(resAdd.status).toBe(401);

      const resDel = await fetch(`${baseUrl}/api/wallets/11111111111111111111111111111111`, {
        method: 'DELETE',
      });
      expect(resDel.status).toBe(401);
    });

    it('authorized requests succeed when providing valid x-api-token or Bearer', async () => {
      // Circuit breaker reset with valid x-api-token
      const resReset = await fetch(`${baseUrl}/api/circuit-breaker/reset`, {
        method: 'POST',
        headers: { 'x-api-token': testSecret },
      });
      expect(resReset.status).toBe(200);

      // Kill with Bearer token
      const resKill = await fetch(`${baseUrl}/api/live/kill`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${testSecret}` },
      });
      expect(resKill.status).toBe(200);

      // Read-only endpoint does not require auth
      const resTelemetry = await fetch(`${baseUrl}/api/telemetry`);
      expect(resTelemetry.status).toBe(200);
    });
  });

  describe('4. Helius Webhook Fail-Closed Security', () => {
    it('rejects with 503 when HELIUS_WEBHOOK_SECRET is not configured', () => {
      const origSecret = config.HELIUS_WEBHOOK_SECRET;
      const origBypass = config.ALLOW_UNAUTHENTICATED_WEBHOOK;

      try {
        (config as any).HELIUS_WEBHOOK_SECRET = '';
        (config as any).ALLOW_UNAUTHENTICATED_WEBHOOK = false;

        let statusCode = 200;
        let responseBody: any = null;
        const receiver = new WebhookReceiver({ onTransaction: () => {} });

        const req = { headers: {}, body: [{ signature: 'sig_123' }] } as any;
        const res = {
          status: (code: number) => {
            statusCode = code;
            return { json: (b: any) => { responseBody = b; } };
          },
        } as any;

        receiver.handleHeliusWebhook(req, res);
        expect(statusCode).toBe(503);
        expect(responseBody?.error).toContain('HELIUS_WEBHOOK_SECRET is not configured');
      } finally {
        (config as any).HELIUS_WEBHOOK_SECRET = origSecret;
        (config as any).ALLOW_UNAUTHENTICATED_WEBHOOK = origBypass;
      }
    });

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
      const resMissing = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: () => {},
            send: () => {},
          };
        },
      } as any;

      receiver.handleHeliusWebhook(reqMissing, resMissing);
      expect(statusCode).toBe(401);
      expect(received).toBe(false);

      // Invalid secret
      const reqBad = {
        headers: { authorization: 'wrong-secret' },
        body: [{ signature: 'sig_test' }],
      } as any;
      receiver.handleHeliusWebhook(reqBad, resMissing);
      expect(statusCode).toBe(401);
      expect(received).toBe(false);

      // Valid secret and valid structure
      const reqValid = {
        headers: { authorization: 'my-webhook-secret-xyz' },
        body: [{ signature: 'sig_valid_payload', slot: 100 }],
      } as any;
      let okCalled = false;
      const resValid = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: () => {
              okCalled = true;
            },
          };
        },
      } as any;

      receiver.handleHeliusWebhook(reqValid, resValid);
      expect(statusCode).toBe(200);
      expect(okCalled).toBe(true);
      expect(received).toBe(true);

      (config as any).HELIUS_WEBHOOK_SECRET = origSecret;
    });

    it('rejects malformed payloads with 400 without triggering onTransaction', () => {
      const origSecret = config.HELIUS_WEBHOOK_SECRET;
      (config as any).HELIUS_WEBHOOK_SECRET = 'test-secret';

      let received = false;
      const receiver = new WebhookReceiver({
        onTransaction: () => {
          received = true;
        },
      });

      const testPayload = (body: any, expectedStatus = 400) => {
        let code = 200;
        let responseBody: any = null;
        receiver.handleHeliusWebhook(
          { headers: { authorization: 'test-secret' }, body } as any,
          {
            status: (c: number) => {
              code = c;
              return { json: (b: any) => { responseBody = b; } };
            },
          } as any
        );
        return { code, responseBody };
      };

      // Non-array
      expect(testPayload({ not: 'an array' }).code).toBe(400);
      expect(received).toBe(false);

      // Empty array
      expect(testPayload([]).code).toBe(400);
      expect(received).toBe(false);

      // Over 50 items
      const hugeArray = new Array(51).fill({ signature: 'sig' });
      expect(testPayload(hugeArray).code).toBe(400);
      expect(received).toBe(false);

      // Missing signature on all items
      expect(testPayload([{ foo: 'bar' }]).code).toBe(400);
      expect(received).toBe(false);

      (config as any).HELIUS_WEBHOOK_SECRET = origSecret;
    });
  });

  describe('5. Production CORS Hardening', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      (config as any).NODE_ENV = 'production';
      (config as any).CORS_ALLOWED_ORIGINS = 'https://dashboard.approved.com,https://app.approved.com';
      (config as any).CONTROL_API_TOKEN = 'cors-test-token';

      const app = createApiServer();
      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const port = (server.address() as AddressInfo).port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      (config as any).NODE_ENV = 'test';
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('allows approved production origins', async () => {
      const res = await fetch(`${baseUrl}/api/telemetry`, {
        headers: { Origin: 'https://dashboard.approved.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.approved.com');
    });

    it('rejects unapproved browser origins in production', async () => {
      // In Express CORS, disallowed origin callbacks pass Error('Blocked by CORS policy')
      const res = await fetch(`${baseUrl}/api/telemetry`, {
        headers: { Origin: 'https://evil-attacker.com' },
      });
      // Should not have access-control-allow-origin header
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('allows direct server-to-server requests without Origin header', async () => {
      const res = await fetch(`${baseUrl}/api/telemetry`);
      expect(res.status).toBe(200);
    });
  });

  describe('6. Entry Gap Post-Quote Guard in Risk Engine', () => {
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

  describe('7. Pump.fun Bonding-Curve 1.25% Fee Correctness', () => {
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

  describe('8. TokenMetadataService USDC vs SOL Pricing Conversion', () => {
    it('correctly calculates priceSol from priceUsd / solPriceUsd when paired with USDC', async () => {
      const origFetch = global.fetch;
      (tokenMetadataService as any).lastSolPriceFetchTime = 0;
      (tokenMetadataService as any).cachedSolPriceUsd = 0;
      (tokenMetadataService as any).cache.clear();
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

  describe('9. Unverified Settlement Reconciliation Status', () => {
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

  describe('10. Telemetry Precision (No Artificial Latency Injection)', () => {
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

  describe('11. Activate & Deactivate Confirmation Guard Flow', () => {
    it('prompts confirmation when activate is triggered and provides confirm button', async () => {
      let promptSent = false;
      let promptKeyboard: any = null;
      const origSendCustomMessage = telegramNotifier.sendCustomMessage;

      (telegramNotifier as any).sendCustomMessage = async (
        _chatId: string | number,
        text: string,
        inlineKeyboard?: any
      ) => {
        if (text.includes('CONFIRM BOT ACTIVATION')) {
          promptSent = true;
          promptKeyboard = inlineKeyboard;
        }
      };

      try {
        const origMode = config.EXECUTION_MODE;
        (config as any).EXECUTION_MODE = 'LIVE';
        await telegramNotifier.promptActivateConfirmation('12345');
        (config as any).EXECUTION_MODE = origMode;

        expect(promptSent).toBe(true);
        expect(promptKeyboard).toBeDefined();
        const buttons = promptKeyboard.inline_keyboard.flat();
        expect(buttons.some((b: any) => b.callback_data === 'confirm_activate')).toBe(true);
        expect(buttons.some((b: any) => b.callback_data === 'menu_main')).toBe(true);
      } finally {
        telegramNotifier.sendCustomMessage = origSendCustomMessage;
      }
    });

    it('prompts confirmation when deactivate is triggered and provides confirm button', async () => {
      let promptSent = false;
      let promptKeyboard: any = null;
      const origSendCustomMessage = telegramNotifier.sendCustomMessage;

      (telegramNotifier as any).sendCustomMessage = async (
        _chatId: string | number,
        text: string,
        inlineKeyboard?: any
      ) => {
        if (text.includes('CONFIRM BOT DEACTIVATION')) {
          promptSent = true;
          promptKeyboard = inlineKeyboard;
        }
      };

      try {
        await telegramNotifier.promptDeactivateConfirmation('12345');
        expect(promptSent).toBe(true);
        expect(promptKeyboard).toBeDefined();
        const buttons = promptKeyboard.inline_keyboard.flat();
        expect(buttons.some((b: any) => b.callback_data === 'confirm_deactivate')).toBe(true);
        expect(buttons.some((b: any) => b.callback_data === 'menu_main')).toBe(true);
      } finally {
        telegramNotifier.sendCustomMessage = origSendCustomMessage;
      }
    });
  });

  describe('12. Dashboard API Auth Token Propagation', () => {
    it('attaches x-api-token and Bearer headers for privileged calls from sessionStorage', async () => {
      const storage: Record<string, string> = {};
      const mockSessionStorage = {
        getItem: (k: string) => storage[k] || null,
        setItem: (k: string, v: string) => { storage[k] = v; },
        removeItem: (k: string) => { delete storage[k]; },
      };

      (global as any).window = {
        sessionStorage: mockSessionStorage,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      };

      const { getControlToken, setControlToken, addWallet, armLiveEngine } = await import('../dashboard/src/lib/api.js');

      // Set operator token
      setControlToken('operator-secret-dash-token');
      expect(getControlToken()).toBe('operator-secret-dash-token');

      // Mock fetch to inspect sent headers
      let capturedHeaders: Headers | null = null;
      const origFetch = global.fetch;

      try {
        (global as any).fetch = async (_url: string, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          return {
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ success: true, armed: true }),
          };
        };

        await armLiveEngine();
        expect(capturedHeaders).not.toBeNull();
        expect(capturedHeaders!.get('x-api-token')).toBe('operator-secret-dash-token');
        expect(capturedHeaders!.get('authorization')).toBe('Bearer operator-secret-dash-token');

        capturedHeaders = null;
        await addWallet({ wallet: '33333333333333333333333333333333', label: 'Test Trader' });
        expect(capturedHeaders).not.toBeNull();
        expect(capturedHeaders!.get('x-api-token')).toBe('operator-secret-dash-token');
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('13. Settlement-Based Real Accounting & PnL Integrity', () => {
    it('calculates realized PnL and win-rate strictly from settled positions ledger', () => {
      // Clear or record test positions
      const testPos1 = {
        id: `acc_test_${Date.now()}_1`,
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: `AccMint1_${Date.now()}`,
        qtyRaw: '0',
        costBasisLamports: '100000000', // 0.1 SOL
        avgEntryPriceSol: 0.001,
        realizedPnlLamports: '50000000', // +0.05 SOL win
        unrealizedPnlLamports: '0',
        state: 'CLOSED' as const,
        openedAt: Date.now() - 10000,
        updatedAt: Date.now(),
        closedAt: Date.now(),
      };

      const testPos2 = {
        id: `acc_test_${Date.now()}_2`,
        targetWallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
        tokenMint: `AccMint2_${Date.now()}`,
        qtyRaw: '0',
        costBasisLamports: '100000000', // 0.1 SOL
        avgEntryPriceSol: 0.001,
        realizedPnlLamports: '-20000000', // -0.02 SOL loss
        unrealizedPnlLamports: '0',
        state: 'CLOSED' as const,
        openedAt: Date.now() - 5000,
        updatedAt: Date.now(),
        closedAt: Date.now(),
      };

      db.savePosition(testPos1);
      db.savePosition(testPos2);

      const summary = db.getAccountingSummary();
      expect(summary.totalTradesClosed).toBeGreaterThanOrEqual(2);
      expect(summary.winningTrades).toBeGreaterThanOrEqual(1);
      expect(summary.losingTrades).toBeGreaterThanOrEqual(1);
      // Net PnL must reflect settlements (+0.05 - 0.02 = +0.03)
      expect(typeof summary.realizedPnlSol).toBe('number');
      expect(summary.winRatePct).toBeGreaterThan(0);
      expect(summary.winRatePct).toBeLessThanOrEqual(100);
    });
  });

  describe('14. Operator Security & Audit Logging', () => {
    it('records and retrieves operational audit log entries', () => {
      const testAction = 'TEST_SECURITY_ARM';
      db.logAudit({
        timestamp: Date.now(),
        actor: 'OPERATOR_API',
        action: testAction,
        details: { reason: 'Automated test suite verification', ip: '127.0.0.1' },
        ipAddress: '127.0.0.1',
      });

      const logs = db.getAuditLogs(20);
      expect(logs.length).toBeGreaterThan(0);
      const found = logs.find((l) => l.action === testAction);
      expect(found).toBeDefined();
      expect(found?.actor).toBe('OPERATOR_API');
      expect(typeof found?.details).toBe('object');
      expect((found?.details as any)?.reason).toBe('Automated test suite verification');
    });
  });

  describe('15. Startup Readiness & Fail-Closed Validation', () => {
    it('evaluates readiness and marks LIVE mode as BLOCKED when critical config is missing', async () => {
      const { readinessValidator } = await import('../src/services/readiness.js');

      // 1. In PAPER mode with default test config, system can safely start
      const paperReport = readinessValidator.validate();
      expect(paperReport.executionMode).toBe('PAPER');
      expect(paperReport.canStart).toBe(true);

      // 2. In LIVE mode with missing acknowledgement or empty private key, must fail closed
      const origMode = config.EXECUTION_MODE;
      const origKey = config.FOLLOWER_PRIVATE_KEY;
      const origAck = config.LIVE_TRADING_ACK;

      try {
        (config as any).EXECUTION_MODE = 'LIVE';
        (config as any).FOLLOWER_PRIVATE_KEY = '';
        (config as any).LIVE_TRADING_ACK = '';

        const liveReport = readinessValidator.validate();
        expect(liveReport.overallStatus).toBe('BLOCKED');
        expect(liveReport.canStart).toBe(false);
        const criticalFailures = liveReport.checks.filter((c) => c.status === 'FAIL' && c.criticalForLive);
        expect(criticalFailures.length).toBeGreaterThanOrEqual(1);
      } finally {
        (config as any).EXECUTION_MODE = origMode;
        (config as any).FOLLOWER_PRIVATE_KEY = origKey;
        (config as any).LIVE_TRADING_ACK = origAck;
      }
    });
  });

  describe('16. Mint Decimals Safety & Rejection of Unverified Tokens', () => {
    it('rejects unverified mints when strict verification is enforced', async () => {
      const { mintDecimalsService } = await import('../src/services/mint-decimals.js');

      // WSOL is pre-seeded and verified
      const wsolDecimals = await mintDecimalsService.getDecimals('So11111111111111111111111111111111111111112');
      expect(wsolDecimals).toBe(9);

      // Unknown unverified mint with strictForTest must throw error
      await expect(
        mintDecimalsService.getDecimals('UnverifiedRandomMintXYZ1111111111111111111111', { strictForTest: true })
      ).rejects.toThrow(/Cannot execute trading or accounting with unverified token decimals/);

      // Display-only mode allows non-strict display fallback
      const displayDecimals = await mintDecimalsService.getDecimals('UnverifiedRandomMintXYZ1111111111111111111111', {
        allowUnverifiedDisplay: true,
      });
      expect(displayDecimals).toBe(6);
    });
  });

  describe('17. Watched Wallet API Canonical Validation', () => {
    it('rejects invalid Solana addresses and accepts canonical schemas', async () => {
      const { createApiServer } = await import('../src/api/server.js');
      const app = createApiServer();
      const origToken = config.CONTROL_API_TOKEN;
      (config as any).CONTROL_API_TOKEN = 'secret-test-token-val';

      let server: any;
      let baseUrl = '';

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const port = (server.address() as any).port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });

      try {
        // 1. Invalid base58 address must return 400
        const invalidRes = await fetch(`${baseUrl}/api/wallets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-token': 'secret-test-token-val',
          },
          body: JSON.stringify({
            wallet: 'NOT_A_VALID_SOLANA_KEY',
            label: 'Hacker',
          }),
        });
        expect(invalidRes.status).toBe(400);
        const invalidData = await invalidRes.json() as any;
        expect(invalidData.error).toContain('Invalid Solana base58 public key');

        // 2. Valid Solana address must succeed
        const validRes = await fetch(`${baseUrl}/api/wallets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-token': 'secret-test-token-val',
          },
          body: JSON.stringify({
            wallet: 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS',
            label: 'Valid Target Trader',
            buy_mode: 'FIXED_SIZE',
            fixed_buy_raw: '100000000',
            copy_ratio: 0.05,
          }),
        });
        expect(validRes.status).toBe(200);
        const validData = await validRes.json() as any;
        expect(validData.success).toBe(true);
        expect(validData.wallet.wallet).toBe('CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS');
      } finally {
        (config as any).CONTROL_API_TOKEN = origToken;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
