import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_TRANSACTIONS } from '@shared/api';
import type { Transaction, TransactionInput } from '@shared/types';
import { parseTransactionsCsv, transactionsToCsv } from './csv';

const header = 'Datum;Wertpapier;Symbol;Kennung;Vorgang;Stückzahl;Preis;Gebühren;Betrag;Währung;Notiz;Verhältnis';

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'transaction-1',
  instrumentId: 'SAP:XETR',
  instrument: {
    id: 'SAP:XETR',
    name: 'SAP SE',
    symbol: 'SAP',
    exchange: 'XETRA',
    mic: 'XETR',
    currency: 'EUR',
    country: 'DE',
    type: 'Common Stock',
  },
  type: 'BUY',
  date: '2026-02-03',
  quantity: 2,
  price: 10,
  fees: 1,
  currency: 'EUR',
  ratio: null,
  note: null,
  createdAt: '2026-02-03T12:00:00.000Z',
  updatedAt: '2026-02-03T12:00:00.000Z',
  ...overrides,
});

const firstRowFields = (transactions: Transaction[]) => {
  const [, row] = transactionsToCsv(transactions).split('\r\n');
  if (row === undefined) throw new Error('Expected a transaction row');
  return row.split(';');
};

describe('transactionsToCsv', () => {
  it('exports the exact header, German dates and CRLF row separators', () => {
    const csv = transactionsToCsv([
      transaction(),
      transaction({ id: 'transaction-2', date: '2026-12-31' }),
    ]);

    expect(csv).toBe([
      header,
      '03.02.2026;SAP SE;SAP;SAP:XETR;Kauf;2;10;1;21,00;EUR;;',
      '31.12.2026;SAP SE;SAP;SAP:XETR;Kauf;2;10;1;21,00;EUR;;',
    ].join('\r\n'));
  });

  it('returns only the header for an empty list', () => {
    expect(transactionsToCsv([])).toBe(header);
  });

  it('uses decimal commas without thousands separators and preserves price and fee precision', () => {
    const fields = firstRowFields([
      transaction({ quantity: 1234.5, price: 1234.56789123, fees: 12.345678901 }),
    ]);

    expect(fields.slice(5, 8)).toEqual(['1234,5', '1234,56789123', '12,345678901']);
    expect(fields[8]).not.toContain('.');
  });

  it('writes small numbers as decimals instead of exponential notation', () => {
    const fields = firstRowFields([
      transaction({ quantity: 1e-8, price: 1e-7, fees: 1e-9 }),
    ]);

    expect(fields.slice(5, 9)).toEqual(['0,00000001', '0,0000001', '0,000000001', '0,00']);
  });

  it('preserves eight quantity decimal places and omits trailing zeros', () => {
    const csv = transactionsToCsv([
      transaction({ quantity: 1.12345678 }),
      transaction({ id: 'transaction-2', quantity: 2.50000000 }),
      transaction({ id: 'transaction-3', quantity: 3 }),
    ]);

    expect(csv.split('\r\n').slice(1).map((row) => row.split(';')[5])).toEqual([
      '1,12345678', '2,5', '3',
    ]);
  });

  it('adds fees for purchases and subtracts them for sales, rounding amounts to two decimals', () => {
    const csv = transactionsToCsv([
      transaction({ quantity: 2, price: 12.345, fees: 0.6789 }),
      transaction({ id: 'transaction-2', type: 'SELL', quantity: 2, price: 12.345, fees: 0.6789 }),
      transaction({ id: 'transaction-3', quantity: 2, price: 10, fees: 0 }),
    ]);
    const fields = csv.split('\r\n').slice(1).map((row) => row.split(';'));

    expect(fields.map((row) => [row[4], row[8]])).toEqual([
      ['Kauf', '25,37'],
      ['Verkauf', '24,01'],
      ['Kauf', '20,00'],
    ]);
  });

  it('exports net dividends and splits with a ratio instead of amounts', () => {
    const rows = transactionsToCsv([
      transaction({ type: 'DIVIDEND', quantity: 12.5, price: 0.4, fees: 1.25 }),
      transaction({ type: 'SPLIT', quantity: 0, price: 0, fees: 0, ratio: 4 }),
      transaction({ type: 'SPLIT', quantity: 0, price: 0, fees: 0, ratio: 0.1 }),
    ]).split('\r\n').slice(1).map((row) => row.split(';'));

    expect(rows[0]?.slice(4, 9)).toEqual(['Dividende', '12,5', '0,4', '1,25', '3,75']);
    expect(rows[0]?.[11]).toBe('');
    expect(rows[1]?.slice(4, 9)).toEqual(['Split', '', '', '', '']);
    expect(rows[1]?.[11]).toBe('4 : 1');
    expect(rows[2]?.[11]).toBe('1 : 10');
  });

  it('exports the transaction instrument ID and an empty field for a null note', () => {
    const fields = firstRowFields([
      transaction({ instrumentId: 'TRANSACTION:ID', note: null }),
    ]);

    expect(fields[3]).toBe('TRANSACTION:ID');
    expect(fields[10]).toBe('');
  });

  it('quotes semicolons and doubles quotes inside text fields', () => {
    const instrument = { ...transaction().instrument, name: 'SAP; "Software"' };
    const csv = transactionsToCsv([
      transaction({ instrument, note: 'Depot; "langfristig"' }),
    ]);

    expect(csv).toBe(`${header}\r\n03.02.2026;"SAP; ""Software""";SAP;SAP:XETR;Kauf;2;10;1;21,00;EUR;"Depot; ""langfristig""";`);
  });

  it('quotes text fields containing carriage returns or line feeds', () => {
    const instrument = { ...transaction().instrument, name: 'SAP\rSE' };
    const csv = transactionsToCsv([
      transaction({ instrument, note: 'Zeile 1\nZeile 2\r\nZeile 3' }),
    ]);

    expect(csv).toBe(`${header}\r\n03.02.2026;"SAP\rSE";SAP;SAP:XETR;Kauf;2;10;1;21,00;EUR;"Zeile 1\nZeile 2\r\nZeile 3";`);
  });

  it.each(['=', '+', '-', '@'])('prefixes text fields starting with %s with an apostrophe', (prefix) => {
    const instrument = {
      ...transaction().instrument,
      name: `${prefix}name`,
      symbol: `${prefix}symbol`,
    };
    const fields = firstRowFields([
      transaction({
        instrument,
        instrumentId: `${prefix}id`,
        currency: `${prefix}currency`,
        note: `${prefix}note`,
      }),
    ]);

    expect([fields[1], fields[2], fields[3], fields[9], fields[10]]).toEqual([
      `'${prefix}name`, `'${prefix}symbol`, `'${prefix}id`, `'${prefix}currency`, `'${prefix}note`,
    ]);
  });

  it('applies formula protection before CSV quoting', () => {
    const csv = transactionsToCsv([transaction({ note: '=SUM(1;2)' })]);

    expect(csv).toContain(';"\'=SUM(1;2)"');
  });

  it('sorts chronologically without changing the input array or its transactions', () => {
    const transactions = [
      transaction({ id: 'latest', date: '2026-10-11' }),
      transaction({ id: 'earliest', date: '2025-12-31' }),
      transaction({ id: 'middle', date: '2026-02-01' }),
    ];
    const original = structuredClone(transactions);
    const csv = transactionsToCsv(transactions);

    expect(csv.split('\r\n').slice(1).map((row) => row.split(';')[0])).toEqual([
      '31.12.2025', '01.02.2026', '11.10.2026',
    ]);
    expect(transactions).toEqual(original);
  });
});

