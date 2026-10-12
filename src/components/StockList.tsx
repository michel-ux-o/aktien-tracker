import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { WatchlistItem } from '@shared/types';
import { instrumentPath, money } from '../lib/format';
import { ChangeValue } from './ChangeValue';
import { DataSourceNote } from './DataSourceNote';
import { EmptyState } from './EmptyState';
import { tableDataSources, TableDataSources, TableQuoteTimestamp } from './TableDataSources';

type SortField = 'name' | 'change';

export function StockList({ items, onRemove, sortable = false }: { items: WatchlistItem[]; onRemove?: (item: WatchlistItem) => void; sortable?: boolean }) {
  const [sortField, setSortField] = useState<SortField>('name');
  const [ascending, setAscending] = useState(true);
  const sorted = useMemo(() => sortable ? [...items].sort((a, b) => {
    if (sortField === 'name') return a.instrument.name.localeCompare(b.instrument.name, 'de', { sensitivity: 'base' }) * (ascending ? 1 : -1);
    const left = a.quote?.changePercent;
    const right = b.quote?.changePercent;
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (left - right) * (ascending ? 1 : -1);
  }) : items, [items, sortable, sortField, ascending]);
  const sort = (field: SortField) => { if (sortField === field) setAscending(value => !value); else { setSortField(field); setAscending(field === 'name'); } };
  const sortLabel = (field: SortField) => {
    const nextAscending = sortField === field ? !ascending : field === 'name';
    return `Nach ${field === 'name' ? 'Name' : 'Tagesveränderung'} ${nextAscending ? 'aufsteigend' : 'absteigend'} sortieren`;
  };
  const sortIndicator = (field: SortField) => sortField === field ? ascending ? ' ↑' : ' ↓' : ' ↕';
  const remove = (item: WatchlistItem) => onRemove && <button type="button" className="button button-secondary stock-remove" onClick={() => onRemove(item)} aria-label={`${item.instrument.name} von der Watchlist entfernen`}>Entfernen</button>;
  const sources = tableDataSources(sorted.map((item) => item.quote));
  if (!items.length) return <EmptyState title="Noch keine Aktien" description="Suche nach einer Aktie und füge sie deiner Watchlist hinzu." />;
  return <div className="stock-list">
    <div className="stock-table"><table><caption className="sr-only">Aktien mit letztem Kurs und Tagesveränderung</caption><thead><tr>
      <th scope="col" aria-sort={sortable ? sortField === 'name' ? ascending ? 'ascending' : 'descending' : 'none' : undefined}>{sortable ? <button type="button" className="sort-button" onClick={() => sort('name')} aria-label={sortLabel('name')}>Aktie{sortIndicator('name')}</button> : 'Aktie'}</th>
      <th scope="col">Letzter Kurs</th><th scope="col">Währung</th><th scope="col" aria-sort={sortable ? sortField === 'change' ? ascending ? 'ascending' : 'descending' : 'none' : undefined}>{sortable ? <button type="button" className="sort-button" onClick={() => sort('change')} aria-label={sortLabel('change')}>Heute{sortIndicator('change')}</button> : 'Heute'}</th>
      {onRemove && <th scope="col"><span className="sr-only">Aktionen</span></th>}
    </tr></thead><tbody>{sorted.map(item => <tr key={item.instrument.id}>
      <th scope="row"><Link className="stock-identity" to={instrumentPath(item.instrument.id)}><strong>{item.instrument.name}</strong><span className="stock-symbol">{item.instrument.symbol} · {item.instrument.exchange}</span></Link></th>
      <td>{money(item.quote?.price, item.quote?.currency ?? item.instrument.currency)}<TableQuoteTimestamp quote={item.quote} sources={sources} /></td>
      <td>{item.instrument.currency}</td><td><div><ChangeValue value={item.quote?.change ?? null} currency={item.quote?.currency ?? item.instrument.currency} /></div><ChangeValue value={item.quote?.changePercent ?? null} percent /></td>
      {onRemove && <td className="stock-actions">{remove(item)}</td>}
    </tr>)}</tbody></table><TableDataSources sources={sources} /></div>
    <div className="stock-cards">
      {sortable && <div className="stock-sort" role="group" aria-label="Aktien sortieren"><button type="button" className="button button-secondary" onClick={() => sort('name')} aria-label={sortLabel('name')} aria-pressed={sortField === 'name'}>Name{sortIndicator('name')}</button><button type="button" className="button button-secondary" onClick={() => sort('change')} aria-label={sortLabel('change')} aria-pressed={sortField === 'change'}>Tagesveränderung{sortIndicator('change')}</button></div>}
      {sorted.map(item => <article key={item.instrument.id} className="stock-card">
        <Link className="stock-identity" to={instrumentPath(item.instrument.id)}><strong>{item.instrument.name}</strong><span className="stock-symbol">{item.instrument.symbol} · {item.instrument.exchange} · {item.instrument.currency}</span></Link>
        <div className="stock-card-values"><strong>{money(item.quote?.price, item.quote?.currency ?? item.instrument.currency)}</strong><div><ChangeValue value={item.quote?.change ?? null} currency={item.quote?.currency ?? item.instrument.currency} /> <ChangeValue value={item.quote?.changePercent ?? null} percent /></div></div>
        <DataSourceNote meta={item.quote?.meta} asOf={item.quote?.asOf} />{remove(item)}
      </article>)}
    </div>
  </div>;
}
