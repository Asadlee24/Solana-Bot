import React, { useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { useDashboardData } from './hooks/useDashboardData';
import { triggerSimulationSwap } from './lib/api';
import { Latency } from './pages/Latency';
import { Overview } from './pages/Overview';
import { Positions } from './pages/Positions';
import { Risk } from './pages/Risk';
import { System } from './pages/System';
import { Trades } from './pages/Trades';
import { Wallets } from './pages/Wallets';
import { NavigationTab } from './types/dashboard';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('overview');
  const [isSimulating, setIsSimulating] = useState(false);

  const {
    telemetry,
    orders,
    positions,
    latencySamples,
    wallets,
    riskConfig,
    isLoading,
    streamStatus,
    liveEvents,
    isStreamPaused,
    setIsStreamPaused,
    clearEvents,
    refresh,
  } = useDashboardData();

  const handleSimulate = async () => {
    setIsSimulating(true);
    const targetWallet = wallets[0]?.wallet || 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS';
    const sampleToken = '3fkpFTci5PdEYWxxkucVovJfhJM1td7ecJXrbXjXcSjN';

    try {
      await triggerSimulationSwap(targetWallet, sampleToken);
      setTimeout(() => {
        refresh();
      }, 350);
    } catch (err) {
      console.error('Simulation event failed:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  const primaryTargetWallet = wallets[0]?.wallet || 'CwUHN4zTn5wiEYoZjsP4FrDvAT9heDWewCTQjhgwhJqS';

  return (
    <AppShell
      activeTab={activeTab}
      onTabChange={setActiveTab}
      telemetry={telemetry}
      streamStatus={streamStatus}
      onRefresh={refresh}
      onSimulate={handleSimulate}
      isSimulating={isSimulating}
      openOrdersCount={orders.length}
      openPositionsCount={positions.filter((p) => p.state === 'OPEN').length}
      targetWallet={primaryTargetWallet}
    >
      {activeTab === 'overview' && (
        <Overview
          telemetry={telemetry}
          orders={orders}
          positions={positions}
          latencySamples={latencySamples}
          streamStatus={streamStatus}
          onNavigateTab={setActiveTab}
          isLoading={isLoading}
        />
      )}

      {activeTab === 'trades' && (
        <Trades orders={orders} isLoading={isLoading} />
      )}

      {activeTab === 'positions' && (
        <Positions
          positions={positions}
          telemetry={telemetry}
          isLoading={isLoading}
        />
      )}

      {activeTab === 'latency' && (
        <Latency
          telemetry={telemetry}
          samples={latencySamples}
        />
      )}

      {activeTab === 'wallets' && (
        <Wallets
          wallets={wallets}
          onRefresh={refresh}
          isLoading={isLoading}
        />
      )}

      {activeTab === 'risk' && (
        <Risk
          riskConfig={riskConfig}
          telemetry={telemetry}
          onRefresh={refresh}
        />
      )}

      {activeTab === 'system' && (
        <System
          telemetry={telemetry}
          streamStatus={streamStatus}
          events={liveEvents}
          isStreamPaused={isStreamPaused}
          onToggleStreamPause={() => setIsStreamPaused(!isStreamPaused)}
          onClearEvents={clearEvents}
        />
      )}
    </AppShell>
  );
}
