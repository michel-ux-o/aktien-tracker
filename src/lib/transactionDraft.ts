import type { Transaction, TransactionInput, TransactionType } from '@shared/types';
import { computeHoldings, validateTransactionSequence } from '@shared/portfolio';

type DraftIdentity = Pick<Transaction, 'id' | 'createdAt'>;
type OrderedTransaction = Pick<Transaction, 'id' | 'instrumentId' | 'type' | 'date' | 'createdAt'>;

const typeOrder: Record<TransactionType, number> = { SPLIT: 0, BUY: 1, DIVIDEND: 2, SELL: 3 };
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Entfernt lediglich binäre Rechenreste; echte zusätzliche Nachkommastellen bleiben prüfbar. */
export function calculateSplitRatio(newPieces: number | null, oldPieces: number | null): number | null {
  if (newPieces == null || oldPieces == null || !Number.isFinite(newPieces) || !Number.isFinite(oldPieces) || newPieces <= 0 || oldPieces <= 0) return null;
  const ratio = newPieces / oldPieces;
  if (!Number.isFinite(ratio)) return null;
  const rounded = Number(ratio.toFixed(8));
  return Math.abs(ratio - rounded) <= Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4 ? rounded : ratio;
}

function compareTransactions(left: OrderedTransaction, right: OrderedTransaction): number {
  return compareText(left.date, right.date)
    || typeOrder[left.type] - typeOrder[right.type]
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id);
}

/** Bestand unmittelbar vor dem Entwurf; berücksichtigt die gemeinsame Tagesreihenfolge. */
export function quantityBeforeTransaction(transactions: readonly Transaction[], draft: OrderedTransaction): number {
  const preceding = transactions.filter(item => item.instrumentId === draft.instrumentId && item.id !== draft.id && compareTransactions(item, draft) < 0);
  return computeHoldings(preceding).find(holding => holding.instrumentId === draft.instrumentId)?.quantity ?? 0;
}

/** Beim Bearbeiten wird die alte Transaktion ersetzt, damit auch spätere Verkäufe geprüft werden. */
export function validateTransactionDraftSequence(transactions: readonly Transaction[], input: TransactionInput, identity: DraftIdentity) {
  const result = validateTransactionSequence([
    ...transactions.filter(item => item.instrumentId === input.instrument.id && item.id !== identity.id),
    { ...identity, type: input.type, date: input.date, quantity: input.quantity, ratio: input.ratio ?? null },
  ]);
  if (!result.ok) return result;
  const previous = transactions.find(item => item.id === identity.id);
  if (previous && previous.instrumentId !== input.instrument.id) {
    return validateTransactionSequence(transactions.filter(item => item.instrumentId === previous.instrumentId && item.id !== identity.id));
  }
  return result;
}
