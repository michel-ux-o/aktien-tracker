import type { Currency, InstrumentId, Transaction } from "../types";
import { compareTransactions, EPSILON, lookupConversion } from "./common";
import type { FxLookup } from "./index";

/** Paralleler Durchschnittseinstand und Zahlungsströme zu historischen Wechselkursen. */
export interface BaseLedgerEntry {
  quantity: number;
  costBasisBase: number | null;
  realizedPnlBase: number | null;
  dividendsBase: number | null;
  missingFx: boolean;
}

/** Ein fehlender Transaktionskurs macht alle Basis-Ergebnisse dieses Wertpapiers unbekannt. */
export function computeBaseLedger(
  transactions: Transaction[],
  baseCurrency: Currency,
  fx: FxLookup,
): Map<InstrumentId, BaseLedgerEntry> {
  const entries = new Map<InstrumentId, BaseLedgerEntry>();
  const factors = new Map<Currency, Map<string, number | null>>();

  for (const transaction of [...transactions].sort(compareTransactions)) {
    let entry = entries.get(transaction.instrumentId);
    if (!entry) {
      entry = { quantity: 0, costBasisBase: 0, realizedPnlBase: 0, dividendsBase: 0, missingFx: false };
      entries.set(transaction.instrumentId, entry);
    }

    if (transaction.type === "SPLIT") {
      entry.quantity *= transaction.ratio!;
      continue;
    }

    let currencyFactors = factors.get(transaction.currency);
    if (!currencyFactors) {
      currencyFactors = new Map<string, number | null>();
      factors.set(transaction.currency, currencyFactors);
    }
    let factor = currencyFactors.get(transaction.date);
    if (factor === undefined) {
      factor = lookupConversion(transaction.currency, baseCurrency, fx, transaction.date).factor;
      currencyFactors.set(transaction.date, factor);
    }
    if (factor === null) {
      entry.missingFx = true;
      entry.costBasisBase = null;
      entry.realizedPnlBase = null;
      entry.dividendsBase = null;
    }

    if (transaction.type === "BUY") {
      entry.quantity += transaction.quantity;
      if (!entry.missingFx && factor !== null) {
        entry.costBasisBase! += (transaction.quantity * transaction.price + transaction.fees) * factor;
      }
    } else if (transaction.type === "SELL") {
      if (!entry.missingFx && factor !== null) {
        const soldCostBasis = entry.quantity === 0 ? 0 : (entry.costBasisBase! / entry.quantity) * transaction.quantity;
        entry.realizedPnlBase! += (transaction.quantity * transaction.price - transaction.fees) * factor - soldCostBasis;
        entry.costBasisBase! -= soldCostBasis;
      }
      entry.quantity -= transaction.quantity;
      // Nur ein Verkauf kann einen Rechenrest hinterlassen; Zusammenlegungen dürfen kleinste Bestände behalten.
      if (Math.abs(entry.quantity) < EPSILON) {
        entry.quantity = 0;
        if (!entry.missingFx) entry.costBasisBase = 0;
      }
    } else if (!entry.missingFx && factor !== null) {
      entry.dividendsBase! += (transaction.quantity * transaction.price - transaction.fees) * factor;
    }
  }

  return entries;
}
