import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AlertCondition, Instrument, PriceAlertInput, Quote } from '@shared/types';
import { api, ApiError, errorMessage } from '../api/client';
import { money, parseDecimal } from '../lib/format';
import { DataSourceNote } from './DataSourceNote';

const editableFields = ['condition', 'targetPrice', 'note'] as const;

export function AlertForm({ instrument, quote, onSaved, onError, disabled = false }: { instrument: Instrument; quote?: Quote | null; onSaved: () => void; onError?: (error: unknown) => void; disabled?: boolean }) {
  const id = useId();
  const [condition, setCondition] = useState<AlertCondition>('ABOVE');
  const [targetPrice, setTargetPrice] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const fieldId = (field: string) => `${id}-${field}`;
  const availableQuote = quote?.instrumentId === instrument.id && quote.currency === instrument.currency && quote.price != null && Number.isFinite(quote.price) && quote.price > 0 ? quote : null;
  const otherFields = Object.entries(fields).filter(([field]) => !editableFields.some(editable => editable === field));

  const clearField = (field: string) => {
    setSaved(false);
    setFields(current => { const result = { ...current }; delete result[field]; return result; });
  };
  const fieldError = (field: string) => fields[field] ? <p id={`${fieldId(field)}-error`} className="field-error" aria-live="polite">{fields[field]}</p> : null;
  const fieldAria = (field: string, hint?: string) => ({
    'aria-invalid': Boolean(fields[field]),
    'aria-describedby': [fields[field] ? `${fieldId(field)}-error` : '', hint ?? ''].filter(Boolean).join(' ') || undefined,
  });
  const focusError = (errors: Record<string, string>) => {
    requestAnimationFrame(() => {
      const first = editableFields.find(field => errors[field]);
      document.getElementById(first ? fieldId(first) : `${id}-error`)?.focus();
    });
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || disabled) return;
    const errors: Record<string, string> = {};
    const price = parseDecimal(targetPrice);
    if (condition !== 'ABOVE' && condition !== 'BELOW') errors.condition = 'Bitte wähle eine Bedingung für den Kursalarm.';
    if (price == null || price <= 0) errors.targetPrice = 'Bitte gib einen gültigen Zielkurs größer als 0 ein, zum Beispiel 125,50.';
    if (note.length > 200) errors.note = 'Die Notiz darf höchstens 200 Zeichen enthalten.';
    setError(null);
    setSaved(false);
    setFields(errors);
    if (Object.keys(errors).length || price == null) { focusError(errors); return; }

    const input: PriceAlertInput = { instrument, condition, targetPrice: price, note: note.trim() || null };
    submitting.current = true;
    setBusy(true);
    try {
      await api.createAlert(input);
      setTargetPrice('');
      setNote('');
      setSaved(true);
      onSaved();
    } catch (failure) {
      setError(failure);
      const failureFields = failure instanceof ApiError ? failure.fields : {};
      setFields(failureFields);
      onError?.(failure);
      focusError(failureFields);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <form className="alert-form" onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
    {error != null && <div id={`${id}-error`} className="form-error" role="alert" tabIndex={-1}>
      <strong>Kursalarm konnte nicht angelegt werden.</strong>
      <p>{errorMessage(error)}</p>
      {otherFields.length > 0 && <ul>{otherFields.map(([field, message]) => <li key={field}>{message}</li>)}</ul>}
    </div>}
    {saved && <p className="muted" role="status">Dein Kursalarm wurde angelegt.</p>}
    <fieldset className="alert-form-fields" disabled={busy || disabled}>
      <legend className="sr-only">Neuen Kursalarm anlegen</legend>
      <div className="alert-form-quote">
        <p className="field-hint">{availableQuote ? <>Aktueller Kurs zur Orientierung: <strong>{money(availableQuote.price, instrument.currency)}</strong></> : 'Aktueller Kurs zur Orientierung: nicht verfügbar.'}</p>
        {availableQuote && <DataSourceNote meta={availableQuote.meta} asOf={availableQuote.asOf} />}
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor={fieldId('condition')}>Bedingung</label>
          <select id={fieldId('condition')} value={condition} onChange={event => { setCondition(event.target.value as AlertCondition); clearField('condition'); }} required {...fieldAria('condition')}>
            <option value="ABOVE">Kurs steigt auf oder über</option>
            <option value="BELOW">Kurs fällt auf oder unter</option>
          </select>
          {fieldError('condition')}
        </div>
        <div className="form-field">
          <label htmlFor={fieldId('targetPrice')}>Zielkurs ({instrument.currency})</label>
          <input id={fieldId('targetPrice')} type="text" inputMode="decimal" placeholder="z. B. 125,50" value={targetPrice} onChange={event => { setTargetPrice(event.target.value); clearField('targetPrice'); }} required {...fieldAria('targetPrice', `${id}-price-hint`)} />
          <p id={`${id}-price-hint`} className="field-hint">In der Handelswährung {instrument.currency}, größer als 0. Dezimalstellen kannst du mit Komma eingeben.</p>
          {fieldError('targetPrice')}
        </div>
        <div className="form-field form-field-full full-width">
          <label htmlFor={fieldId('note')}>Notiz <span className="muted">(optional)</span></label>
          <textarea id={fieldId('note')} value={note} rows={2} maxLength={200} onChange={event => { setNote(event.target.value); clearField('note'); }} {...fieldAria('note', `${id}-note-hint`)} />
          <p id={`${id}-note-hint`} className="field-hint">{note.length} / 200 Zeichen</p>
          {fieldError('note')}
        </div>
      </div>
      <div className="actions alert-form-actions"><button type="submit" className="button button-primary" disabled={busy || disabled}>{busy ? 'Wird angelegt …' : 'Kursalarm anlegen'}</button></div>
    </fieldset>
  </form>;
}
