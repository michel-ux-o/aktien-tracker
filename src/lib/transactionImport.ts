import type { Transaction, TransactionInput } from '@shared/types';
import { validateTransactionSequence } from '@shared/portfolio';
import type { SequenceItem } from '@shared/portfolio';

export interface ImportPreviewRow {
  lineNumber: number;
  input: TransactionInput | null;
  errors: string[];
  duplicate: boolean;
}

export interface ImportRowError {
  lineNumber: number;
  message: string;
}

/** Notizen und Wertpapier-Stammdaten gehören laut Importvertrag nicht zum Duplikatvergleich. */
function duplicateKey(transaction: TransactionInput | Transaction): string {
  return JSON.stringify([
    transaction.instrument.id, transaction.type, transaction.date,
    transaction.quantity, transaction.price, transaction.fees, transaction.ratio ?? null,
  ]);
}

export function buildImportPreview(
  rows: readonly { lineNumber: number; input: TransactionInput | null; errors: string[] }[],
  existing: readonly Transaction[],
): ImportPreviewRow[] {
  const seen = new Set(existing.map(duplicateKey));
  return rows.map(row => {
    if (!row.input || row.errors.length) return { ...row, duplicate: false };
    const key = duplicateKey(row.input);
    const duplicate = seen.has(key);
    seen.add(key);
    return { ...row, duplicate };
  });
}

export function selectedImportRows(rows: readonly ImportPreviewRow[], includeDuplicates: boolean): (ImportPreviewRow & { input: TransactionInput })[] {
  return rows.filter((row): row is ImportPreviewRow & { input: TransactionInput } =>
    row.input !== null && row.errors.length === 0 && (includeDuplicates || !row.duplicate));
}

/** Prüft den vollständigen ausgewählten Batch zusammen mit dem bisherigen Bestand je Wertpapier. */
export function validateImportSequence(
  rows: readonly (ImportPreviewRow & { input: TransactionInput })[],
  existing: readonly Transaction[],
): { lineNumber: number | null; message: string }[] {
  const groups = new Map<string, { name: string; items: SequenceItem[] }>();
  const lineById = new Map<string, number>();
  for (const row of rows) {
    const instrument = row.input.instrument;
    if (!groups.has(instrument.id)) groups.set(instrument.id, { name: instrument.name, items: [] });
  }
  for (const transaction of existing) groups.get(transaction.instrument.id)?.items.push(transaction);
  for (const row of rows) {
    const id = `csv-import-line-${row.lineNumber}`;
    lineById.set(id, row.lineNumber);
    groups.get(row.input.instrument.id)!.items.push({
      id, type: row.input.type, date: row.input.date, quantity: row.input.quantity,
      ratio: row.input.ratio ?? null, createdAt: '9999-12-31T23:59:59.999Z',
    });
  }
  const errors: { lineNumber: number | null; message: string }[] = [];
  for (const group of groups.values()) {
    const result = validateTransactionSequence(group.items);
    if (!result.ok) errors.push({
      lineNumber: lineById.get(result.transactionId) ?? null,
      message: `${group.name}: ${result.message}`,
    });
  }
  return errors;
}

const fieldNames: Record<string, string> = {
  instrument: 'Wertpapier', type: 'Art', date: 'Datum', quantity: 'Stückzahl', price: 'Preis',
  fees: 'Gebühren / Abzüge', currency: 'Währung', ratio: 'Verhältnis', note: 'Notiz',
};

/** Der Server indexiert nur tatsächlich gesendete Zeilen, die CSV zählt auch Kopf und übersprungene Zeilen. */
export function mapImportFieldErrors(
  fields: Readonly<Record<string, string>>,
  sentRows: readonly { lineNumber: number }[],
): { rows: ImportRowError[]; general: string[] } {
  const rows: ImportRowError[] = [];
  const general: string[] = [];
  for (const [field, message] of Object.entries(fields)) {
    const match = /^rows\.(\d+)\.(.+)$/.exec(field);
    const row = match ? sentRows[Number(match[1])] : undefined;
    if (match && row) {
      const label = fieldNames[match[2]!.split('.')[0]!] ?? match[2];
      rows.push({ lineNumber: row.lineNumber, message: `${label}: ${message}` });
    } else general.push(message);
  }
  return { rows, general };
}
