import { money, percent } from '../lib/format';

export function ChangeValue({ value, percent: isPercent = false, currency = 'EUR', showLabel = false }: {
  value: number | null; percent?: boolean; currency?: string; showLabel?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) return <span className="change-value neutral">Nicht verfügbar</span>;
  const direction = value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
  const label = value > 0 ? 'Gewinn' : value < 0 ? 'Verlust' : 'Unverändert';
  const formatted = isPercent ? percent(Math.abs(value)) : money(Math.abs(value), currency);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return <span className={`change-value ${direction}`} aria-label={`${label}: ${sign}${formatted}`}>
    <span aria-hidden="true">{value > 0 ? '↗' : value < 0 ? '↘' : '→'} {sign}{formatted}</span>
    {showLabel && <span className="change-label" aria-hidden="true"> {label}</span>}
  </span>;
}
