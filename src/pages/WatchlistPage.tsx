import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { WatchlistItem } from '@shared/types';
import { api, ApiError } from '../api/client';
import { useResource } from '../lib/useResource';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { StockList } from '../components/StockList';

export default function WatchlistPage() {
  const [removingItem, setRemovingItem] = useState<WatchlistItem | null>(null);
  const watchlist = useResource(() => api.watchlist(), [], { refreshInterval: 5 * 60 * 1_000 });
  const remove = async () => {
    if (!removingItem) return;
    try {
      await api.removeWatchlist(removingItem.instrument.id);
    } catch (error) {
      // A retry can encounter an item already removed by the preceding request.
      if (!(error instanceof ApiError && error.status === 404)) {
        watchlist.reload();
        throw error;
      }
    }
    setRemovingItem(null);
    watchlist.reload();
  };

  return (
    <div className="section-stack">
      <header className="page-heading"><div><p className="eyebrow">Deine Beobachtung</p><h1>Watchlist</h1><p className="muted">Verfolge Aktien, die dich interessieren.</p></div><div className="actions"><Link className="button button-secondary alert-watchlist-link" to="/alarme">Kursalarme</Link><Link className="button button-primary" to="/suche">Aktie hinzufügen</Link></div></header>
      <section className="card">
        <div className="card-header"><h2>Beobachtete Aktien</h2>{watchlist.data && <span className="muted">{watchlist.data.items.length} {watchlist.data.items.length === 1 ? 'Wertpapier' : 'Wertpapiere'}</span>}</div>
        {watchlist.error != null && <ErrorState error={watchlist.error} onRetry={watchlist.reload} />}
        {watchlist.loading && !watchlist.data && <LoadingState label="Watchlist wird geladen" />}
        {watchlist.data && (watchlist.data.items.length > 0 ? <><p className="muted">Sortiere nach Name oder Tagesveränderung. Kursangaben bleiben in der jeweiligen Handelswährung.</p><StockList items={watchlist.data.items} sortable onRemove={setRemovingItem} /></> : <EmptyState title="Deine Watchlist ist noch leer" description="Suche eine Aktie nach Name oder Ticker und füge sie zu deiner Watchlist hinzu. Ein Portfolioeintrag ist dafür nicht nötig." action={<Link className="button button-primary" to="/suche">Erste Aktie suchen</Link>} />)}
      </section>
      {removingItem && <ConfirmDialog title="Aus der Watchlist entfernen?" description={`${removingItem.instrument.name} (${removingItem.instrument.symbol}) wird aus deiner Watchlist entfernt. Deine Position und Transaktionen bleiben erhalten.`} confirmLabel="Entfernen" onConfirm={remove} onClose={() => setRemovingItem(null)} />}
    </div>
  );
}
