import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state">
    <span className="state-icon" aria-hidden="true">◈</span>
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {action && <div className="state-actions">{action}</div>}
  </div>;
}
