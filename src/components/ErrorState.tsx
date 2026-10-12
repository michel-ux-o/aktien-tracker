import { errorMessage } from '../api/client';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="error-state" role="alert">
    <strong>Die Anfrage konnte nicht abgeschlossen werden.</strong>
    <p>{errorMessage(error)}</p>
    {onRetry && <button type="button" className="button button-secondary" onClick={onRetry}>Erneut versuchen</button>}
  </div>;
}