const csvRow = (overrides: Record<string, string> = {}): string => {
  const values: Record<string, string> = {
    Datum: '03.02.2026',
    Wertpapier: 'SAP SE',
    Symbol: 'SAP',
    Kennung: 'SAP:XETR',
    Vorgang: 'Kauf',
    Stückzahl: '2',
    Preis: '10',
    Gebühren: '1',
    Betrag: '21,00',
    Währung: 'EUR',
    Notiz: '',
    Verhältnis: '',
    ...overrides,
  };
  return header.split(';').map((name) => values[name] ?? '').join(';');
};

const parseRow = (overrides: Record<string, string> = {}) => parseTransactionsCsv(`${header}\r\n${csvRow(overrides)}`);

const asInput = (value: Transaction): TransactionInput => ({
  instrument: value.instrument,
  type: value.type,
  date: value.date,
  quantity: value.quantity,
  price: value.price,
  fees: value.fees,
  currency: value.currency,
  ratio: value.ratio,
  note: value.note,
});

describe('parseTransactionsCsv', () => {
  it('roundtrips all transaction types, precision, escaped text and formula protection', () => {
    const transactions = [
      transaction({
        quantity: 1.12345678,
        price: 1e-7,
        fees: 1e-9,
        instrument: { ...transaction().instrument, name: '=SAP; "Software"' },
        note: '@Notiz; "Text"\r\nZweite Zeile',
      }),
      transaction({ id: 'sale', type: 'SELL', note: '-Verkauf' }),
      transaction({ id: 'dividend', type: 'DIVIDEND', price: 1.25, fees: 0.5, note: '+Gutschrift' }),
      transaction({ id: 'split', type: 'SPLIT', quantity: 0, price: 0, fees: 0, ratio: 4 }),
      transaction({ id: 'reverse', type: 'SPLIT', quantity: 0, price: 0, fees: 0, ratio: 0.1 }),
    ];
    // Existing instrument metadata is used for every row with the same identifier.
    const expectedInstrument = transactions[0]!.instrument;
    const parsed = parseTransactionsCsv(`\uFEFF${transactionsToCsv(transactions)}`, { existingTransactions: transactions });

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => row.errors)).toEqual(transactions.map(() => []));
    expect(parsed.rows.map((row) => row.input)).toEqual(transactions.map((value) => ({ ...asInput(value), instrument: expectedInstrument })));
    expect(parsed.rows.map((row) => row.lineNumber)).toEqual([2, 4, 5, 6, 7]);
  });

  it.each([4, 0.1, 0.3, 0.0001, 0.00012345, 10000, 1234.56789123])('roundtrips ratio %s without losing precision', (ratio) => {
    const parsed = parseTransactionsCsv(transactionsToCsv([
      transaction({ type: 'SPLIT', quantity: 0, price: 0, fees: 0, ratio }),
    ]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.errors).toEqual([]);
    expect(parsed.rows[0]?.input?.ratio).toBe(ratio);
  });

  it('constructs an instrument from CSV fields when it is not known', () => {
    const parsed = parseRow();

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.input).toEqual({
      instrument: { id: 'SAP:XETR', name: 'SAP SE', symbol: 'SAP', exchange: 'XETR', mic: 'XETR', currency: 'EUR', country: null, type: null },
      type: 'BUY', date: '2026-02-03', quantity: 2, price: 10, fees: 1, currency: 'EUR', ratio: null, note: null,
    });
  });

  it('prefers the existing instrument by identifier and detects conflicting currencies', () => {
    const existing = transaction();
    const parsed = parseTransactionsCsv(`${header}\n${csvRow({ Wertpapier: 'Alter Name' })}`, { existingTransactions: [existing] });
    expect(parsed.rows[0]?.input?.instrument).toEqual(existing.instrument);

    const conflict = parseTransactionsCsv(`${header}\n${csvRow({ Währung: 'USD' })}`, { existingTransactions: [existing] });
    expect(conflict.rows[0]?.input).toBeNull();
    expect(conflict.rows[0]?.errors.join(' ')).toContain('Währung des Wertpapiers');
  });

  it('accepts old exports without the ratio column', () => {
    const legacyHeader = header.split(';').slice(0, -1).join(';');
    const legacyRow = csvRow().split(';').slice(0, -1).join(';');
    const parsed = parseTransactionsCsv(`${legacyHeader}\r\n${legacyRow}`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.errors).toEqual([]);
    expect(parsed.rows[0]?.input?.ratio).toBeNull();
  });

  it('maps reordered headers and accepts additional columns', () => {
    const names = [...header.split(';').reverse(), 'Depot'];
    const values = new Map(header.split(';').map((name, index) => [name, csvRow().split(';')[index]]));
    const parsed = parseTransactionsCsv(`${names.join(';')}\n${names.map((name) => values.get(name) ?? 'privat').join(';')}`);

    expect(parsed.rows[0]?.input?.type).toBe('BUY');
    expect(parsed.rows[0]?.input?.date).toBe('2026-02-03');
    expect(parsed.rows[0]?.errors).toEqual([]);
  });

  it('normalizes header casing and surrounding spaces', () => {
    const variedHeader = header.split(';').map((name) => ` ${name.toLocaleUpperCase('de-DE')} `).join(';');
    const parsed = parseTransactionsCsv(`${variedHeader}\n${csvRow({ Vorgang: ' dividende ', Stückzahl: ' 2 ', Preis: '1,25', Gebühren: '0,5' })}`);
    expect(parsed.rows[0]?.input?.type).toBe('DIVIDEND');
    expect(parsed.rows[0]?.input?.price).toBe(1.25);
    expect(parsed.rows[0]?.errors).toEqual([]);
  });

  it('handles BOM, CRLF, CR, LF, empty lines and physical line numbers', () => {
    const parsed = parseTransactionsCsv(`\uFEFF\r\n${header}\r\n\r\n${csvRow()}\r${csvRow()}\n\n`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => row.lineNumber)).toEqual([4, 5]);
    expect(parsed.rows.map((row) => row.errors)).toEqual([[], []]);
  });

  it('preserves quotes, separators and newlines inside quoted fields', () => {
    const source = transaction({ note: 'Text; "zitiert"\nzweite Zeile\rdritte Zeile' });
    const parsed = parseTransactionsCsv(transactionsToCsv([source, transaction()]));

    expect(parsed.rows[0]?.input?.note).toBe(source.note);
    expect(parsed.rows[1]?.lineNumber).toBe(5);
    expect(parsed.rows.map((row) => row.errors)).toEqual([[], []]);
  });

  it.each(['=', '+', '-', '@'])('removes the formula protection apostrophe before %s', (prefix) => {
    const parsed = parseRow({ Wertpapier: `'${prefix}SAP`, Notiz: `'${prefix}Notiz` });
    expect(parsed.rows[0]?.input?.instrument.name).toBe(`${prefix}SAP`);
    expect(parsed.rows[0]?.input?.note).toBe(`${prefix}Notiz`);
  });

  it('preserves genuine leading apostrophes', () => {
    const parsed = parseRow({ Notiz: "'Eine Notiz", Wertpapier: "'SAP" });
    expect(parsed.rows[0]?.input?.note).toBe("'Eine Notiz");
    expect(parsed.rows[0]?.input?.instrument.name).toBe("'SAP");
  });

  it('reads decimal commas and standard German grouping without scientific notation', () => {
    const parsed = parseRow({ Stückzahl: '1.234,12345678', Preis: '0,0000001', Gebühren: '0,000000001' });
    expect(parsed.rows[0]?.errors).toEqual([]);
    expect(parsed.rows[0]?.input?.quantity).toBe(1234.12345678);
    expect(parsed.rows[0]?.input?.price).toBe(1e-7);
    expect(parsed.rows[0]?.input?.fees).toBe(1e-9);
  });

  it.each(['', 'NaN', 'Infinity', '1e3', '1.2', '1,2,3', '=2', '1 000'])('rejects invalid numeric field %j', (value) => {
    const parsed = parseRow({ Stückzahl: value });
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors.join(' ')).toContain('Stückzahl');
  });

  it.each([
    [{ Stückzahl: '0' }, 'größer als 0'],
    [{ Stückzahl: '1,123456789' }, '8 Nachkommastellen'],
    [{ Preis: '-1' }, 'größer als 0'],
    [{ Gebühren: '-1' }, 'nicht negativ'],
    [{ Währung: 'euro' }, 'drei Großbuchstaben'],
    [{ Notiz: 'a'.repeat(501) }, '500 Zeichen'],
    [{ Vorgang: 'Unbekannt' }, 'Vorgang'],
    [{ Wertpapier: '' }, 'gültiges Wertpapier'],
    [{ Kennung: 'SAP' }, 'SYMBOL:MIC'],
    [{ Kennung: 'SAP:XX' }, 'SYMBOL:MIC'],
    [{ Symbol: 'SIE' }, 'Symbol in der Kennung'],
  ] as const)('uses German field errors for invalid row %j', (overrides, message) => {
    const parsed = parseRow(overrides);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors.join(' ')).toContain(message);
  });

  it.each(['2026-02-03', '3.2.2026', '31.02.2026', '29.02.2025', '01.01.1899', '01.01.9999'])('rejects invalid, early or future date %s', (date) => {
    const parsed = parseRow({ Datum: date });
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors.length).toBeGreaterThan(0);
  });

  it('accepts leap days and rejects dividend deductions above the gross amount', () => {
    expect(parseRow({ Datum: '29.02.2024' }).rows[0]?.errors).toEqual([]);
    const dividend = parseRow({ Vorgang: 'Dividende', Stückzahl: '2', Preis: '1', Gebühren: '2,01' });
    expect(dividend.rows[0]?.input).toBeNull();
    expect(dividend.rows[0]?.errors.join(' ')).toContain('Brutto-Dividende');
    expect(parseRow({ Vorgang: 'Dividende', Stückzahl: '2', Preis: '1', Gebühren: '2' }).rows[0]?.errors).toEqual([]);
  });

  it.each([['4 : 1', 4], ['1 : 10', 0.1], ['0,3 : 1', 0.3], ['0,3 : 3', 0.1], ['0,21 : 3', 0.07], ['1 : 10.000', 0.0001], ['4', 4]])('reads split ratio %s', (ratio, expected) => {
    const parsed = parseRow({ Vorgang: 'Split', Stückzahl: '', Preis: '', Gebühren: '', Betrag: '', Verhältnis: String(ratio) });
    expect(parsed.rows[0]?.errors).toEqual([]);
    expect(parsed.rows[0]?.input).toMatchObject({ quantity: 0, price: 0, fees: 0, ratio: expected });
  });

  it.each(['', '1 : 1', '1 : 0', '0 : 1', '-1 : -4', '1 : 2 : 3', '1 : x', '1 : 3', '10001 : 1', '0,00001 : 1', '0,123456789 : 1'])('rejects invalid split ratio %s', (ratio) => {
    const parsed = parseRow({ Vorgang: 'Split', Verhältnis: ratio });
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors.join(' ')).toMatch(/Verhältnis/);
  });

  it('rejects a ratio for purchases, sales and dividends', () => {
    for (const type of ['Kauf', 'Verkauf', 'Dividende']) {
      const parsed = parseRow({ Vorgang: type, Verhältnis: '4 : 1' });
      expect(parsed.rows[0]?.input).toBeNull();
      expect(parsed.rows[0]?.errors.join(' ')).toContain('nur bei einem Split');
    }
  });

  it('reports multiple row errors without affecting the other rows', () => {
    const parsed = parseTransactionsCsv(`${header}\n${csvRow({ Preis: 'falsch', Gebühren: '-1', Datum: 'ungültig' })}\n${csvRow()}`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.lineNumber).toBe(2);
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors).toHaveLength(3);
    expect(parsed.rows[1]?.input).not.toBeNull();
  });

  it.each([
    ['"Kein Ende', 'schließendes Anführungszeichen'],
    ['SAP"Name', 'nicht korrekt maskiert'],
    ['"SAP"falsch', 'Nach einem schließenden'],
  ])('reports malformed quotes in row %s', (name, message) => {
    const parsed = parseRow({ Wertpapier: name });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.input).toBeNull();
    expect(parsed.rows[0]?.errors.join(' ')).toContain(message);
  });

  it('reports missing and extra row columns', () => {
    const parsed = parseTransactionsCsv(`${header}\n${csvRow().split(';').slice(0, -1).join(';')}\n${csvRow()};extra`);
    expect(parsed.rows[0]?.errors.join(' ')).toContain('11 statt 12 Spalten');
    expect(parsed.rows[1]?.errors.join(' ')).toContain('13 statt 12 Spalten');
    expect(parsed.rows.every((row) => row.input === null)).toBe(true);
  });

  it.each(['', '\uFEFF', ' \r\n\n', `${header}\r\n`])('reports empty file or no transactions', (text) => {
    const parsed = parseTransactionsCsv(text);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors.join(' ')).toMatch(/leer|keine Transaktionen/);
  });

  it('reports missing, duplicate and malformed header fields as file errors', () => {
    const missing = parseTransactionsCsv(`Datum;Wertpapier\n03.02.2026;SAP`);
    expect(missing.rows).toEqual([]);
    expect(missing.errors.join(' ')).toContain('„Kennung“ fehlt');
    const duplicate = parseTransactionsCsv(`${header};Datum\n${csvRow()};03.02.2026`);
    expect(duplicate.rows).toEqual([]);
    expect(duplicate.errors.join(' ')).toContain('mehrfach');
    const malformed = parseTransactionsCsv(`"${header}\n${csvRow()}`);
    expect(malformed.rows).toEqual([]);
    expect(malformed.errors.join(' ')).toContain('Kopfzeile');
  });

  it('accepts exactly the import limit and blocks a file exceeding it', () => {
    const rows = Array.from({ length: MAX_IMPORT_TRANSACTIONS }, () => csvRow());
    const maximum = parseTransactionsCsv([header, ...rows].join('\n'));
    expect(maximum.errors).toEqual([]);
    expect(maximum.rows).toHaveLength(MAX_IMPORT_TRANSACTIONS);
    const excessive = parseTransactionsCsv([header, ...rows, csvRow()].join('\n'));
    expect(excessive.errors.join(' ')).toContain(MAX_IMPORT_TRANSACTIONS.toLocaleString('de-DE'));
    expect(excessive.rows).toHaveLength(MAX_IMPORT_TRANSACTIONS);
  });

  it('does not mutate existing transactions or generate request identifiers', () => {
    const existing = transaction();
    const original = structuredClone(existing);
    const parsed = parseTransactionsCsv(transactionsToCsv([existing]), { existingTransactions: [existing] });
    expect(existing).toEqual(original);
    expect(parsed.rows[0]?.input).not.toHaveProperty('clientRequestId');
  });
});
