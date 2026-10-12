import { HISTORY_RANGES } from '@shared/types';
import type { HistoryRange } from '@shared/types';

const rangeLabels: Record<HistoryRange, string> = {
  '1W': '1 Woche', '1M': '1 Monat', '3M': '3 Monate', '6M': '6 Monate', '1Y': '1 Jahr', '5Y': '5 Jahre', MAX: 'Gesamter Zeitraum',
};

export function ChartRange({ range, onRangeChange, supportedRanges }: {
  range: HistoryRange; onRangeChange: (range: HistoryRange) => void; supportedRanges?: readonly HistoryRange[];
}) {
  return <div className="chart-range" role="group" aria-label="Zeitraum des Diagramms">
    {HISTORY_RANGES.map(item => <button key={item} type="button" aria-label={rangeLabels[item]} aria-pressed={item === range}
      disabled={supportedRanges != null && !supportedRanges.includes(item)} onClick={() => onRangeChange(item)}>{item}</button>)}
  </div>;
}
