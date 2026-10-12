import { Link } from 'react-router-dom';
import { MAX_PRICE_ALERTS } from '@shared/api';
import { api } from '../api/client';
import { AlertList } from '../components/AlertList';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { number } from '../lib/format';
import { useResource } from '../lib/useResource';

export default function AlertsPage() {
  const resource = useResource(() => api.alerts());
  const alerts = resource.data?.alerts.toSorted((left, right) => Number(right.triggeredAt != null) - Number(left.triggeredAt != null)) ?? [];

  return (
    <div className="section-stack alert-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Deine Kursziele im Blick</p>
          <h1>Kursalarme</h1>
          <p className="muted">Sieh, welche Zielkurse erreicht wurden, und verwalte deine Alarme.</p>
        </div>
        <Link className="button button-secondary" to="/suche">Aktie suchen</Link>
      </header>
      <aside className="notice alert-check-note">
        <strong>Alarme werden beim Öffnen der App geprüft.</strong>
        <p>Du findest ausgelöste Alarme hier. Es gibt keine Push- oder E-Mail-Benachrichtigung. Die Prüfung nutzt die verfügbaren Kurse; diese können verzögert sein.</p>
      </aside>
      <section className="card" aria-labelledby="alerts-heading">
        <div className="card-header">
          <h2 id="alerts-heading" tabIndex={-1}>Deine Alarme</h2>
          {resource.data && <span className="muted">{number(alerts.length, 0)} von {number(MAX_PRICE_ALERTS, 0)} Alarmen{resource.data.triggeredCount > 0 && ` · ${number(resource.data.triggeredCount, 0)} ausgelöst`}</span>}
        </div>
        {resource.error != null && <ErrorState error={resource.error} onRetry={resource.reload} />}
        {resource.loading && !resource.data && <LoadingState label="Kursalarme werden geladen" />}
        {resource.data && (alerts.length > 0 ? <>
          <p className="muted alert-list-intro">Ausgelöste Alarme stehen zuerst. Neue Alarme legst du im Abschnitt „Kursalarme“ auf der Detailseite einer Aktie an. Du kannst insgesamt bis zu {number(MAX_PRICE_ALERTS, 0)} Alarme speichern.</p>
          <AlertList alerts={alerts} onChanged={resource.reload} />
        </> : <EmptyState
          title="Du hast noch keine Kursalarme"
          description={`Suche eine Aktie und öffne ihre Detailseite. Im Abschnitt „Kursalarme“ wählst du eine Bedingung und einen Zielkurs in der Handelswährung. Du kannst bis zu ${number(MAX_PRICE_ALERTS, 0)} Alarme speichern.`}
          action={<Link className="button button-primary" to="/suche">Erste Aktie suchen</Link>}
        />)}
      </section>
    </div>
  );
}
