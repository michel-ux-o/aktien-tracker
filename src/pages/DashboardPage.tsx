import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryRange, Portfolio, Position } from '@shared/types';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { dateTime, instrumentPath, money, number } from '../lib/format';
import { dashboardMovers } from '../lib/dashboardMovers';
import { AllocationChart } from '../components/AllocationChart';
import { ChangeValue } from '../components/ChangeValue';
import { DataSourceNote } from '../components/DataSourceNote';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { KpiCard } from '../components/KpiCard';
import { LoadingState } from '../components/LoadingState';
import { PortfolioChart } from '../components/PortfolioChart';
import { StockList } from '../components/StockList';
import { TransactionForm } from '../components/TransactionForm';
import { TriggeredAlertsNotice } from '../components/TriggeredAlertsNotice';

const REFRESH_INTERVAL = 5 * 60 * 1_000;

function ValuationNotes({ portfolio }: { portfolio: Portfolio }) {
  const { summary, positions } = portfolio;
  return (
    <>
      {!summary.complete && (
        <aside className="notice notice-warning" role="status">
          <strong>Eingeschränkte Gesamtauswertung</strong>
          <p>Die Gesamtwerte enthalten nur Positionen, für die die benötigten Daten verfügbar sind.</p>
          {summary.missingPrices.length > 0 && <p>Fehlende Kurse: {summary.missingPrices.map((id) => positions.find((position) => position.instrumentId === id)?.instrument.name ?? id).join(', ')}.</p>}
          {summary.missingFx.length > 0 && <p>Fehlende Wechselkurse: {summary.missingFx.join(', ')} nach {summary.baseCurrency}.</p>}
        </aside>
      )}
      {summary.fxRates.length > 0 && (
        <details className="details-disclosure">
          <summary>Verwendete Wechselkurse · Basiswährung {summary.baseCurrency}</summary>
          <ul className="fx-list">
            {summary.fxRates.map((rate) => <li key={`${rate.from}-${rate.to}`}>1 {rate.from} = {number(rate.rate, 6)} {rate.to} · {rate.source} · Stand {dateTime(rate.asOf)}</li>)}
          </ul>
          <p className="muted">Der Marktwert verwendet aktuelle Wechselkurse, der Einstand historische Wechselkurse der Kauftage. Wechselkursänderungen beeinflussen das unrealisierte Ergebnis.</p>
        </details>
      )}
    </>
  );
}

