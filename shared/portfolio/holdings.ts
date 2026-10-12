import type { Holding, Transaction } from "../types";
import { compareTransactions, EPSILON } from "./common";

/** Rechnet ohne Zwischenrundung; Kaufgebühren gehören zum offenen Einstand. */
export function computeHoldings(transactions: Transaction[]): Holding[] {
  const holdings = new Map<string, Holding>();

  for (const transaction of [...transactions].sort(compareTransactions)) {
    let holding = holdings.get(transaction.instrumentId);
    if (!holding) {
      holding = {
        instrumentId: transaction.instrumentId,
        instrument: transaction.instrument,
        currency: transaction.currency,
        quantity: 0,
        costBasis: 0,
        averageCost: null,
        realizedPnl: 0,
        dividends: 0,
        totalFees: 0,
        transactionCount: 0,
      };
      holdings.set(transaction.instrumentId, holding);
    }

    holding.instrument = transaction.instrument;
    holding.transactionCount += 1;

    if (transaction.type === "BUY") {
      holding.totalFees += transaction.fees;
      holding.quantity += transaction.quantity;
      holding.costBasis += transaction.quantity * transaction.price + transaction.fees;
    } else if (transaction.type === "SPLIT") {
      holding.quantity *= transaction.ratio!;
    } else if (transaction.type === "DIVIDEND") {
      holding.dividends += transaction.quantity * transaction.price - transaction.fees;
    } else if (transaction.type === "SELL") {
      holding.totalFees += transaction.fees;
      const averageCost = holding.quantity === 0 ? 0 : holding.costBasis / holding.quantity;
      const soldCostBasis = averageCost * transaction.quantity;
      holding.realizedPnl += transaction.quantity * transaction.price - transaction.fees - soldCostBasis;
      holding.costBasis -= soldCostBasis;
      holding.quantity -= transaction.quantity;

      // Ein Verkauf aller Bruchstücke kann binäre Rechenreste hinterlassen.
      if (Math.abs(holding.quantity) < EPSILON) {
        holding.quantity = 0;
        holding.costBasis = 0;
      }
    }
    holding.averageCost = holding.quantity === 0 ? null : holding.costBasis / holding.quantity;
  }

  return [...holdings.values()];
}
