import type { DataMeta } from '@shared/types';
import { dateTime } from '../lib/format';
import { dataSourceDelay } from './DataSourceNote';

interface TableQuoteData {
  meta?: DataMeta | null;
  asOf?: string | null;
}

interface TableDataSource {
  source: string | null;
  delay: string | null;
}

function sourceKey(meta?: DataMeta | null): string {
  return meta ? JSON.stringify([meta.source, dataSourceDelay(meta)]) : 'unavailable';
}

export function tableDataSources(quotes: (TableQuoteData | null | undefined)[]): TableDataSource[] {
  return Array.from(new Map(quotes.map((quote) => [sourceKey(quote?.meta), {
    source: quote?.meta?.source ?? null,
    delay: quote?.meta ? dataSourceDelay(quote.meta) : null,
  }])).values());
}

export function TableQuoteTimestamp({ quote, sources }: { quote?: TableQuoteData | null; sources: TableDataSource[] }) {
  const reference = sources.length > 1 ? ` [${sources.findIndex((source) => source.source === (quote?.meta?.source ?? null) && source.delay === (quote?.meta ? dataSourceDelay(quote.meta) : null)) + 1}]` : '';
  return <span className="table-secondary">{quote?.asOf
    ? `Stand ${dateTime(quote.asOf)}`
    : quote?.meta ? `Abruf ${dateTime(quote.meta.fetchedAt)} · Kurszeit unbekannt` : 'Datenstand nicht verfügbar'}{reference}</span>;
}

export function TableDataSources({ sources }: { sources: TableDataSource[] }) {
  const commonSource = sources[0]?.source;
  const sameSource = commonSource != null && sources.every((source) => source.source === commonSource);
  return <p className="data-source-note table-data-source-note">
    {sameSource && <>Datenquelle: {commonSource} · </>}
    {sources.map((source, index) => <span key={index}>{index > 0 && ' · '}{sources.length > 1 && `[${index + 1}] `}{source.source == null
      ? 'Datenquelle nicht verfügbar.'
      : <>{!sameSource && `${source.source} · `}{source.delay}</>}</span>)}
  </p>;
}
