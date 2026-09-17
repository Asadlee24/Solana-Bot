import {
  Activity,
  ArrowLeftRight,
  Briefcase,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  ShieldAlert,
  Wallet,
  Zap,
} from 'lucide-react';
import React from 'react';
import { NavigationTab } from '../../types/dashboard';

const GithubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
  </svg>
);

interface SidebarProps {
  activeTab: NavigationTab;
  onTabChange: (tab: NavigationTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  openOrdersCount?: number;
  openPositionsCount?: number;
  isCircuitTripped?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  openOrdersCount = 0,
  openPositionsCount = 0,
  isCircuitTripped = false,
}) => {
  const navItems: {
    id: NavigationTab;
    label: string;
    icon: React.ReactNode;
    badge?: number | string;
    badgeTone?: 'default' | 'warn' | 'success';
  }[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <LayoutDashboard size={18} />,
    },
    {
      id: 'trades',
      label: 'Live Trades',
      icon: <ArrowLeftRight size={18} />,
      badge: openOrdersCount > 0 ? openOrdersCount : undefined,
    },
    {
      id: 'positions',
      label: 'Positions',
      icon: <Briefcase size={18} />,
      badge: openPositionsCount > 0 ? openPositionsCount : undefined,
      badgeTone: 'success',
    },
    {
      id: 'latency',
      label: 'Latency',
      icon: <Zap size={18} />,
    },
    {
      id: 'wallets',
      label: 'Wallets',
      icon: <Wallet size={18} />,
    },
    {
      id: 'risk',
      label: 'Risk Engine',
      icon: <ShieldAlert size={18} />,
      badge: isCircuitTripped ? '!' : undefined,
      badgeTone: 'warn',
    },
    {
      id: 'system',
      label: 'System Diagnostics',
      icon: <Activity size={18} />,
    },
  ];

  return (
    <aside className={`terminal-sidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Brand Header */}
      <div className="sidebar-brand">
        <div className="brand-logo-hex">
          <Zap size={18} color="#14f195" />
        </div>
        {!collapsed && (
          <div className="brand-text">
            <span className="brand-title">SOLANA COPY ENGINE</span>
            <span className="brand-subtitle">Trading Terminal 2026</span>
          </div>
        )}
      </div>

      {/* Main Navigation */}
      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onTabChange(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
              {!collapsed && item.badge && (
                <span
                  className={`nav-badge ${
                    item.badgeTone === 'warn'
                      ? 'nav-badge-warn'
                      : item.badgeTone === 'success'
                      ? 'nav-badge-success'
                      : ''
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer Area */}
      <div className="sidebar-footer">
        <div className="sidebar-footer-links">
          <a
            href="https://github.com/Asadlee24/Solana-Bot"
            target="_blank"
            rel="noreferrer"
            className="footer-link-btn"
            title="GitHub Repository"
          >
            <GithubIcon size={16} />
            {!collapsed && <span>Source Repo</span>}
          </a>

          <button
            type="button"
            className="footer-link-btn collapse-toggle-btn"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>

        {!collapsed && (
          <div className="sidebar-credit">
            <span>Built by Asad Lee</span>
            <span className="env-pill">v1.2.0 • MAINNET</span>
          </div>
        )}
      </div>
    </aside>
  );
};
