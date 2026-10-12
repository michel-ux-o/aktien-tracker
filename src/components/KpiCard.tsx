import type { ReactNode } from 'react';

export function KpiCard({ title, value, subtitle }: { title: string; value: ReactNode; subtitle?: ReactNode }) {
  return <section className="kpi-card" aria-label={title}>
    <p className="kpi-title">{title}</p>
    <div className="kpi-value">{value}</div>
    {subtitle != null && <div className="kpi-subtitle">{subtitle}</div>}
  </section>;
}
