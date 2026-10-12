import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Link } from 'react-router-dom';
import type { Position } from '@shared/types';
import { instrumentPath, money, percent } from '../lib/format';
import { EmptyState } from './EmptyState';

const palette = ['var(--chart-1, #187764)', 'var(--chart-2, #6478a6)', 'var(--chart-3, #b88036)', 'var(--chart-4, #8868aa)', '#be185d', '#4f46e5', '#475569', '#a16207'];

export function AllocationChart({ positions, currency }: { positions: Position[]; currency: string }) {
  const available = positions.filter(position => position.marketValueBase != null && position.marketValueBase > 0);
  const data = available.map(position => ({ id: position.instrumentId, name: position.instrument.name, value: position.marketValueBase! }));
  return <section className="chart-panel allocation-panel" aria-label="Verteilung nach Positionen">
    <div className="chart-header"><h2>Verteilung</h2><span className="muted">Nach Marktwert</span></div>
    {!data.length ? <EmptyState title="Noch keine Verteilung" description="Für die Verteilung werden offene Positionen mit verfügbarem Marktwert benötigt." /> : <>
      <div className="chart-container allocation-chart">
        <ResponsiveContainer width="100%" height={230} minWidth={0}>
          <PieChart accessibilityLayer><Pie data={data} dataKey="value" nameKey="name" innerRadius={66} outerRadius={96} paddingAngle={data.length > 1 ? 2 : 0} stroke="var(--surface, #ffffff)" isAnimationActive={false}>
            {data.map((item, index) => <Cell key={item.id} fill={palette[index % palette.length]} />)}
          </Pie><Tooltip formatter={value => money(typeof value === 'number' ? value : null, currency)} itemStyle={{ color: 'var(--text, #172b3a)' }} contentStyle={{ background: 'var(--surface, #ffffff)', border: '1px solid var(--border, #dfe5ec)', borderRadius: 10, color: 'var(--text, #172b3a)' }} /></PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="allocation-list">{available.map((position, index) => <li key={position.instrumentId} className="allocation-row">
        <span><i className="chart-swatch" aria-hidden="true" style={{ background: palette[index % palette.length] }} /><Link to={instrumentPath(position.instrumentId)}>{position.instrument.name}</Link></span><span><strong>{percent(position.weightPercent)}</strong><br /><small className="muted">{money(position.marketValueBase, currency)}</small></span>
      </li>)}</ul>
      {available.length !== positions.length && <p className="data-source-note">Die Verteilung enthält nur Positionen mit verfügbarem, positivem Marktwert. Nicht bewertbare Positionen sind nicht dargestellt.</p>}
    </>}
  </section>;
}
