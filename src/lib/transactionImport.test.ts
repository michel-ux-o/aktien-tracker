import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction, TransactionInput } from '@shared/types';
import { buildImportPreview, mapImportFieldErrors, selectedImportRows, validateImportSequence } from './transactionImport';

const instrument: Instrument = {
  id: 'SAP:XETR', symbol: 'SAP', name: 'SAP SE', mic: 'XETR', exchange: 'XETRA',
  currency: 'EUR', country: 'Deutschland', type: 'Common Stock',
};
const input = (overrides: Partial<TransactionInput> = {}): TransactionInput => ({
  instrument, type: 'BUY', date: '2024-01-10', quantity: 10, price: 100, fees: 2,
  currency: 'EUR', ratio: null, note: null, ...overrides,
});
const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  ...input(), ratio: null, note: null, id: 'existing', instrumentId: instrument.id,
  createdAt: '2024-01-10T12:00:00.000Z', updatedAt: '2024-01-10T12:00:00.000Z', ...overrides,
});
const row = (lineNumber: number, value: TransactionInput | null, errors: string[] = []) => ({ lineNumber, input: value, errors });

describe('CSV-Importvorschau', () => {
  it('erkennt vorhandene und frühere Datei-Zeilen anhand aller vereinbarten Felder', () => {
    const dividend = input({ type: 'DIVIDEND', date: '2024-02-01', price: 2, fees: 0 });
    const rows = buildImportPreview([
      row(2, input({ note: 'Andere Notiz', instrument: { ...instrument, name: 'Anderer Name' } })),
      row(3, dividend), row(4, { ...dividend }),
      row(5, input({ quantity: 9 })), row(6, input({ price: 101 })),
      row(7, input({ fees: 3 })), row(8, input({ date: '2024-01-11' })),
      row(9, input({ type: 'SELL' })),
      row(10, input({ instrument: { ...instrument, id: 'SAP:XNAS', mic: 'XNAS' } })),
    ], [transaction()]);
    expect(rows.map(item => item.duplicate)).toEqual([true, false, true, false, false, false, false, false, false]);
    expect(selectedImportRows(rows, false).map(item => item.lineNumber)).toEqual([3, 5, 6, 7, 8, 9, 10]);
    expect(selectedImportRows(rows, true)).toHaveLength(9);
  });

  it('unterscheidet Split-Verhältnisse und behandelt fehlendes ratio wie null', () => {
    const split = input({ type: 'SPLIT', date: '2024-02-01', quantity: 0, price: 0, fees: 0, ratio: 4 });
    const rows = buildImportPreview([
      row(2, input({ ratio: undefined })), row(3, split), row(4, { ...split }), row(5, { ...split, ratio: 0.1 }),
    ], [transaction()]);
    expect(rows.map(item => item.duplicate)).toEqual([true, false, true, false]);
  });

  it('schließt fehlerhafte Zeilen auch bei aktivierter Duplikatoption aus', () => {
    const rows = buildImportPreview([row(2, null, ['Datum ungültig']), row(3, input(), ['Preis ungültig']), row(4, input())], []);
    expect(rows.map(item => item.duplicate)).toEqual([false, false, false]);
    expect(selectedImportRows(rows, true).map(item => item.lineNumber)).toEqual([4]);
  });
});

describe('CSV-Import mit Bestandsprüfung', () => {
  it('prüft den ganzen Batch chronologisch mit Splits, Dividenden und bisherigen Käufen', () => {
    const rows = selectedImportRows(buildImportPreview([
      row(2, input({ type: 'SELL', date: '2024-03-01', quantity: 40 })),
      row(3, input({ type: 'DIVIDEND', date: '2024-02-10', quantity: 40, price: 1, fees: 0 })),
      row(4, input({ type: 'SPLIT', date: '2024-02-01', quantity: 0, price: 0, fees: 0, ratio: 4 })),
    ], [transaction()]), false);
    expect(validateImportSequence(rows, [transaction()])).toEqual([]);
  });

  it('ordnet Fehler der ursprünglichen Dateizeile zu', () => {
    const rows = selectedImportRows(buildImportPreview([
      row(5, input({ type: 'SELL', date: '2024-02-01', quantity: 11 })),
    ], []), false);
    expect(validateImportSequence(rows, [transaction()])).toEqual([
      { lineNumber: 5, message: 'SAP SE: Verkauf am 01.02.2024 übersteigt den Bestand (verfügbar: 10 Stück).' },
    ]);
  });

  it('verhindert einen rückdatierten Import, der einen vorhandenen späteren Verkauf ungültig macht', () => {
    const existing = [transaction(), transaction({ id: 'sell', type: 'SELL', date: '2024-03-01', quantity: 10 })];
    const rows = selectedImportRows(buildImportPreview([
      row(2, input({ type: 'SPLIT', date: '2024-02-01', quantity: 0, price: 0, fees: 0, ratio: 0.1 })),
    ], existing), false);
    expect(validateImportSequence(rows, existing)).toEqual([
      { lineNumber: null, message: 'SAP SE: Verkauf am 01.03.2024 übersteigt den Bestand (verfügbar: 1 Stück).' },
    ]);
  });

  it('vermengt Bestände verschiedener Wertpapiere nicht', () => {
    const other: Instrument = { ...instrument, id: 'AAPL:XNAS', symbol: 'AAPL', name: 'Apple', mic: 'XNAS' };
    const rows = selectedImportRows(buildImportPreview([
      row(2, input({ instrument: other, type: 'SELL', date: '2024-02-01', quantity: 1 })),
    ], []), false);
    expect(validateImportSequence(rows, [transaction()])[0]).toMatchObject({ lineNumber: 2 });
    expect(validateImportSequence(rows, [transaction()])[0]?.message).toContain('Apple:');
  });

  it('prüft die tatsächlich gewählte Duplikatauswahl', () => {
    const existing = [transaction()];
    const rows = buildImportPreview([
      row(2, input()), row(3, input({ type: 'SELL', date: '2024-02-01', quantity: 20 })),
    ], existing);
    expect(validateImportSequence(selectedImportRows(rows, false), existing)).toHaveLength(1);
    expect(validateImportSequence(selectedImportRows(rows, true), existing)).toEqual([]);
  });
});

describe('CSV-Serverfehler', () => {
  it('führt Request-Indizes nach übersprungenen Zeilen auf die richtige CSV-Zeile zurück', () => {
    expect(mapImportFieldErrors({
      'rows.0.quantity': 'Zu viele Stücke.', 'rows.1.instrument.currency': 'Währung ungültig.',
      'rows.1.ratio': 'Verhältnis ungültig.', transactions: 'Import ungültig.',
    }, [{ lineNumber: 4 }, { lineNumber: 8 }])).toEqual({
      rows: [
        { lineNumber: 4, message: 'Stückzahl: Zu viele Stücke.' },
        { lineNumber: 8, message: 'Wertpapier: Währung ungültig.' },
        { lineNumber: 8, message: 'Verhältnis: Verhältnis ungültig.' },
      ],
      general: ['Import ungültig.'],
    });
  });

  it('zeigt unbekannte oder nicht zuordenbare Felder weiterhin an', () => {
    expect(mapImportFieldErrors({ 'rows.99.quantity': 'Nicht zuordenbar.', importId: 'Kennung fehlt.' }, [{ lineNumber: 2 }]))
      .toEqual({ rows: [], general: ['Nicht zuordenbar.', 'Kennung fehlt.'] });
  });
});
