import { MAX_IMPORT_TRANSACTIONS } from '@shared/api';
import { validateTransactionInput } from '@shared/portfolio';
import { TRANSACTION_TYPES } from '@shared/types';
import type { Instrument, Transaction, TransactionInput, TransactionType } from '@shared/types';
import { formatSplitRatio, formatTransactionType, today } from './format';
import { calculateSplitRatio } from './transactionDraft';

const HEADER = 'Datum;Wertpapier;Symbol;Kennung;Vorgang;Stückzahl;Preis;Gebühren;Betrag;Währung;Notiz;Verhältnis';
const quantityFormat = new Intl.NumberFormat('de-DE', { useGrouping: false, maximumFractionDigits: 8 });
const amountFormat = new Intl.NumberFormat('de-DE', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });

function textField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function decimal(value: number): string {
  const [coefficient = '', exponent] = String(value).split('e');
  if (exponent === undefined) return coefficient.replace('.', ',');

  // Expand scientific notation without rounding prices or fees.
  const sign = coefficient.startsWith('-') ? '-' : '';
  const unsigned = coefficient.replace(/^-/, '');
  const point = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const position = (point === -1 ? unsigned.length : point) + Number(exponent);
  if (position <= 0) return `${sign}0,${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return `${sign}${digits}${'0'.repeat(position - digits.length)}`;
  return `${sign}${digits.slice(0, position)},${digits.slice(position)}`;
}

export function transactionsToCsv(transactions: Transaction[]): string {
  const rows = [...transactions].sort((a, b) => a.date.localeCompare(b.date)).map((transaction) => {
    const [year, month, day] = transaction.date.split('-');
    const isSplit = transaction.type === 'SPLIT';
    const amount = transaction.quantity * transaction.price + (transaction.type === 'BUY' ? transaction.fees : -transaction.fees);
    return [
      `${day}.${month}.${year}`,
      textField(transaction.instrument.name),
      textField(transaction.instrument.symbol),
      textField(transaction.instrumentId),
      formatTransactionType(transaction.type),
      isSplit ? '' : quantityFormat.format(transaction.quantity),
      isSplit ? '' : decimal(transaction.price),
      isSplit ? '' : decimal(transaction.fees),
      isSplit ? '' : amountFormat.format(amount),
      textField(transaction.currency),
      textField(transaction.note ?? ''),
      isSplit ? formatSplitRatio(transaction.ratio) : '',
    ].join(';');
  });
  return [HEADER, ...rows].join('\r\n');
}

export interface CsvImportRow {
  /** Physische Startzeile des Datensatzes, auch bei mehrzeiligen Textfeldern. */
  lineNumber: number;
  input: TransactionInput | null;
  errors: string[];
}

export interface CsvImportResult {
  rows: CsvImportRow[];
  /** Fehler der gesamten Datei (Kopfzeile, leere Datei oder Importlimit). */
  errors: string[];
}

export interface CsvImportOptions {
  existingTransactions?: readonly Transaction[];
}

interface CsvRecord {
  lineNumber: number;
  fields: string[];
  errors: string[];
}

/** CSV-Leser mit Semikolon, verdoppelten Quotes und Zeilenumbrüchen in Textfeldern. */
function readRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  let lineNumber = 1;
  let startLine = 1;
  let errors: string[] = [];
  const syntaxError = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };
  const finishField = () => {
    fields.push(value);
    value = '';
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    records.push({ lineNumber: startLine, fields, errors });
    fields = [];
    errors = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        value += character;
        if (character === '\r') {
          if (text[index + 1] === '\n') {
            value += '\n';
            index += 1;
          }
          lineNumber += 1;
        } else if (character === '\n') {
          lineNumber += 1;
        }
      }
      continue;
    }

    if (character === ';') {
      finishField();
    } else if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      lineNumber += 1;
      startLine = lineNumber;
    } else if (character === '"' && value.length === 0 && !closedQuote) {
      quoted = true;
    } else {
      if (character === '"') syntaxError('Ein Anführungszeichen ist im CSV-Feld nicht korrekt maskiert.');
      if (closedQuote && !/\s/.test(character)) {
        syntaxError('Nach einem schließenden Anführungszeichen sind nur ein Trennzeichen oder ein Zeilenende erlaubt.');
      }
      if (!closedQuote || !/\s/.test(character)) value += character;
    }
  }

  if (quoted) syntaxError('Ein CSV-Feld hat kein schließendes Anführungszeichen.');
  if (fields.length > 0 || value.length > 0 || quoted || closedQuote) finishRecord();
  return records.filter((record) => record.errors.length > 0 || record.fields.some((field) => field.trim().length > 0));
}

/** Entfernt ausschließlich das beim Export ergänzte Apostroph zum Formelschutz. */
function restoreText(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

function germanDecimal(value: string): number | null {
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(value)) return null;
  const parsed = Number(value.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function splitRatio(value: string): number | null {
  const parts = value.split(':');
  if (parts.length === 1) return germanDecimal(value);
  if (parts.length !== 2) return null;
  const numerator = germanDecimal(parts[0]!.trim());
  const denominator = germanDecimal(parts[1]!.trim());
  return calculateSplitRatio(numerator, denominator);
}

/** Liest das deutsche Exportformat; Beträge werden aus Menge, Preis und Gebühren berechnet. */
export function parseTransactionsCsv(text: string, options: CsvImportOptions = {}): CsvImportResult {
  const records = readRecords(text.replace(/^\uFEFF/, ''));
  const header = records.shift();
  if (!header) return { rows: [], errors: ['Die CSV-Datei ist leer.'] };
  if (header.errors.length > 0) {
    return { rows: [], errors: header.errors.map((error) => `Kopfzeile: ${error}`) };
  }

  const columns = new Map<string, number>();
  const errors: string[] = [];
  for (const [index, name] of header.fields.entries()) {
    const normalized = name.trim().toLocaleLowerCase('de-DE');
    if (columns.has(normalized)) errors.push(`Die Spalte „${name.trim()}“ ist in der Kopfzeile mehrfach vorhanden.`);
    columns.set(normalized, index);
  }
  const required = ['Datum', 'Wertpapier', 'Symbol', 'Kennung', 'Vorgang', 'Stückzahl', 'Preis', 'Gebühren', 'Währung'];
  for (const name of required) {
    if (!columns.has(name.toLocaleLowerCase('de-DE'))) errors.push(`Die Spalte „${name}“ fehlt in der Kopfzeile.`);
  }
  if (errors.length > 0) return { rows: [], errors };
  if (records.length === 0) return { rows: [], errors: ['Die CSV-Datei enthält keine Transaktionen.'] };
  if (records.length > MAX_IMPORT_TRANSACTIONS) {
    errors.push(`Die CSV-Datei darf höchstens ${MAX_IMPORT_TRANSACTIONS.toLocaleString('de-DE')} Transaktionen enthalten.`);
  }

  const instruments = new Map<string, Instrument>();
  for (const transaction of options.existingTransactions ?? []) {
    if (!instruments.has(transaction.instrumentId)) instruments.set(transaction.instrumentId, transaction.instrument);
  }
  const types = new Map(TRANSACTION_TYPES.map((type) => [formatTransactionType(type).toLocaleLowerCase('de-DE'), type]));
  const currentDate = today();
  const rows = records.slice(0, MAX_IMPORT_TRANSACTIONS).map((record): CsvImportRow => {
    const rowErrors = [...record.errors];
    if (record.fields.length !== header.fields.length) {
      rowErrors.push(`Die Zeile enthält ${record.fields.length} statt ${header.fields.length} Spalten.`);
    }
    if (rowErrors.length > 0) return { lineNumber: record.lineNumber, input: null, errors: rowErrors };

    const field = (name: string): string => {
      const index = columns.get(name.toLocaleLowerCase('de-DE'));
      return index === undefined ? '' : restoreText(record.fields[index] ?? '');
    };
    const fields: Record<string, string> = {};
    const type: TransactionType = types.get(field('Vorgang').trim().toLocaleLowerCase('de-DE')) ?? 'BUY';
    if (!types.has(field('Vorgang').trim().toLocaleLowerCase('de-DE'))) {
      fields.type = 'Der Vorgang muss Kauf, Verkauf, Dividende oder Split sein.';
    }
    const identifier = field('Kennung').trim();
    const identifierParts = /^([^:\s]+):([A-Z0-9]{4})$/.exec(identifier);
    if (!identifierParts) fields.instrument = 'Die Kennung muss das Format SYMBOL:MIC haben, zum Beispiel SAP:XETR.';
    const symbol = field('Symbol').trim();
    if (identifierParts && symbol !== identifierParts[1]) {
      fields.instrument = 'Das Symbol muss mit dem Symbol in der Kennung übereinstimmen.';
    }
    const currency = field('Währung').trim();
    const instrument = instruments.get(identifier) ?? {
      id: identifier,
      name: field('Wertpapier').trim(),
      symbol,
      exchange: identifierParts?.[2] ?? '',
      mic: identifierParts?.[2] ?? '',
      currency,
      country: null,
      type: null,
    };
    const dateParts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(field('Datum').trim());
    const date = dateParts ? `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}` : '';
    if (!dateParts) fields.date = 'Das Datum muss im Format TT.MM.JJJJ angegeben werden.';
    const numeric = (column: string, key: string): number => {
      const value = germanDecimal(field(column).trim());
      if (value === null) fields[key] = `„${column}“ muss eine gültige Zahl mit Dezimalkomma sein.`;
      return value ?? NaN;
    };
    const isSplit = type === 'SPLIT';
    const rawRatio = field('Verhältnis').trim();
    const ratio = rawRatio ? splitRatio(rawRatio) : null;
    if (isSplit && ratio === null) {
      fields.ratio = 'Bitte geben Sie ein gültiges Split-Verhältnis neu : alt an, zum Beispiel 4 : 1.';
    } else if (!isSplit && rawRatio) {
      fields.ratio = 'Ein Verhältnis ist nur bei einem Split erlaubt.';
    }
    const input: TransactionInput = {
      instrument,
      type,
      date,
      quantity: isSplit ? 0 : numeric('Stückzahl', 'quantity'),
      price: isSplit ? 0 : numeric('Preis', 'price'),
      fees: isSplit ? 0 : numeric('Gebühren', 'fees'),
      currency,
      ratio: isSplit ? ratio : null,
      note: field('Notiz') || null,
    };
    const validation = validateTransactionInput(input, currentDate);
    if (!validation.ok) {
      for (const [key, message] of Object.entries(validation.fields)) {
        if (!fields[key]) fields[key] = message;
      }
    }
    const messages = Object.values(fields);
    return {
      lineNumber: record.lineNumber,
      input: messages.length === 0 && validation.ok ? validation.value : null,
      errors: messages,
    };
  });
  return { rows, errors };
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