function Movers({ title, positions, emptyMessage }: { title: string; positions: Position[]; emptyMessage: string }) {
  return (
    <section className="card">
      <div className="card-header"><h2>{title}</h2><span className="muted">Unrealisierter G/V</span></div>
      {positions.length === 0 ? <p className="muted">{emptyMessage}</p> : (
        <ul className="mover-list">
          {positions.map((position) => (
            <li key={position.instrumentId}>
              <div className="toolbar">
                <div><Link className="position-name" to={instrumentPath(position.instrumentId)}>{position.instrument.name}</Link><p className="muted">{position.instrument.symbol} · {position.instrument.exchange}</p></div>
                <ChangeValue value={position.unrealizedPnlPercent} percent showLabel />
              </div>
              <DataSourceNote meta={position.quote?.meta} asOf={position.quote?.asOf} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function DashboardPage() {
  const { settings } = useAuth();
  const [range, setRange] = useState<HistoryRange>('1Y');
  const [showTransaction, setShowTransaction] = useState(false);
  const portfolio = useResource(() => api.portfolio(), [settings?.baseCurrency], { refreshInterval: REFRESH_INTERVAL });
  const history = useResource(() => api.portfolioHistory(range), [range, settings?.baseCurrency], { refreshInterval: REFRESH_INTERVAL });
  const watchlist = useResource(() => api.watchlist(), [], { refreshInterval: REFRESH_INTERVAL });

  const reload = () => { portfolio.reload(); history.reload(); watchlist.reload(); };
  const data = portfolio.data;
  const isEmpty = data !== null && data.positions.length === 0 && data.closedPositions.length === 0;
  const winners = dashboardMovers(data?.positions ?? [], 'winners');
  const losers = dashboardMovers(data?.positions ?? [], 'losers');

  return (
    <div className="section-stack">
      <header className="page-heading">
        <div><p className="eyebrow">Dein Überblick</p><h1>Dashboard</h1><p className="muted">Bestand, Entwicklung und Beobachtung an einem Ort.</p></div>
        <div className="actions"><button className="button button-primary" type="button" onClick={() => setShowTransaction(true)}>Transaktion hinzufügen</button><Link className="button button-secondary" to="/suche">Aktie suchen</Link></div>
      </header>

      <TriggeredAlertsNotice />
      {portfolio.error != null && <ErrorState error={portfolio.error} onRetry={portfolio.reload} />}
      {portfolio.loading && !data && <LoadingState label="Portfolio wird geladen" />}
      {data && (
        <>
          {!isEmpty && <>
          <ValuationNotes portfolio={data} />
          <div className="kpi-grid">
            <KpiCard title="Portfoliowert" value={money(data.summary.totalMarketValue, data.summary.baseCurrency)} subtitle={`${data.summary.openPositionCount} offene ${data.summary.openPositionCount === 1 ? 'Position' : 'Positionen'}`} />
            <KpiCard title="Investiertes Kapital" value={money(data.summary.totalCostBasis, data.summary.baseCurrency)} subtitle="Einstand der offenen Positionen" />
            <KpiCard title="Unrealisierter G/V" value={<ChangeValue value={data.summary.unrealizedPnl} currency={data.summary.baseCurrency} showLabel />} subtitle={<ChangeValue value={data.summary.unrealizedPnlPercent} percent />} />
            <KpiCard title="Tagesveränderung" value={<ChangeValue value={data.summary.dayChange} currency={data.summary.baseCurrency} />} subtitle={<ChangeValue value={data.summary.dayChangePercent} percent />} />
            <KpiCard title="Realisierter G/V" value={<ChangeValue value={data.summary.realizedPnl} currency={data.summary.baseCurrency} showLabel />} subtitle="Ergebnisse aus Verkäufen nach Gebühren" />
            {data.summary.dividends != null && <KpiCard title="Dividenden (netto)" value={money(data.summary.dividends, data.summary.baseCurrency)} subtitle="Nach eingegebenen Abzügen" />}
            <KpiCard title="Gesamtergebnis" value={<ChangeValue value={data.summary.realizedPnl == null || data.summary.unrealizedPnl == null ? null : data.summary.realizedPnl + data.summary.unrealizedPnl} currency={data.summary.baseCurrency} showLabel />} subtitle="Realisiert + unrealisiert, ohne Einzahlungen" />
          </div>
          <details className="details-disclosure">
            <summary>Quelle und Datenstand der Portfoliobewertung</summary>
            {data.positions.length === 0 ? <p className="muted">Noch keine offenen Positionen.</p> : data.positions.map((position) => <div key={position.instrumentId}><strong>{position.instrument.symbol}</strong>{position.quote ? <DataSourceNote meta={position.quote.meta} asOf={position.quote.asOf} /> : <p className="muted">Kursdaten nicht verfügbar.</p>}</div>)}
          </details>
          </>}
          {isEmpty ? (
            <section className="card">
              <EmptyState title="Dein Portfolio beginnt mit der ersten Transaktion" description="Suche ein Wertpapier und erfasse einen Kauf. Danach siehst du hier deinen Bestand und seine Entwicklung." action={<Link className="button button-primary" to="/suche">Erste Aktie suchen</Link>} />
              <ol className="flow-steps"><li><strong>Aktie suchen</strong><span className="muted">Name oder Ticker eingeben und Börsenplatz auswählen.</span></li><li><strong>Transaktion erfassen</strong><span className="muted">Datum, Stückzahl, Preis und Gebühren eintragen.</span></li><li><strong>Überblick behalten</strong><span className="muted">Wertentwicklung und Datenstand hier nachvollziehen.</span></li></ol>
            </section>
          ) : (
            <>
              <div className="grid-two">
                <section className="card"><p className="eyebrow">Bewertung in {data.summary.baseCurrency}</p><PortfolioChart history={history.data} range={range} onRangeChange={setRange} loading={history.loading} error={history.error} onRetry={history.reload} /></section>
                <section className="card"><AllocationChart positions={data.positions} currency={data.summary.baseCurrency} /><div className="actions"><Link to="/portfolio">Alle Positionen ansehen</Link></div></section>
              </div>
              <div className="grid-two market-movers"><Movers title="Größte Gewinner" {...winners} /><Movers title="Größte Verlierer" {...losers} /></div>
            </>
          )}
        </>
      )}

      <section className="card">
        <div className="card-header"><h2>Deine Watchlist</h2><Link to="/watchlist">Watchlist öffnen</Link></div>
        {watchlist.error != null && <ErrorState error={watchlist.error} onRetry={watchlist.reload} />}
        {watchlist.loading && !watchlist.data && <LoadingState label="Watchlist wird geladen" />}
        {watchlist.data && (watchlist.data.items.length > 0 ? <StockList items={watchlist.data.items.slice(0, 4)} /> : <EmptyState title="Behalte interessante Aktien im Blick" description="Füge Wertpapiere über die Suche zu deiner Watchlist hinzu." action={<Link className="button button-secondary" to="/suche">Aktien entdecken</Link>} />)}
      </section>
      {showTransaction && <TransactionForm onClose={() => setShowTransaction(false)} onSaved={() => { setShowTransaction(false); reload(); }} />}
    </div>
  );
}
