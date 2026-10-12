import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryRange, PriceHistory } from '@shared/types';
import { date, money, number } from '../lib/format';
import { ChartRange } from './ChartRange';
import { DataSourceNote } from './DataSourceNote';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { EmptyState } from './EmptyState';

export function PriceChart({ history, range, onRangeChange, loading = false, error, onRetry }: {
  history: PriceHistory | null; range: HistoryRange; onRangeChange: (range: HistoryRange) => void; loading?: boolean; error?: unknown; onRetry?: () => void;
}) {
  return <section className="chart-panel" aria-label="Kursverlauf">
    <div className="chart-header"><h2>Kursverlauf</h2><ChartRange range={range} onRangeChange={onRangeChange} supportedRanges={history?.supportedRanges ?? []} /></div>
    {loading ? <LoadingState label="Kursverlauf wird geladen …" /> : error != null ? <ErrorState error={error} onRetry={onRetry} /> : !history?.points.length ?
      <EmptyState title="Keine Kursdaten" description="Für diesen Zeitraum liegen keine Kursdaten vor." /> : <>
        <p className="chart-summary">Schlusskurse in {history.currency}. Vom {date(history.points[0]!.date)} bis {date(history.points.at(-1)!.date)}.</p>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={280} minWidth={0}>
            <LineChart data={history.points} margin={{ top: 16, right: 16, bottom: 8, left: 4 }} accessibilityLayer>
              <CartesianGrid vertical={false} stroke="var(--border, #dfe5ec)" strokeDasharray="4 4" />
              <XAxis dataKey="date" tickFormatter={value => date(String(value)).slice(0, 5)} minTickGap={34} tickLine={false} axisLine={false} tick={{ fill: 'var(--text-muted, #64748b)', fontSize: 12 }} />
              <YAxis width={65} domain={['auto', 'auto']} tickFormatter={value => number(Number(value), 0)} tickLine={false} axisLine={false} tick={{ fill: 'var(--text-muted, #64748b)', fontSize: 12 }} />
              <Tooltip labelFormatter={value => date(String(value))} formatter={value => [money(typeof value === 'number' ? value : null, history.currency), 'Schlusskurs']} itemStyle={{ color: 'var(--text, #172b3a)' }} contentStyle={{ background: 'var(--surface, #ffffff)', border: '1px solid var(--border, #dfe5ec)', borderRadius: 10, color: 'var(--text, #172b3a)' }} />
              <Line type="monotone" dataKey="close" name="Schlusskurs" stroke="var(--chart-1, #1d4ed8)" strokeWidth={2.5} dot={history.points.length === 1} activeDot={{ r: 5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <details className="chart-data"><summary>Diagrammdaten als Tabelle</summary><div className="table-scroll"><table><caption className="sr-only">Schlusskurse in {history.currency}</caption><thead><tr><th scope="col">Datum</th><th scope="col">Schlusskurs</th></tr></thead><tbody>{history.points.map(point => <tr key={point.date}><td>{date(point.date)}</td><td>{money(point.close, history.currency)}</td></tr>)}</tbody></table></div></details>
      </>}
    {!loading && history && <DataSourceNote meta={history.meta} />}
  </section>;
}
