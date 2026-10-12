import type { DataMeta } from '@shared/types';
import { dateTime } from '../lib/format';

export function dataSourceDelay(meta: DataMeta): string {
  return meta.delayNote || (meta.delayMinutes == null
    ? 'Verzögerung der Kursdaten unbekannt.'
    : meta.delayMinutes > 0 ? `Kursdaten um bis zu ${meta.delayMinutes} Minuten verzögert.` : 'Keine bekannte Verzögerung.');
}

export function DataSourceNote({ meta, asOf }: { meta?: DataMeta | null; asOf?: string | null }) {
  if (!meta) return <p className="data-source-note">Datenquelle und Datenstand nicht verfügbar.</p>;
  const delay = dataSourceDelay(meta);
  return <p className="data-source-note">
    {meta.source} · {asOf ? `Kursstand ${dateTime(asOf)}` : `Abgerufen ${dateTime(meta.fetchedAt)}`}
    {asOf === null && ' · Kurszeitpunkt nicht verfügbar'} · {delay}
  </p>;
}
