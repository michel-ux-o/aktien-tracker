import type { TransactionType } from '@shared/types';

const unavailable = 'Nicht verfügbar';
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

export function money(value: number | null | undefined, currency = 'EUR'): string {
  if (!finite(value)) return unavailable;
  try { return new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
  catch { return `${number(value)} ${currency}`; }
}
export function number(value: number | null | undefined, maxDigits = 2): string {
  return finite(value) ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: maxDigits }).format(value) : unavailable;
}
export function percent(value: number | null | undefined, signed = false): string {
  return finite(value) ? new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: signed ? 'always' : 'auto' }).format(value / 100).replace(/-/g, '−') : unavailable;
}
function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const result = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(result.getTime()) ? null : result;
}
export function date(value: string | null | undefined): string {
  const parsed = validDate(value);
  return parsed ? new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed) : unavailable;
}
export function dateTime(value: string | null | undefined): string {
  const parsed = validDate(value);
  return parsed ? `${new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed)} Uhr` : unavailable;
}
/** Formulare akzeptieren Dezimalkomma oder Dezimalpunkt, aber keine mehrdeutigen Tausendertrennzeichen. */
export function parseDecimal(input: string): number | null {
  const normalized = input.trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(normalized)) return null;
  const result = Number(normalized.replace(',', '.'));
  return Number.isFinite(result) ? result : null;
}
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function instrumentPath(id: string): string { return `/aktie/${encodeURIComponent(id)}`; }

export function formatTransactionType(type: TransactionType): string {
  const labels: Record<TransactionType, string> = { BUY: 'Kauf', SELL: 'Verkauf', DIVIDEND: 'Dividende', SPLIT: 'Split' };
  return labels[type];
}

/** Neue : alte Stücke; einfache Zusammenlegungen erscheinen z. B. als 1 : 10. */
export function formatSplitRatio(ratio: number | null | undefined): string {
  if (!finite(ratio) || ratio <= 0) return unavailable;
  const inverse = 1 / ratio;
  if (ratio < 1 && Number.isInteger(inverse)) return `1 : ${number(inverse, 0)}`;
  return `${number(ratio, 8)} : 1`;
}
