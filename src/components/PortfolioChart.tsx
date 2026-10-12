import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryRange, PortfolioHistory } from '@shared/types';
import { date, money, number } from '../lib/format';
import { ChartRange } from './ChartRange';
import { DataSourceNote } from './DataSourceNote';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { EmptyState } from './EmptyState';

export function PortfolioChart({ history, range, onRangeChange, loading = false, error, onRetry }: {
  history: PortfolioHistory | null; range: HistoryRange; onRangeChange: (range: HistoryRange) => void; loading?: boolean; error?: unknown; onRetry?: () => void;
}) {
  return <section className="chart-panel" aria-label="Portfolioentwicklung">
    <div className="chart-header"><h2>Portfolioentwicklung</h2><ChartRange range={range} onRangeChange={onRangeChange} /></div>
    {loading ? <LoadingState label="Portfolioentwicklung wird geladen …" /> : error != null ? <ErrorState error={error} onRetry={onRetry} /> : !history?.points.length ?
      <EmptyState title="Noch kein Verlauf" description="Sobald Transaktionen und historische Kursdaten vorliegen, siehst du hier die Entwicklung deines Portfolios." /> : <>
        <div className="chart-legend"><span><i className="chart-swatch" style={{ background: 'var(--chart-1, #1d4ed8)' }} /> Marktwert</span><span><i className="chart-swatch" style={{ background: 'var(--chart-2, #8b5cf6)' }} /> Investiertes Kapital (gestrichelt)</span></div>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={280} minWidth={0}>
            <LineChart data={history.points} margin={{ top: 16, right: 16, bottom: 8, left: 4 }} accessibilityLayer>
              <CartesianGrid vertical={false} stroke="var(--border, #dfe5ec)" strokeDasharray="4 4" />
              <XAxis dataKey="date" tickFormatter={value => date(String(value)).slice(0, 5)} minTickGap={34} tickLine={false} axisLine={false} tick={{ fill: 'var(--text-muted, #64748b)', fontSize: 12 }} />
              <YAxis width={65} tickFormatter={value => number(Number(value), 0)} tickLine={false} axisLine={false} tick={{ fill: 'var(--text-muted, #64748b)', fontSize: 12 }} />
              <Tooltip labelFormatter={value => date(String(value))} formatter={(value, name) => [money(typeof value === 'number' ? value : null, history.baseCurrency), name === 'marketValue' ? 'Marktwert' : 'Investiertes Kapital']} itemStyle={{ color: 'var(--text, #172b3a)' }} contentStyle={{ background: 'var(--surface, #ffffff)', border: '1px solid var(--border, #dfe5ec)', borderRadius: 10, color: 'var(--text, #172b3a)' }} />
              <Line type="monotone" dataKey="marketValue" stroke="var(--chart-1, #1d4ed8)" strokeWidth={2.5} dot={history.points.length === 1} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="investedCapital" stroke="var(--chart-2, #8b5cf6)" strokeWidth={2} strokeDasharray="6 4" dot={history.points.length === 1} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <details className="chart-data"><summary>Diagrammdaten als Tabelle</summary><div className="table-scroll"><table><caption className="sr-only">Portfolioentwicklung in {history.baseCurrency}</caption><thead><tr><th scope="col">Datum</th><th scope="col">Marktwert</th><th scope="col">Investiertes Kapital</th></tr></thead><tbody>{history.points.map(point => <tr key={point.date}><td>{date(point.date)}</td><td>{money(point.marketValue, history.baseCurrency)}</td><td>{money(point.investedCapital, history.baseCurrency)}</td></tr>)}</tbody></table></div></details>
      </>}
    {!loading && history && <>
      {(!history.complete || history.notes.length > 0) && <div className="chart-notes" role="note">{!history.complete && <strong>Eingeschränkte Gesamtauswertung des Verlaufs</strong>}{history.notes.length > 0 && <ul>{history.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}</div>}
      <DataSourceNote meta={history.meta} />
    </>}
  </section>;
}
