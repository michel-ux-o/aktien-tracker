import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Transaction } from '@shared/types';
import { MAX_IMPORT_TRANSACTIONS } from '@shared/api';
import { api, ApiError, errorMessage } from '../api/client';
import { parseTransactionsCsv } from '../lib/csv';
import { date, formatSplitRatio, formatTransactionType, money, number } from '../lib/format';
import { buildImportPreview, mapImportFieldErrors, selectedImportRows, validateImportSequence } from '../lib/transactionImport';
import type { ImportPreviewRow, ImportRowError } from '../lib/transactionImport';
import { Dialog } from './Dialog';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function ImportDialog({ transactions, onClose, onImported }: {
  transactions: Transaction[]; onClose: () => void; onImported: () => void | Promise<void>;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const [importId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<ImportRowError[]>([]);
  const [created, setCreated] = useState<number | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const submitting = useRef(false);
  const fileReadVersion = useRef(0);
  const mounted = useRef(true);
  const sentRows = useRef<ReturnType<typeof selectedImportRows> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; fileReadVersion.current += 1; };
  }, []);

  const selected = useMemo(() => selectedImportRows(rows, includeDuplicates), [rows, includeDuplicates]);
  const sequenceErrors = useMemo(() => validateImportSequence(selected, transactions), [selected, transactions]);
  const validCount = rows.filter(row => row.input && !row.errors.length && !row.duplicate).length;
  const invalidCount = rows.filter(row => !row.input || row.errors.length).length;
  const duplicateCount = rows.filter(row => row.duplicate).length;
  const canImport = selected.length > 0 && selected.length <= MAX_IMPORT_TRANSACTIONS && !fileErrors.length && !sequenceErrors.length;

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const version = ++fileReadVersion.current;
    setRows([]); setFileErrors([]); setIncludeDuplicates(false); setError(null); setRowErrors([]);
    setReading(false); setFileName(file?.name ?? '');
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setFileErrors(['Bitte wähle eine Datei mit der Endung .csv.']); return; }
    if (file.size > MAX_FILE_BYTES) { setFileErrors(['Die CSV-Datei darf höchstens 2 MB groß sein.']); return; }
    setReading(true);
    try {
      const parsed = parseTransactionsCsv(await file.text(), { existingTransactions: transactions });
      if (!mounted.current || version !== fileReadVersion.current) return;
      setRows(buildImportPreview(parsed.rows, transactions));
      setFileErrors(parsed.errors);
    } catch {
      if (!mounted.current || version !== fileReadVersion.current) return;
      setFileErrors(['Die Datei konnte nicht gelesen werden. Bitte wähle eine gültige CSV-Datei.']);
    } finally {
      if (mounted.current && version === fileReadVersion.current) setReading(false);
    }
  }

  async function reloadPortfolio() {
    setBusy(true); setReloadError(null);
    try { await onImported(); }
    catch (failure) { if (mounted.current) setReloadError(`Die Transaktionen wurden importiert, aber die Ansicht konnte nicht aktualisiert werden. ${errorMessage(failure)}`); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function submit() {
    if (submitting.current || reading || created !== null || !canImport) return;
    submitting.current = true;
    setBusy(true); setError(null); setRowErrors([]); setSent(true);
    // Bei unklarer Netzwerkantwort bleibt der Batch für denselben importId unverändert retrybar.
    const batch = sentRows.current ?? selected;
    sentRows.current = batch;
    try {
      const result = await api.importTransactions({ importId, transactions: batch.map(row => row.input) });
      if (!mounted.current) return;
      setCreated(result.created);
      try { await onImported(); }
      catch (failure) {
        if (mounted.current) setReloadError(`Die Transaktionen wurden importiert, aber die Ansicht konnte nicht aktualisiert werden. ${errorMessage(failure)}`);
      }
    } catch (failure) {
      if (!mounted.current) return;
      const message = errorMessage(failure);
      if (failure instanceof ApiError) {
        const mapped = mapImportFieldErrors(failure.fields, batch);
        setRowErrors(mapped.rows);
        setError([message, ...mapped.general].filter((item, index, all) => all.indexOf(item) === index).join(' '));
      } else setError(message);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Dialog title="Transaktionen aus CSV importieren" onClose={onClose} busy={busy} descriptionId={descriptionId} footer={<>
    <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>{created !== null ? 'Schließen' : 'Abbrechen'}</button>
    {created !== null ? reloadError && <button type="button" className="button button-primary" disabled={busy} onClick={() => void reloadPortfolio()}>{busy ? 'Wird geladen …' : 'Ansicht neu laden'}</button> : <button type="button" className="button button-primary" disabled={busy || reading || !canImport} onClick={() => void submit()}>{busy ? 'Wird importiert …' : `${number(selected.length, 0)} ${selected.length === 1 ? 'Transaktion' : 'Transaktionen'} importieren`}</button>}
  </>}>
    <div className="section-stack import-dialog-content">
      <p id={descriptionId} className="muted">Wähle eine CSV-Datei im Exportformat des Aktien-Trackers. Maximal 2 MB und {number(MAX_IMPORT_TRANSACTIONS, 0)} Transaktionen.</p>
      {created !== null ? <>
        <div className="notice import-success" role="status"><strong>Import erfolgreich.</strong><p>{number(created, 0)} {created === 1 ? 'Transaktion wurde' : 'Transaktionen wurden'} importiert.</p></div>
        {reloadError && <div className="form-error" role="alert">{reloadError}</div>}
      </> : <>
        <div className="form-field">
          <label htmlFor={`${id}-file`}>CSV-Datei</label>
          <input id={`${id}-file`} type="file" accept=".csv,text/csv" disabled={busy || sent} onChange={event => void chooseFile(event)} data-autofocus aria-describedby={`${id}-file-hint`} />
          <p id={`${id}-file-hint`} className="field-hint">Semikolon als Trennzeichen, Datum TT.MM.JJJJ und Dezimalkomma.</p>
          {fileName && <p className="muted import-file-name">{fileName}</p>}
        </div>
        {reading && <p className="muted" role="status">Datei wird gelesen …</p>}
        {fileErrors.length > 0 && <div className="form-error" role="alert">{fileErrors.map((message, index) => <p key={index}>{message}</p>)}</div>}
        {error && <div className="form-error" role="alert"><strong>Import konnte nicht abgeschlossen werden.</strong><p>{error}</p></div>}
        {rows.length > 0 && <>
          <dl className="import-summary" aria-label="Ergebnis der CSV-Prüfung">
            <div><dt>Gültig</dt><dd>{number(validCount, 0)}</dd></div>
            <div><dt>Fehlerhaft</dt><dd>{number(invalidCount, 0)}</dd></div>
            <div><dt>Doppelt</dt><dd>{number(duplicateCount, 0)}</dd></div>
          </dl>
          {duplicateCount > 0 && <label className="import-duplicates-option" htmlFor={`${id}-duplicates`}>
            <input id={`${id}-duplicates`} type="checkbox" checked={includeDuplicates} disabled={busy || sent} onChange={event => { setIncludeDuplicates(event.target.checked); setError(null); setRowErrors([]); }} />
            <span>Doppelte Zeilen ebenfalls importieren</span>
          </label>}
          <p className="muted">{number(selected.length, 0)} Zeilen werden importiert.{invalidCount > 0 && ' Fehlerhafte Zeilen werden übersprungen.'}{duplicateCount > 0 && !includeDuplicates && ' Doppelte Zeilen werden übersprungen.'}</p>
          {sequenceErrors.length > 0 && <div className="form-error" role="alert"><strong>Die ausgewählten Transaktionen passen nicht zum Bestand.</strong>{sequenceErrors.map((item, index) => <p key={index}>{item.lineNumber !== null && `Zeile ${item.lineNumber}: `}{item.message}</p>)}</div>}
          <details className="details-disclosure" open={invalidCount > 0 || rowErrors.length > 0}>
            <summary>Vorschau und Zeilenmeldungen ({number(rows.length, 0)} Zeilen)</summary>
            <ol className="import-preview-list">
              {rows.map(row => {
                const input = row.input;
                const messages = [...row.errors, ...rowErrors.filter(item => item.lineNumber === row.lineNumber).map(item => item.message)];
                return <li key={row.lineNumber} className="import-preview-row">
                  <div className="import-preview-row-header"><strong>Zeile {row.lineNumber}</strong><span className={messages.length ? 'negative' : 'muted'}>{messages.length ? 'Fehlerhaft' : row.duplicate ? includeDuplicates ? 'Doppelt · wird importiert' : 'Doppelt · übersprungen' : 'Gültig'}</span></div>
                  {input && <>
                    <p>{input.instrument.name} <span className="muted">({input.instrument.id})</span></p>
                    <p className="muted import-preview-details">{date(input.date)} · {formatTransactionType(input.type)} · {input.type === 'SPLIT' ? formatSplitRatio(input.ratio) : input.type === 'DIVIDEND' ? `${money(input.quantity * input.price - input.fees, input.currency)} netto` : `${number(input.quantity, 8)} Stück à ${money(input.price, input.currency)}`}</p>
                  </>}
                  {messages.length > 0 && <ul className="import-preview-errors">{messages.map((message, index) => <li key={index} className="field-error">{message}</li>)}</ul>}
                </li>;
              })}
            </ol>
          </details>
        </>}
        {sent && <p className="field-hint">Ein erneuter Versuch verwendet denselben Import und legt keine weiteren Kopien an. Für eine andere Datei oder Auswahl schließe diesen Dialog und öffne ihn erneut.</p>}
      </>}
    </div>
  </Dialog>;
}
