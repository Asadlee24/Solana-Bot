import React, { useState } from 'react';
import { NavigationTab, StreamStatus, Telemetry } from '../../types/dashboard';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  activeTab: NavigationTab;
  onTabChange: (tab: NavigationTab) => void;
  telemetry: Telemetry | null;
  streamStatus: StreamStatus;
  onRefresh: () => void;
  onSimulate: () => void;
  isSimulating: boolean;
  openOrdersCount?: number;
  openPositionsCount?: number;
  targetWallet?: string;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  activeTab,
  onTabChange,
  telemetry,
  streamStatus,
  onRefresh,
  onSimulate,
  isSimulating,
  openOrdersCount,
  openPositionsCount,
  targetWallet,
  children,
}) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleTabSelect = (tab: NavigationTab) => {
    onTabChange(tab);
    setMobileMenuOpen(false);
  };

  return (
    <div className="terminal-app-shell">
      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div
          className="mobile-backdrop"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar (Desktop + Mobile Drawer) */}
      <div className={`sidebar-wrapper ${mobileMenuOpen ? 'mobile-open' : ''}`}>
        <Sidebar
          activeTab={activeTab}
          onTabChange={handleTabSelect}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          openOrdersCount={openOrdersCount}
          openPositionsCount={openPositionsCount}
          isCircuitTripped={telemetry?.circuitBreakerTripped}
        />
      </div>

      {/* Main Content Area */}
      <div className={`main-viewport ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Topbar
          activeTab={activeTab}
          telemetry={telemetry}
          streamStatus={streamStatus}
          onRefresh={onRefresh}
          onSimulate={onSimulate}
          isSimulating={isSimulating}
          onMobileMenuToggle={() => setMobileMenuOpen(!mobileMenuOpen)}
          targetWallet={targetWallet}
        />

        <main className="content-container">{children}</main>
      </div>
    </div>
  );
};
