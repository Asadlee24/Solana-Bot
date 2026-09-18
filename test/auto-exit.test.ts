import { describe, expect, it, vi, beforeEach } from 'vitest';
import { autoExitManager } from '../src/engine/auto-exit-manager.js';
import { db } from '../src/db/database.js';
import { tokenMetadataService } from '../src/services/token-metadata.js';
import { telegramNotifier } from '../src/notifications/telegram.js';

describe('Automated Take-Profit & Stop-Loss Engine (Moonbag & Anti-Rug)', () => {
  const mockSignalManager = {
    executeManualExit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers 50% Moonbag Take-Profit when token price doubles (+100%)', async () => {
    const testMint = 'TPMint111111111111111111111111111111111111111';
    const testPos = {
      id: 'pos_tp_test',
      targetWallet: 'TargetWallet11111111111111111111111111111111',
      tokenMint: testMint,
      qtyRaw: '1000000000',
      costBasisLamports: '50000000', // 0.05 SOL
      avgEntryPriceSol: 0.00005,
      realizedPnlLamports: '0',
      unrealizedPnlLamports: '0',
      state: 'OPEN' as const,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      tp1Triggered: false,
      peakPnlPct: 0,
    };

    vi.spyOn(db, 'getOpenPositions').mockReturnValue([testPos]);
    vi.spyOn(db, 'markPositionTpTriggered').mockImplementation(() => {});
    vi.spyOn(telegramNotifier, 'notifyAutoTakeProfit').mockImplementation(() => {});

    // Token price is 0.00010 SOL (+100% gain vs entry 0.00005)
    vi.spyOn(tokenMetadataService, 'getTokenMetadata').mockResolvedValue({
      mint: testMint,
      name: 'Moon Token',
      symbol: 'MOON',
      priceUsd: 0.01,
      priceSol: 0.00010,
      fdvUsd: 100000,
      liquidityUsd: 50000,
      dexScreenerUrl: '',
      pumpFunUrl: '',
      solscanUrl: '',
      updatedAt: Date.now(),
    });

    mockSignalManager.executeManualExit.mockResolvedValue({
      order: {
        orderId: 'ord_tp_1',
        intentId: 'int_tp_1',
        targetSignature: 'manual_exit_tp',
        mode: 'LIVE',
        side: 'SELL',
        tokenMint: testMint,
        inAmountRaw: '500000000',
        outAmountRaw: '50000000',
        minOutAmountRaw: '49000000',
        effectivePrice: 0.00010,
        quotedAt: 0n,
        priorityFeeLamports: 0n,
        tipLamports: 0n,
        routeFeeLamports: 0n,
        status: 'FILLED',
      },
      position: { ...testPos, tp1Triggered: true },
    });

    autoExitManager.start(mockSignalManager);
    await autoExitManager.checkOpenPositions();

    expect(mockSignalManager.executeManualExit).toHaveBeenCalledWith(testPos.id, 0.5);
    expect(db.markPositionTpTriggered).toHaveBeenCalledWith(testPos.id, expect.any(Number));
    expect(telegramNotifier.notifyAutoTakeProfit).toHaveBeenCalled();
    autoExitManager.stop();
  });

  it('triggers 100% Emergency Stop-Loss when token dumps by -25%', async () => {
    const testMint = 'SLMint111111111111111111111111111111111111111';
    const testPos = {
      id: 'pos_sl_test',
      targetWallet: 'TargetWallet11111111111111111111111111111111',
      tokenMint: testMint,
      qtyRaw: '1000000000',
      costBasisLamports: '50000000', // 0.05 SOL
      avgEntryPriceSol: 0.00005,
      realizedPnlLamports: '0',
      unrealizedPnlLamports: '0',
      state: 'OPEN' as const,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      tp1Triggered: false,
      peakPnlPct: 0,
    };

    vi.spyOn(db, 'getOpenPositions').mockReturnValue([testPos]);
    vi.spyOn(telegramNotifier, 'notifyAutoStopLoss').mockImplementation(() => {});

    // Token price is 0.000035 SOL (-30% drop vs entry 0.00005)
    vi.spyOn(tokenMetadataService, 'getTokenMetadata').mockResolvedValue({
      mint: testMint,
      name: 'Dump Token',
      symbol: 'DUMP',
      priceUsd: 0.0035,
      priceSol: 0.000035,
      fdvUsd: 35000,
      liquidityUsd: 10000,
      dexScreenerUrl: '',
      pumpFunUrl: '',
      solscanUrl: '',
      updatedAt: Date.now(),
    });

    mockSignalManager.executeManualExit.mockResolvedValue({
      order: {
        orderId: 'ord_sl_1',
        intentId: 'int_sl_1',
        targetSignature: 'manual_exit_sl',
        mode: 'LIVE',
        side: 'SELL',
        tokenMint: testMint,
        inAmountRaw: '1000000000',
        outAmountRaw: '35000000',
        minOutAmountRaw: '34000000',
        effectivePrice: 0.000035,
        quotedAt: 0n,
        priorityFeeLamports: 0n,
        tipLamports: 0n,
        routeFeeLamports: 0n,
        status: 'FILLED',
      },
      position: { ...testPos, state: 'CLOSED' as const },
    });

    autoExitManager.start(mockSignalManager);
    await autoExitManager.checkOpenPositions();

    expect(mockSignalManager.executeManualExit).toHaveBeenCalledWith(testPos.id, 1.0);
    expect(telegramNotifier.notifyAutoStopLoss).toHaveBeenCalled();
    autoExitManager.stop();
  });
});
