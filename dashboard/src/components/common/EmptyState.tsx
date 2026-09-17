import { Inbox } from 'lucide-react';
import React from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon = <Inbox size={28} color="var(--text-muted)" />,
  action,
}) => {
  return (
    <div className="terminal-empty-state">
      <div className="empty-icon-wrapper">{icon}</div>
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
};
