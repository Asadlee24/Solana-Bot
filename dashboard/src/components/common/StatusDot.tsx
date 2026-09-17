import React from 'react';

export interface StatusDotProps {
  status: 'online' | 'offline' | 'warning' | 'purple' | 'neutral';
  pulse?: boolean;
  size?: number;
  title?: string;
}

export const StatusDot: React.FC<StatusDotProps> = ({
  status,
  pulse = true,
  size = 8,
  title,
}) => {
  const colorMap: Record<StatusDotProps['status'], { bg: string; shadow: string }> = {
    online: { bg: '#10b981', shadow: 'rgba(16, 185, 129, 0.45)' },
    offline: { bg: '#ef4444', shadow: 'rgba(239, 68, 68, 0.45)' },
    warning: { bg: '#f59e0b', shadow: 'rgba(245, 158, 11, 0.45)' },
    purple: { bg: '#9945ff', shadow: 'rgba(153, 69, 255, 0.45)' },
    neutral: { bg: '#64748b', shadow: 'rgba(100, 116, 139, 0.25)' },
  };

  const { bg, shadow } = colorMap[status];

  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: bg,
        boxShadow: pulse ? `0 0 ${size + 2}px ${shadow}` : 'none',
        flexShrink: 0,
      }}
      className={pulse && status === 'online' ? 'status-dot-pulse' : undefined}
    />
  );
};
