import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Instrument, Quote, Transaction, TransactionInput, TransactionType } from '@shared/types';
import { validateTransactionInput } from '@shared/portfolio';
import { api, ApiError, errorMessage } from '../api/client';
import { dateTime, formatSplitRatio, formatTransactionType, money, number, parseDecimal, today } from '../lib/format';
import { calculateSplitRatio, quantityBeforeTransaction, validateTransactionDraftSequence } from '../lib/transactionDraft';
import { Dialog } from './Dialog';
import { SearchBox } from './SearchBox';

const inputNumber = (value: number | undefined, fallback = '') => value == null ? fallback : new Intl.NumberFormat('de-DE', { useGrouping: false, maximumSignificantDigits: 21 }).format(value);

function initialSplitParts(ratio: number | null | undefined): [string, string] {
  if (ratio != null && ratio > 0 && ratio < 1 && Number.isInteger(1 / ratio)) return ['1', inputNumber(1 / ratio)];
  return [inputNumber(ratio ?? 4), '1'];
}

export function TransactionForm({ instrument, transaction, transactions, onClose, onSaved }: { instrument?: Instrument; transaction?: Transaction; transactions?: readonly Transaction[]; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const formId = `${id}-form`;
  const [selected, setSelected] = useState<Instrument | undefined>(transaction?.instrument ?? instrument);
  const [choosing, setChoosing] = useState(!selected);
  const [type, setType] = useState<TransactionType>(transaction?.type ?? 'BUY');
  const [transactionDate, setTransactionDate] = useState(transaction?.date ?? today());
  const [quantity, setQuantity] = useState(inputNumber(transaction?.quantity));
  const [price, setPrice] = useState(inputNumber(transaction?.price));
  const [quoteResult, setQuoteResult] = useState<{ instrumentId: string; currency: string; quote: Quote | null } | null>(null);
  const [fees, setFees] = useState(inputNumber(transaction?.fees, '0'));
  const [splitNew, setSplitNew] = useState(() => initialSplitParts(transaction?.ratio)[0]);
  const [splitOld, setSplitOld] = useState(() => initialSplitParts(transaction?.ratio)[1]);
  const [note, setNote] = useState(transaction?.note ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [history, setHistory] = useState<{ instrumentId: string; transactions: readonly Transaction[] | null; error: unknown } | null>(null);
  const submitting = useRef(false);
  const dividendQuantityEdited = useRef(transaction?.type === 'DIVIDEND');
  const maxDate = today();
  const fieldId = (field: string) => `${id}-${field}`;
  const clearField = (field: string) => setFields(current => { const result = { ...current }; delete result[field]; return result; });
  const fieldError = (field: string) => fields[field] ? <p id={`${fieldId(field)}-error`} className="field-error" aria-live="polite">{fields[field]}</p> : null;
  const fieldAria = (field: string, hint?: string) => ({ 'aria-invalid': Boolean(fields[field]), 'aria-describedby': [fields[field] ? `${fieldId(field)}-error` : '', hint ?? ''].filter(Boolean).join(' ') || undefined });
  const isSplit = type === 'SPLIT';
  const isDividend = type === 'DIVIDEND';
  const splitNewValue = parseDecimal(splitNew);
  const splitOldValue = parseDecimal(splitOld);
  const ratioValue = calculateSplitRatio(splitNewValue, splitOldValue);
  const quantityValue = parseDecimal(quantity);
  const priceValue = parseDecimal(price);
  const feesValue = parseDecimal(fees);
  const netDividend = quantityValue != null && quantityValue > 0 && priceValue != null && priceValue > 0 && feesValue != null && feesValue >= 0 ? quantityValue * priceValue - feesValue : null;
  const showQuote = Boolean(selected && !choosing && !isSplit && !isDividend);
  const quoteLoading = showQuote && (!quoteResult || quoteResult.instrumentId !== selected?.id || quoteResult.currency !== selected?.currency);
  const quote = showQuote && !quoteLoading ? quoteResult?.quote : null;
  const knownTransactions = transactions ?? (history && history.instrumentId === selected?.id ? history.transactions ?? undefined : undefined);
  const historyLoading = Boolean(selected && !choosing && transactions === undefined && (!history || history.instrumentId !== selected.id));
  const historyError = transactions === undefined && history && history.instrumentId === selected?.id ? history.error : null;
  // Neue Transaktionen stehen innerhalb derselben Art hinter bereits gespeicherten Einträgen.
  const draftCreatedAt = transaction?.createdAt ?? '9999-12-31T23:59:59.999Z';
  const beforeQuantity = useMemo(() => selected && knownTransactions ? quantityBeforeTransaction(knownTransactions, {
    id: transaction?.id ?? requestId, createdAt: draftCreatedAt,
    instrumentId: selected.id, date: transactionDate, type,
  }) : null, [knownTransactions, selected, transaction, requestId, draftCreatedAt, transactionDate, type]);

  function changeType(value: TransactionType) {
    setType(value);
    setFields(current => Object.fromEntries(Object.entries(current).filter(([field]) => !['type', 'quantity', 'price', 'fees', 'ratio'].includes(field))));
    if (value === 'DIVIDEND') {
      dividendQuantityEdited.current = false;
      setQuantity('');
    }
  }

  function chooseInstrument(value: Instrument) {
    setSelected(value); setChoosing(false);
    dividendQuantityEdited.current = false;
    clearField('instrument'); clearField('currency');
  }

  async function loadTransactionsForDraft(instrumentId: string) {
    const ids = transaction && transaction.instrumentId !== instrumentId ? [instrumentId, transaction.instrumentId] : [instrumentId];
    const values = await Promise.all(ids.map(value => api.transactions(value)));
    return values.flatMap(value => value.transactions);
  }

  useEffect(() => {
    if (isDividend && !dividendQuantityEdited.current && beforeQuantity != null) {
      setQuantity(beforeQuantity > 0 ? inputNumber(Number(beforeQuantity.toFixed(8))) : '');
    }
  }, [isDividend, beforeQuantity, selected?.id]);

  useEffect(() => {
    if (transactions !== undefined || !selected || choosing) return;
    let active = true;
    const instrumentId = selected.id;
    setHistory(null);
    void loadTransactionsForDraft(instrumentId).then(value => {
      if (active) setHistory({ instrumentId, transactions: value, error: null });
    }).catch(failure => {
      if (active) setHistory({ instrumentId, transactions: null, error: failure });
    });
    return () => { active = false; };
  }, [transactions, selected, choosing, transaction?.instrumentId]);

  useEffect(() => {
    const abort = new AbortController();
    setQuoteResult(null);
    if (selected && showQuote) {
      const result = { instrumentId: selected.id, currency: selected.currency };
      // api.quote has no AbortSignal parameter; cancel result handling on cleanup.
      void api.quote(selected.id).then(value => {
        if (abort.signal.aborted) return;
        const available = value?.instrumentId === selected.id && value.currency === selected.currency && value.price != null && Number.isFinite(value.price) && value.price > 0;
        setQuoteResult({ ...result, quote: available ? value : null });
      }).catch(() => {
        if (abort.signal.aborted) return;
        setQuoteResult({ ...result, quote: null });
      });
    }
    return () => abort.abort();
  }, [selected, showQuote]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const errors: Record<string, string> = {};
    if (!selected) errors.instrument = 'Bitte wähle eine Aktie aus der Suche.';
    const validation = validateTransactionInput({
      instrument: selected, type, date: transactionDate, quantity: isSplit ? 0 : quantityValue,
      price: isSplit ? 0 : priceValue, fees: isSplit ? 0 : feesValue,
      ratio: isSplit ? ratioValue : null, currency: selected?.currency ?? '', note,
      ...(!transaction ? { clientRequestId: requestId } : {}),
    }, maxDate);
    if (!validation.ok) Object.assign(errors, validation.fields);
    if (!isSplit && quantityValue != null && (quantity.trim().split(/[,.]/)[1]?.length ?? 0) > 8) errors.quantity = 'Für die Stückzahl sind höchstens 8 Nachkommastellen erlaubt.';
    if (isSplit && (splitNewValue == null || splitOldValue == null || splitNewValue <= 0 || splitOldValue <= 0)) errors.ratio = 'Bitte gib für neue und alte Stücke jeweils eine Zahl größer als 0 ein.';
    const input = validation.ok ? validation.value : null;
    setError(null); setFields(errors);
    if (Object.keys(errors).length || !input) {
      requestAnimationFrame(() => {
        const first = Object.keys(errors)[0];
        if (first === 'instrument') document.querySelector<HTMLInputElement>(`[id="${formId}"] input[role="combobox"]`)?.focus();
        else if (first) document.getElementById(fieldId(first))?.focus();
      });
      return;
    }
    submitting.current = true; setBusy(true);
    try {
      let sequenceTransactions = knownTransactions;
      if (!sequenceTransactions) {
        sequenceTransactions = await loadTransactionsForDraft(input.instrument.id);
        setHistory({ instrumentId: input.instrument.id, transactions: sequenceTransactions, error: null });
      }
      const sequence = validateTransactionDraftSequence(sequenceTransactions, input, { id: transaction?.id ?? requestId, createdAt: draftCreatedAt });
      if (!sequence.ok) {
        const field = sequence.transactionId !== (transaction?.id ?? requestId) ? 'date' : type === 'SELL' ? 'quantity' : isSplit ? 'ratio' : 'date';
        setFields({ [field]: sequence.message });
        requestAnimationFrame(() => document.getElementById(fieldId(field))?.focus());
        return;
      }
      if (transaction) await api.updateTransaction(transaction.id, input);
      else await api.createTransaction(input);
      onSaved();
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError) setFields(failure.fields);
    } finally { submitting.current = false; setBusy(false); }
  }

  return <Dialog title={transaction ? 'Transaktion bearbeiten' : 'Transaktion erfassen'} onClose={onClose} busy={busy} footer={<>
    <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Abbrechen</button>
    <button type="submit" className="button button-primary" form={formId} disabled={busy || historyLoading}>{busy ? 'Wird gespeichert …' : historyLoading ? 'Bestand wird geladen …' : transaction ? 'Änderungen speichern' : 'Transaktion speichern'}</button>
  </>}>
    <form id={formId} className="transaction-form" onSubmit={event => void submit(event)} noValidate>
      {error != null && <div className="form-error" role="alert"><strong>Transaktion konnte nicht gespeichert werden.</strong><p>{errorMessage(error)}</p></div>}
      <fieldset disabled={busy} className="section-stack">
        <legend className="sr-only">Angaben zur Transaktion</legend>
        <div className="form-field">
          {choosing ? <SearchBox label="Aktie" autoFocus onSelect={chooseInstrument} error={fields.instrument} /> : <>
            <label htmlFor={fieldId('instrument')}>Aktie</label><div className="selected-instrument form-field"><input id={fieldId('instrument')} value={`${selected?.name ?? ''} (${selected?.symbol ?? ''} · ${selected?.exchange ?? ''})`} readOnly {...fieldAria('instrument')} /><button type="button" className="button button-secondary" onClick={() => { setChoosing(true); setSelected(undefined); }}>Ändern</button></div>{fieldError('instrument')}
          </>}
        </div>
        <fieldset className="transaction-type"><legend>Art der Transaktion</legend><div className="segmented-control transaction-types">
          {(['BUY', 'SELL', 'DIVIDEND', 'SPLIT'] as const).map(value => <label key={value} className={type === value ? 'selected' : ''}><input type="radio" name={`${id}-type`} value={value} checked={type === value} onChange={() => changeType(value)} /> {formatTransactionType(value)}</label>)}
        </div>{fieldError('type')}</fieldset>
        <div className="form-grid">
          <div className="form-field"><label htmlFor={fieldId('date')}>Datum</label><input id={fieldId('date')} type="date" max={maxDate} value={transactionDate} onChange={event => { setTransactionDate(event.target.value); clearField('date'); }} required {...fieldAria('date')} />{fieldError('date')}</div>
          {isSplit ? <div className="form-field">
            <label htmlFor={fieldId('ratio')}>Verhältnis neu : alt</label>
            <div className="split-ratio-inputs"><input id={fieldId('ratio')} type="text" inputMode="decimal" aria-label="Neue Stücke" value={splitNew} onChange={event => { setSplitNew(event.target.value); clearField('ratio'); }} required {...fieldAria('ratio', `${id}-ratio-hint`)} /><span aria-hidden="true">:</span><input id={fieldId('ratio-old')} type="text" inputMode="decimal" aria-label="Alte Stücke" value={splitOld} onChange={event => { setSplitOld(event.target.value); clearField('ratio'); }} required {...fieldAria('ratio', `${id}-ratio-hint`)} /></div>
            <p id={`${id}-ratio-hint`} className="field-hint muted">Zum Beispiel 4 : 1 für einen Split oder 1 : 10 für eine Zusammenlegung.</p>{fieldError('ratio')}
          </div> : <>
          <div className="form-field"><label htmlFor={fieldId('quantity')}>{isDividend ? 'Berechtigte Stückzahl' : 'Stückzahl'}</label><input id={fieldId('quantity')} type="text" inputMode="decimal" placeholder="z. B. 1,5" value={quantity} onChange={event => { setQuantity(event.target.value); dividendQuantityEdited.current = true; clearField('quantity'); }} required {...fieldAria('quantity', `${id}-quantity-hint`)} /><p id={`${id}-quantity-hint`} className="field-hint muted">{isDividend && beforeQuantity != null ? `Bestand zum Datum: ${number(beforeQuantity, 8)} Stück. ` : ''}Bruchstücke möglich, bis zu 8 Nachkommastellen.</p>{fieldError('quantity')}</div>
          <div className="form-field">
            <label htmlFor={fieldId('price')}>{isDividend ? 'Dividende je Aktie' : 'Preis pro Aktie'}</label><input id={fieldId('price')} type="text" inputMode="decimal" placeholder={isDividend ? 'z. B. 1,50' : 'z. B. 125,50'} value={price} onChange={event => { setPrice(event.target.value); clearField('price'); }} required {...fieldAria('price', showQuote ? `${id}-quote-hint` : undefined)} />
            {showQuote && <>
              <p id={`${id}-quote-hint`} className="field-hint muted" aria-live="polite">{quoteLoading ? 'Kurs wird geladen …' : quote ? <>Letzter Kurs: {number(quote.price, 20)} {quote.currency} · Stand {dateTime(quote.asOf)} · Quelle {quote.meta.source}</> : 'Kein aktueller Kurs verfügbar'}</p>
              {quote && <button type="button" className="text-button" onClick={() => { setPrice(inputNumber(quote.price ?? undefined)); clearField('price'); }}>Kurs übernehmen</button>}
            </>}
            {fieldError('price')}
          </div>
          <div className="form-field"><label htmlFor={fieldId('fees')}>{isDividend ? 'Abzüge (Quellensteuer/Gebühren)' : 'Gebühren'}</label><input id={fieldId('fees')} type="text" inputMode="decimal" value={fees} onChange={event => { setFees(event.target.value); clearField('fees'); }} required {...fieldAria('fees', isDividend ? `${id}-deductions-hint` : undefined)} />{isDividend && <p id={`${id}-deductions-hint`} className="field-hint muted">Es werden ausschließlich die eingegebenen Abzüge berücksichtigt.</p>}{fieldError('fees')}</div>
          </>}
          {(isDividend || isSplit) && <div className="transaction-preview form-field-full full-width" role="status" aria-live="polite">
            {isDividend ? <p>Netto-Dividende: <strong>{selected ? money(netDividend, selected.currency) : 'Bitte zuerst eine Aktie wählen'}</strong></p> : <>
              <p>Split-Verhältnis: <strong>{formatSplitRatio(ratioValue)}</strong></p>
              <p>Bestand vorher → nachher: <strong>{beforeQuantity == null || ratioValue == null ? 'Nicht verfügbar' : `${number(beforeQuantity, 8)} → ${number(beforeQuantity * ratioValue, 8)} Stück`}</strong></p>
            </>}
            {historyLoading && <p className="muted">Bestand zum Datum wird geladen …</p>}
            {historyError != null && <p className="muted">Der Bestand konnte nicht geladen werden. Beim Speichern wird die Transaktionsfolge erneut geladen und geprüft.</p>}
          </div>}
          <div className="form-field form-field-full full-width"><label htmlFor={fieldId('currency')}>Handelswährung</label><input id={fieldId('currency')} value={selected?.currency ?? ''} readOnly placeholder="Bitte zuerst eine Aktie wählen" {...fieldAria('currency', `${id}-currency-hint`)} /><p id={`${id}-currency-hint`} className="field-hint muted">Die Währung wird vom gewählten Wertpapier übernommen und kann nicht geändert werden.</p>{fieldError('currency')}</div>
          <div className="form-field form-field-full full-width"><label htmlFor={fieldId('note')}>Notiz <span className="muted">(optional)</span></label><textarea id={fieldId('note')} value={note} rows={3} maxLength={500} onChange={event => { setNote(event.target.value); clearField('note'); }} {...fieldAria('note', `${id}-note-hint`)} /><p id={`${id}-note-hint`} className="field-hint muted">{note.length} / 500 Zeichen</p>{fieldError('note')}</div>
        </div>
      </fieldset>
    </form>
  </Dialog>;
}
