import type { Currency, FxRate, TransactionType } from "../types";
import type { FxLookup, SequenceItem } from "./index";

export const EPSILON = 1e-9;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const transactionOrder: Record<TransactionType, number> = { SPLIT: 0, BUY: 1, DIVIDEND: 2, SELL: 3 };

/** Einheitliche Reihenfolge für Prüfung, Einstand und historische Bestände. */
export function compareTransactions(a: SequenceItem, b: SequenceItem): number {
  return (
    compareText(a.date, b.date) ||
    transactionOrder[a.type] - transactionOrder[b.type] ||
    compareText(a.createdAt, b.createdAt) ||
    compareText(a.id, b.id)
  );
}

export function lookupConversion(
  currency: Currency,
  baseCurrency: Currency,
  fx: FxLookup,
  date: string | null = null,
): { factor: number | null; rate: FxRate | null } {
  // In der Basiswährung ist keine externe Kursangabe nötig: Faktor 1, fxRate null.
  if (currency === baseCurrency) return { factor: 1, rate: null };
  const rate = fx(currency, baseCurrency, date);
  if (
    rate === null ||
    rate.from !== currency ||
    rate.to !== baseCurrency ||
    !Number.isFinite(rate.rate) ||
    rate.rate <= 0
  ) {
    return { factor: null, rate: null };
  }
  return { factor: rate.rate, rate };
}
