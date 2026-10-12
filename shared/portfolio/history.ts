import type {
  Currency,
  DataMeta,
  HistoryRange,
  Holding,
  InstrumentId,
  PortfolioHistory,
  PricePoint,
  Transaction,
} from "../types";
import { compareTransactions, lookupConversion } from "./common";
import { computeBaseLedger, type BaseLedgerEntry } from "./base-ledger";
import { computeHoldings } from "./holdings";
import type { FxLookup } from "./index";

/** Kalenderzeiträume werden am Monatsende auf den letzten gültigen Tag gekürzt. */
export function rangeStartDate(range: HistoryRange, today: string): string | null {
  if (range === "MAX") return null;

  const date = new Date(`${today}T00:00:00.000Z`);
  if (range === "1W") {
    date.setUTCDate(date.getUTCDate() - 7);
  } else {
    const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "5Y": 60 }[range];
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - months);
    const endOfMonth = new Date(date);
    endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1);
    endOfMonth.setUTCDate(0);
    date.setUTCDate(Math.min(originalDay, endOfMonth.getUTCDate()));
  }
  return date.toISOString().slice(0, 10);
}

/** Sucht auch außerhalb des sichtbaren Zeitraums nach dem letzten bekannten Kurs. */
function closeOnOrBefore(points: PricePoint[], date: string): number | null {
  let lower = 0;
  let upper = points.length - 1;
  let result: number | null = null;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const point = points[middle]!;
    if (point.date <= date) {
      result = point.close;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return result;
}

export function computePortfolioHistory(args: {
  transactions: Transaction[];
  histories: Record<InstrumentId, PricePoint[]>;
  baseCurrency: Currency;
  fx: FxLookup;
  range: HistoryRange;
  today: string;
  meta: DataMeta;
}): PortfolioHistory {
  const { transactions, histories, baseCurrency, fx, range, today, meta } = args;
  const result: PortfolioHistory = {
    range,
    baseCurrency,
    points: [],
    complete: true,
    notes: [],
    meta,
  };
  if (transactions.length === 0) return result;

  const orderedTransactions = [...transactions].sort(compareTransactions);
  const firstTransactionDate = orderedTransactions[0]!.date;
  const rangeStart = rangeStartDate(range, today);
  const start = rangeStart && rangeStart > firstTransactionDate ? rangeStart : firstTransactionDate;
  if (start > today) return result;

  const sortedHistories = new Map<InstrumentId, PricePoint[]>();
  const axisDates = new Set<string>();
  for (const [instrumentId, history] of Object.entries(histories)) {
    // Die Eingaben bleiben unverändert; ungültige Kurswerte sind keine Bewertung.
    const points = history
      .filter((point) => Number.isFinite(point.close) && point.close >= 0)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    sortedHistories.set(instrumentId, points);
    for (const point of history) {
      if (point.date >= start && point.date <= today) axisDates.add(point.date);
    }
  }
  const dates = [...axisDates].sort();
  // Auch eine vollständig fehlende Historie soll als Einschränkung sichtbar sein.
  // Diese Prüfdatumswerte erzeugen ausdrücklich keine zusätzlichen Diagrammpunkte.
  const evaluationDates = dates.length > 0
    ? dates
    : [...new Set([
      start,
      today,
      ...orderedTransactions.filter((transaction) => transaction.date >= start && transaction.date <= today)
        .map((transaction) => transaction.date),
    ])].sort();

  const notes = new Set<string>();
  const splits = new Map<InstrumentId, Transaction[]>();
  for (const transaction of orderedTransactions) {
    if (transaction.type !== "SPLIT") continue;
    const instrumentSplits = splits.get(transaction.instrumentId) ?? [];
    instrumentSplits.push(transaction);
    splits.set(transaction.instrumentId, instrumentSplits);
  }
  let processedTransactionCount = 0;
  let holdings: Holding[] = [];
  let baseLedger = new Map<InstrumentId, BaseLedgerEntry>();

  for (const date of evaluationDates) {
    const previousCount = processedTransactionCount;
    while (processedTransactionCount < orderedTransactions.length
      && orderedTransactions[processedTransactionCount]!.date <= date) {
      processedTransactionCount += 1;
    }
    if (previousCount !== processedTransactionCount) {
      const appliedTransactions = orderedTransactions.slice(0, processedTransactionCount);
      holdings = computeHoldings(appliedTransactions);
      const openInstrumentIds = new Set(holdings.filter((holding) => holding.quantity > 0)
        .map((holding) => holding.instrumentId));
      // Geschlossene Positionen brauchen für diesen Tageswert keinen historischen FX.
      baseLedger = computeBaseLedger(appliedTransactions.filter((transaction) =>
        openInstrumentIds.has(transaction.instrumentId)), baseCurrency, fx);
    }

    const conversions = new Map<Currency, ReturnType<typeof lookupConversion>>();
    let marketValue = 0;
    let investedCapital = 0;
    let dayComplete = true;
    for (const holding of holdings) {
      if (holding.quantity <= 0) continue;
      let conversion = conversions.get(holding.currency);
      if (!conversion) {
        conversion = lookupConversion(holding.currency, baseCurrency, fx, date);
        conversions.set(holding.currency, conversion);
      }
      const entry = baseLedger.get(holding.instrumentId)!;
      if (conversion.factor === null || entry.missingFx) {
        notes.add(`Für ${holding.currency} fehlt der Wechselkurs nach ${baseCurrency} an mindestens einem historischen Tag; die historischen Werte sind unvollständig.`);
        dayComplete = false;
      }
      if (entry.costBasisBase !== null) investedCapital += entry.costBasisBase;

      const history = sortedHistories.get(holding.instrumentId) ?? [];
      const close = closeOnOrBefore(history, date);
      if (close === null) {
        notes.add(history.length === 0
          ? `Für ${holding.instrument.symbol} liegen keine historischen Kurse vor.`
          : `Für ${holding.instrument.symbol} liegen an einzelnen Tagen vor dem ersten verfügbaren Schlusskurs keine historischen Kurse vor.`);
        dayComplete = false;
      } else if (conversion.factor !== null) {
        // Historische Schlusskurse sind bereits split-bereinigt. Auch Splits nach
        // dem sichtbaren Zeitraum rechnen frühere Bestände auf dieselbe Stückbasis um.
        const laterSplitRatio = (splits.get(holding.instrumentId) ?? [])
          .filter((split) => split.date > date)
          .reduce((ratio, split) => ratio * (split.ratio ?? 1), 1);
        marketValue += holding.quantity * laterSplitRatio * close * conversion.factor;
      }
    }

    if (!dayComplete) result.complete = false;
    if (dates.length > 0) {
      result.points.push({ date, marketValue: dayComplete ? marketValue : null, investedCapital });
    }
  }
  result.notes = [...notes];
  return result;
}
