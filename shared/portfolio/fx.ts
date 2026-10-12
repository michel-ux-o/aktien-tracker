import type { Currency, FxPoint, FxRate } from "../types";
import type { FxLookup } from "./index";

/** Sucht in einer aufsteigend sortierten Kopie; historische Lücken werden nie mit aktuellen Kursen gefüllt. */
export function createFxLookup(args: {
  baseCurrency: Currency;
  current: Record<Currency, FxRate | null>;
  histories: Record<Currency, FxPoint[]>;
  source: string;
}): FxLookup {
  const { baseCurrency, current, histories, source } = args;
  const sortedHistories = new Map<Currency, FxPoint[]>(
    Object.entries(histories).map(([currency, points]) => [
      currency,
      [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    ]),
  );

  return (from, to, date) => {
    if (to !== baseCurrency) return null;
    if (date === null) {
      const rate = current[from] ?? null;
      return rate !== null && rate.from === from && rate.to === to && Number.isFinite(rate.rate) && rate.rate > 0
        ? rate
        : null;
    }

    const points = sortedHistories.get(from) ?? [];
    let lower = 0;
    let upper = points.length - 1;
    let result: FxPoint | undefined;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const point = points[middle]!;
      if (point.date <= date) {
        result = point;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    return result && Number.isFinite(result.rate) && result.rate > 0
      ? { from, to, rate: result.rate, asOf: result.date, source }
      : null;
  };
}
