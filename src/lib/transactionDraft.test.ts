import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction, TransactionInput } from '@shared/types';
import { calculateSplitRatio, quantityBeforeTransaction, validateTransactionDraftSequence } from './transactionDraft';

const instrument: Instrument = { id: 'TEST:XETR', symbol: 'TEST', name: 'Test', exchange: 'Xetra', mic: 'XETR', currency: 'EUR', country: null, type: null };
const identity = { id: 'draft', createdAt: '2026-01-03T12:00:00Z' };
function transaction(id: string, type: Transaction['type'], date: string, quantity: number, ratio: number | null = null): Transaction {
  return { id, type, date, quantity, ratio, instrument, instrumentId: instrument.id, price: type === 'SPLIT' ? 0 : 10, fees: 0, currency: 'EUR', note: null, createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:00:00Z' };
}
const draft = (date: string, type: Transaction['type']) => ({ ...identity, instrumentId: instrument.id, date, type });
const input = (patch: Partial<TransactionInput> = {}): TransactionInput => ({ instrument, type: 'DIVIDEND', date: '2026-01-02', quantity: 10, price: 1, fees: 0, currency: 'EUR', ratio: null, ...patch });

describe('Split-Verhältnis aus neu : alt', () => {
  it('berechnet Splits und Zusammenlegungen und entfernt reine binäre Rechenreste', () => {
    expect(calculateSplitRatio(4, 1)).toBe(4);
    expect(calculateSplitRatio(1, 10)).toBe(0.1);
    expect(calculateSplitRatio(0.3, 3)).toBe(0.1);
  });

  it('rundet periodische Verhältnisse nicht unbemerkt und verwirft ungültige Eingaben', () => {
    expect(calculateSplitRatio(1, 3)).toBe(1 / 3);
    expect(calculateSplitRatio(null, 1)).toBeNull();
    expect(calculateSplitRatio(1, 0)).toBeNull();
    expect(calculateSplitRatio(-1, 1)).toBeNull();
    expect(calculateSplitRatio(Infinity, 1)).toBeNull();
  });
});

describe('historischer Bestand im Transaktionsformular', () => {
  it('berücksichtigt historische Splits, aber keine späteren Verkäufe oder fremden Instrumente', () => {
    const transactions = [transaction('buy', 'BUY', '2026-01-01', 10), transaction('split', 'SPLIT', '2026-01-02', 0, 4), transaction('sell', 'SELL', '2026-01-04', 5), { ...transaction('other', 'BUY', '2026-01-01', 100), instrumentId: 'OTHER:XETR' }];
    expect(quantityBeforeTransaction(transactions, draft('2026-01-03', 'DIVIDEND'))).toBe(40);
    expect(quantityBeforeTransaction(transactions, draft('2025-12-31', 'DIVIDEND'))).toBe(0);
  });

  it('zählt am Dividendendatum Splits und Käufe vor Verkäufen', () => {
    const transactions = [transaction('buy', 'BUY', '2026-01-01', 10), transaction('sell', 'SELL', '2026-01-02', 20), transaction('split', 'SPLIT', '2026-01-02', 0, 2), transaction('same-day-buy', 'BUY', '2026-01-02', 3)];
    expect(quantityBeforeTransaction(transactions, draft('2026-01-02', 'DIVIDEND'))).toBe(23);
    expect(quantityBeforeTransaction(transactions, draft('2026-01-02', 'SPLIT'))).toBe(20);
  });

  it('wendet einen bearbeiteten Split für die Vorschau nicht erneut an', () => {
    const split = transaction('split', 'SPLIT', '2026-01-02', 0, 4);
    expect(quantityBeforeTransaction([transaction('buy', 'BUY', '2026-01-01', 10), split], split)).toBe(10);
  });

  it('beachtet beim Bearbeiten die Reihenfolge mehrerer Splits desselben Tages', () => {
    const first = transaction('first', 'SPLIT', '2026-01-02', 0, 2);
    const second = { ...transaction('second', 'SPLIT', '2026-01-02', 0, 3), createdAt: '2026-01-02T12:00:00Z' };
    expect(quantityBeforeTransaction([transaction('buy', 'BUY', '2026-01-01', 10), second, first], second)).toBe(20);
  });
});

describe('Sequenzprüfung im Transaktionsformular', () => {
  it('erlaubt eine Dividende mit Kauf am selben Tag', () => {
    expect(validateTransactionDraftSequence([transaction('buy', 'BUY', '2026-01-02', 10)], input(), identity)).toEqual({ ok: true });
  });

  it('prüft auch durch eine Änderung ungültig gewordene spätere Verkäufe', () => {
    const transactions = [transaction('buy', 'BUY', '2026-01-01', 10), transaction('sell', 'SELL', '2026-01-03', 10)];
    expect(validateTransactionDraftSequence(transactions, input({ type: 'BUY', date: '2026-01-01', quantity: 5 }), { ...identity, id: 'buy' })).toMatchObject({ ok: false, transactionId: 'sell' });
  });

  it('prüft die neue Splitmenge vor späteren Verkäufen und ignoriert fremde Instrumente', () => {
    const transactions = [transaction('buy', 'BUY', '2026-01-01', 10), transaction('split', 'SPLIT', '2026-01-02', 0, 4), transaction('sell', 'SELL', '2026-01-03', 30), { ...transaction('other', 'SELL', '2026-01-01', 100), instrumentId: 'OTHER:XETR' }];
    expect(validateTransactionDraftSequence(transactions, input({ type: 'SPLIT', quantity: 0, price: 0, ratio: 2 }), { ...identity, id: 'split' })).toMatchObject({ ok: false, transactionId: 'sell' });
    expect(validateTransactionDraftSequence(transactions, input({ type: 'SPLIT', quantity: 0, price: 0, ratio: 4 }), { ...identity, id: 'split' })).toEqual({ ok: true });
  });

  it('prüft beim Wechsel des Wertpapiers auch die Folge des vorherigen Wertpapiers', () => {
    const transactions = [transaction('buy', 'BUY', '2026-01-01', 10), transaction('sell', 'SELL', '2026-01-03', 10)];
    const otherInstrument = { ...instrument, id: 'OTHER:XETR', symbol: 'OTHER' };
    expect(validateTransactionDraftSequence(transactions, input({ instrument: otherInstrument, type: 'BUY', date: '2026-01-01' }), { ...identity, id: 'buy' })).toMatchObject({ ok: false, transactionId: 'sell' });
  });
});
