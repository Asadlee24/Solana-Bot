import React from 'react';

export interface MetricCardProps {
  label: string;
  value: string | number | React.ReactNode;
  subValue?: string | React.ReactNode;
  badge?: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'warning' | 'purple' | 'cyan';
}

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  subValue,
  badge,
  hint,
  icon,
  tone = 'default',
}) => {
  const toneColorMap: Record<string, string> = {
    default: 'var(--text-primary)',
    positive: '#10b981',
    negative: '#ef4444',
    warning: '#f59e0b',
    purple: '#c084fc',
    cyan: '#29d4ff',
  };

  return (
    <div className="terminal-metric-card">
      <div className="metric-header">
        <div className="metric-label-group">
          {icon && <span className="metric-icon">{icon}</span>}
          <span className="metric-title">{label}</span>
        </div>
        {badge}
      </div>

      <div className="metric-value-row">
        <div className="metric-main-value" style={{ color: toneColorMap[tone] }}>
          {value}
        </div>
      </div>

      {(subValue || hint) && (
        <div className="metric-footer">
          {subValue && <div className="metric-sub">{subValue}</div>}
          {hint && <div className="metric-hint">{hint}</div>}
        </div>
      )}
    </div>
  );
};
