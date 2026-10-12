import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PriceAlert } from '@shared/types';
import { api, ApiError } from '../api/client';
import { dateTime, instrumentPath, money } from '../lib/format';
import { ChangeValue } from './ChangeValue';
import { ConfirmDialog } from './ConfirmDialog';
import { DataSourceNote } from './DataSourceNote';
import { ErrorState } from './ErrorState';

export function AlertList({ alerts, onChanged }: { alerts: PriceAlert[]; onChanged: () => void }) {
  const [removingAlert, setRemovingAlert] = useState<PriceAlert | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; type: 'reactivate' | 'delete' } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const submitting = useRef(false);
  const listRoot = useRef<HTMLDivElement>(null);

  const reactivate = async (alert: PriceAlert, row: HTMLElement | null) => {
    if (submitting.current) return;
    const heading = listRoot.current?.closest('section')?.querySelector<HTMLElement>('h2');
    submitting.current = true;
    setPendingAction({ id: alert.id, type: 'reactivate' });
    setError(null);
    try {
      await api.reactivateAlert(alert.id);
      requestAnimationFrame(() => {
        if (row?.isConnected) row.focus();
        else if (heading?.isConnected) heading.focus();
      });
    } catch (failure) {
      setError(failure);
    } finally {
      submitting.current = false;
      setPendingAction(null);
      // A lost response can still mean the server saved the change.
      onChanged();
    }
  };

  const remove = async () => {
    if (!removingAlert || submitting.current) return;
    const heading = listRoot.current?.closest('section')?.querySelector<HTMLElement>('h2');
    submitting.current = true;
    setPendingAction({ id: removingAlert.id, type: 'delete' });
    setError(null);
    try {
      try {
        await api.deleteAlert(removingAlert.id);
      } catch (failure) {
        // A retry can encounter an alarm already deleted by the preceding request.
        if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
      }
      setRemovingAlert(null);
      // Run after the dialog closes and restores focus to its former trigger.
      requestAnimationFrame(() => { if (heading?.isConnected) heading.focus(); });
    } finally {
      submitting.current = false;
      setPendingAction(null);
      onChanged();
    }
  };

  return <div ref={listRoot} className="alert-list">
    {error != null && <ErrorState error={error} />}
    <ul className="alert-rows" aria-label="Kursalarme">
      {alerts.map(alert => {
        const triggered = alert.triggeredAt != null;
        const condition = alert.condition === 'ABOVE' ? 'Kurs steigt auf oder über' : 'Kurs fällt auf oder unter';
        const alarmLabel = `${alert.instrument.name}: ${condition} ${money(alert.targetPrice, alert.currency)}`;
        const reactivating = pendingAction?.id === alert.id && pendingAction.type === 'reactivate';
        return <li key={alert.id} className={`alert-item${triggered ? ' alert-item-triggered' : ''}`} aria-busy={pendingAction?.id === alert.id} tabIndex={-1}>
          <div className="alert-identity">
            <Link className="stock-identity" to={instrumentPath(alert.instrumentId)}>
              <strong>{alert.instrument.name}</strong>
              <span className="stock-symbol">{alert.instrument.symbol} · {alert.instrument.exchange} · {alert.currency}</span>
            </Link>
            {alert.note && <p className="alert-note"><span className="sr-only">Notiz: </span>{alert.note}</p>}
          </div>
          <div className="alert-target">
            <span className="alert-label">Bedingung und Zielkurs</span>
            <span className="alert-condition">{condition}</span>
            <strong>{money(alert.targetPrice, alert.currency)}</strong>
          </div>
          <div className="alert-quote">
            <span className="alert-label">Aktueller Kurs</span>
            <strong>{money(alert.quote?.price, alert.quote?.currency ?? alert.currency)}</strong>
            {alert.quote?.changePercent != null && <span className="alert-change">Heute: <ChangeValue value={alert.quote.changePercent} percent /></span>}
            <DataSourceNote meta={alert.quote?.meta} asOf={alert.quote?.asOf} />
          </div>
          <div className="alert-status">
            <span className="alert-label">Status</span>
            <span className={`alert-status-badge ${triggered ? 'alert-status-triggered' : 'alert-status-active'}`}>{triggered ? 'Ausgelöst' : 'Aktiv'}</span>
            {triggered && <p className="alert-trigger-details">am {dateTime(alert.triggeredAt)}<br />{alert.triggeredPrice == null ? 'Auslösekurs nicht verfügbar' : `bei ${money(alert.triggeredPrice, alert.currency)}`}</p>}
          </div>
          <div className="alert-actions" role="group" aria-label={`Aktionen für ${alarmLabel}`}>
            {triggered && <button type="button" className="button button-secondary" disabled={pendingAction != null} onClick={event => void reactivate(alert, event.currentTarget.closest('li'))} aria-label={`${alarmLabel} reaktivieren`}>{reactivating ? 'Wird reaktiviert …' : 'Reaktivieren'}</button>}
            <button type="button" className="button button-secondary" disabled={pendingAction != null} onClick={() => { setError(null); setRemovingAlert(alert); }} aria-label={`${alarmLabel} löschen`}>Löschen</button>
          </div>
        </li>;
      })}
    </ul>
    {removingAlert && <ConfirmDialog title="Kursalarm löschen?" description={`Der Alarm für ${removingAlert.instrument.name} (${removingAlert.instrument.symbol}) mit dem Zielkurs ${money(removingAlert.targetPrice, removingAlert.currency)} wird gelöscht.`} onConfirm={remove} onClose={() => setRemovingAlert(null)} />}
  </div>;
}
