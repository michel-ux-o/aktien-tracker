import { useId, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { ErrorState } from './ErrorState';

export function ConfirmDialog({ title, description, onConfirm, onClose, confirmLabel = 'Löschen' }: {
  title: string; description: string; onConfirm: () => Promise<void> | void; onClose: () => void; confirmLabel?: string;
}) {
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submitting = useRef(false);
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try { await onConfirm(); }
    catch (failure) { setError(failure); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog title={title} onClose={onClose} busy={busy} descriptionId={descriptionId} footer={<>
    <button type="button" className="button button-secondary" onClick={onClose} disabled={busy} data-autofocus>Abbrechen</button>
    <button type="button" className="button button-danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'Wird ausgeführt …' : confirmLabel}</button>
  </>}>
    <p id={descriptionId}>{description}</p>
    {error != null && <ErrorState error={error} />}
  </Dialog>;
}
