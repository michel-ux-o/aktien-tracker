import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { number } from '../lib/format';
import { useResource } from '../lib/useResource';

export function TriggeredAlertsNotice() {
  const resource = useResource(() => api.alerts());
  const count = resource.data?.triggeredCount ?? 0;

  if (resource.error != null || count <= 0) return null;

  return (
    <aside className="notice notice-warning alert-triggered-notice" role="status" aria-live="polite">
      <div>
        <strong>{count === 1 ? '1 Kursalarm wurde ausgelöst' : `${number(count, 0)} Kursalarme wurden ausgelöst`}</strong>
        <p>Schau dir die erreichten Zielkurse und den Datenstand an.</p>
      </div>
      <Link className="button button-secondary" to="/alarme">Kursalarme ansehen</Link>
    </aside>
  );
}
