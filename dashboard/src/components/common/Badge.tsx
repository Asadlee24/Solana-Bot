import React from 'react';

export interface BadgeProps {
  variant:
    | 'buy'
    | 'sell'
    | 'paper'
    | 'live'
    | 'success'
    | 'warn'
    | 'danger'
    | 'neutral'
    | 'estimated'
    | 'real';
  children: React.ReactNode;
  size?: 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({ variant, children, size = 'md' }) => {
  const styles: Record<BadgeProps['variant'], { bg: string; color: string; border: string }> = {
    buy: {
      bg: 'rgba(16, 185, 129, 0.12)',
      color: '#10b981',
      border: 'rgba(16, 185, 129, 0.3)',
    },
    sell: {
      bg: 'rgba(239, 68, 68, 0.12)',
      color: '#ef4444',
      border: 'rgba(239, 68, 68, 0.3)',
    },
    paper: {
      bg: 'rgba(153, 69, 255, 0.12)',
      color: '#c084fc',
      border: 'rgba(153, 69, 255, 0.3)',
    },
    live: {
      bg: 'rgba(239, 68, 68, 0.22)',
      color: '#fca5a5',
      border: 'rgba(239, 68, 68, 0.55)',
    },
    success: {
      bg: 'rgba(20, 241, 149, 0.12)',
      color: '#14f195',
      border: 'rgba(20, 241, 149, 0.3)',
    },
    warn: {
      bg: 'rgba(245, 158, 11, 0.12)',
      color: '#fbbf24',
      border: 'rgba(245, 158, 11, 0.3)',
    },
    danger: {
      bg: 'rgba(239, 68, 68, 0.14)',
      color: '#f87171',
      border: 'rgba(239, 68, 68, 0.35)',
    },
    neutral: {
      bg: 'rgba(100, 116, 139, 0.14)',
      color: '#94a3b8',
      border: 'rgba(100, 116, 139, 0.25)',
    },
    estimated: {
      bg: 'rgba(217, 119, 6, 0.12)',
      color: '#f59e0b',
      border: 'rgba(217, 119, 6, 0.28)',
    },
    real: {
      bg: 'rgba(6, 182, 212, 0.12)',
      color: '#22d3ee',
      border: 'rgba(6, 182, 212, 0.3)',
    },
  };

  const current = styles[variant];
  const isSmall = size === 'sm';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: isSmall ? '1px 6px' : '2px 8px',
        borderRadius: 4,
        fontSize: isSmall ? 10 : 11,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        backgroundColor: current.bg,
        color: current.color,
        border: `1px solid ${current.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
};
