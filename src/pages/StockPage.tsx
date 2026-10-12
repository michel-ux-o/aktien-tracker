import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { HistoryRange, Transaction } from "@shared/types";
import { api, ApiError } from "../api/client";
import { AlertForm } from "../components/AlertForm";
import { AlertList } from "../components/AlertList";
import { ChangeValue } from "../components/ChangeValue";
import { DataSourceNote } from "../components/DataSourceNote";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { PriceChart } from "../components/PriceChart";
import { TransactionForm } from "../components/TransactionForm";
import { date, formatSplitRatio, formatTransactionType, money, number } from "../lib/format";
import { useResource } from "../lib/useResource";

/** Spaltenwerte je Transaktionsart: Splits haben ein Verhältnis statt Stück/Preis, Dividenden Abzüge statt Gebühren. */
function transactionCells(transaction: Transaction) {
  if (transaction.type === "SPLIT") {
    return { quantity: `Verhältnis ${formatSplitRatio(transaction.ratio)}`, price: "–", fees: "–", net: null };
  }
  const net = transaction.type === "DIVIDEND" ? transaction.quantity * transaction.price - transaction.fees : null;
  return {
    quantity: number(transaction.quantity, 8),
    price: money(transaction.price, transaction.currency),
    fees: money(transaction.fees, transaction.currency),
    net: net === null ? null : money(net, transaction.currency),
  };
}

function websiteHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function StockPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [range, setRange] = useState<HistoryRange>("1Y");
  const [formOpen, setFormOpen] = useState(false);
  const [editedTransaction, setEditedTransaction] = useState<Transaction | undefined>();
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistError, setWatchlistError] = useState<unknown>(null);
  const [watchlistNotice, setWatchlistNotice] = useState("");
  const profile = useResource(() => api.profile(id), [id]);
  const quote = useResource(() => api.quote(id), [id], { refreshInterval: 300_000 });
  const history = useResource(() => api.history(id, range), [id, range]);
  const watchlist = useResource(() => api.watchlist(), [id]);
  const portfolio = useResource(() => api.portfolio(), [id], { refreshInterval: 300_000 });
  const transactions = useResource(() => api.transactions(id), [id]);
  const alerts = useResource(() => api.alerts(id), [id], { refreshInterval: 300_000 });

  useEffect(() => {
    setRange("1Y");
    setFormOpen(false);
    setEditedTransaction(undefined);
    setWatchlistError(null);
    setWatchlistNotice("");
  }, [id]);

  useEffect(() => {
    const supported = history.data?.supportedRanges;
    if (supported && supported.length > 0 && !supported.includes(range)) {
      setRange(supported[0]!);
    }
  }, [history.data, range]);

  const instrument = profile.data;
  const isWatched = watchlist.data?.items.some((item) => item.instrument.id === id) ?? false;
  const position = portfolio.data?.positions.find((item) => item.instrumentId === id)
    ?? portfolio.data?.closedPositions.find((item) => item.instrumentId === id);

  async function toggleWatchlist() {
    if (!instrument || watchlistBusy) return;
    setWatchlistBusy(true);
    setWatchlistError(null);
    setWatchlistNotice("");
    try {
      if (isWatched) await api.removeWatchlist(id);
      else await api.addWatchlist(instrument);
      setWatchlistNotice(isWatched ? "Aus der Watchlist entfernt." : "Zur Watchlist hinzugefügt.");
      watchlist.reload();
    } catch (error) {
      setWatchlistError(error);
      // A lost response may still have changed the server state. Read it before
      // another action so that a retry cannot accidentally reverse the intent.
      watchlist.reload();
    } finally {
      setWatchlistBusy(false);
    }
  }

  function openTransaction(transaction?: Transaction) {
    setEditedTransaction(transaction);
    setFormOpen(true);
  }

  function transactionSaved() {
    setFormOpen(false);
    setEditedTransaction(undefined);
    portfolio.reload();
    transactions.reload();
  }

  if (profile.loading && !instrument) return <LoadingState label="Aktieninformationen werden geladen" />;
  if (profile.error instanceof ApiError && profile.error.status === 404 && !instrument) return <EmptyState title="Wertpapier nicht gefunden" description="Die angefragte Aktie ist nicht verfügbar. Suche nach dem Namen oder Ticker, um einen gültigen Treffer zu öffnen." action={<Link className="button button-primary" to="/suche">Aktie suchen</Link>} />;
  if (profile.error && !instrument) return <ErrorState error={profile.error} onRetry={profile.reload} />;
  if (!instrument) return <EmptyState title="Wertpapier nicht gefunden" description="Suche nach dem Namen oder Ticker des Wertpapiers." action={<Link className="button button-primary" to="/suche">Aktie suchen</Link>} />;

  const website = websiteHref(instrument.website);
  const ownTransactions = transactions.data?.transactions ?? [];

  return (
    <div className="section-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{instrument.symbol} · {instrument.exchange}</p>
          <h1>{instrument.name}</h1>
          <p className="muted">Handelswährung {instrument.currency} · Börsenplatz {instrument.mic}</p>
        </div>
        <div className="actions">
          <button className="button button-secondary" type="button" onClick={toggleWatchlist} disabled={watchlistBusy || watchlist.loading || watchlist.error != null}>
            {watchlistBusy ? "Wird gespeichert …" : isWatched ? "Von Watchlist entfernen" : "Zur Watchlist hinzufügen"}
          </button>
          <button className="button button-primary" type="button" onClick={() => openTransaction()}>Transaktion erfassen</button>
        </div>
      </div>

      <div aria-live="polite" role="status">{watchlistNotice}</div>
      {watchlist.error != null && <ErrorState error={watchlist.error} onRetry={watchlist.reload} />}
      {watchlistError != null && <ErrorState error={watchlistError} onRetry={() => { setWatchlistError(null); watchlist.reload(); }} />}

      <section className="card" aria-labelledby="quote-heading">
        <div className="card-header">
          <h2 id="quote-heading">Letzter verfügbarer Kurs</h2>
          {quote.data && <span className="muted">{quote.data.isMarketOpen === true ? "Börse geöffnet" : quote.data.isMarketOpen === false ? "Börse geschlossen" : "Börsenstatus nicht verfügbar"}</span>}
        </div>
        {quote.loading && !quote.data ? <LoadingState label="Kurs wird geladen" /> : quote.error ? <ErrorState error={quote.error} onRetry={quote.reload} /> : quote.data ? (
          <>
            <p className="value-large">{quote.data.price == null ? "Nicht verfügbar" : money(quote.data.price, quote.data.currency)}</p>
            <div className="actions" aria-label="Tagesveränderung">
              <span className="muted">Tagesveränderung</span>
              <ChangeValue value={quote.data.change} currency={quote.data.currency} showLabel />
              <ChangeValue value={quote.data.changePercent} percent />
            </div>
            {quote.data.price == null && <p className="muted">Für dieses Wertpapier liegt derzeit kein Kurs vor.</p>}
            <DataSourceNote meta={quote.data.meta} asOf={quote.data.asOf} />
          </>
        ) : <p className="muted">Keine Kursdaten verfügbar.</p>}
      </section>

      <div className="card">
        <PriceChart history={history.data} range={range} onRangeChange={setRange} loading={history.loading} error={history.error} onRetry={history.reload} />
      </div>

      <section className="card alert-stock-section" aria-labelledby="alerts-heading">
        <div className="card-header"><h2 id="alerts-heading" tabIndex={-1}>Kursalarme</h2><Link to="/alarme">Alle Kursalarme</Link></div>
        <p className="notice alert-explanation">Deine Alarme werden beim Öffnen der App und beim Laden der Kursalarme mit dem letzten verfügbaren Kurs geprüft. Es gibt keine Push- oder E-Mail-Benachrichtigung.</p>
        <div className="alert-stock-content">
          <div className="section-stack" aria-busy={alerts.loading}>
            <h3>Deine Alarme für {instrument.symbol}{alerts.data && <span className="muted"> · {number(alerts.data.alerts.length, 0)}</span>}</h3>
            {alerts.error != null && <ErrorState error={alerts.error} onRetry={alerts.reload} />}
            {alerts.loading && !alerts.data && <LoadingState label="Kursalarme werden geladen" />}
            {alerts.data && (alerts.data.alerts.length > 0 ? <AlertList alerts={alerts.data.alerts} onChanged={alerts.reload} /> : <EmptyState title="Noch kein Kursalarm für diese Aktie" description="Lege hier einen Zielkurs fest. Du siehst in der App, sobald der letzte verfügbare Kurs deine Bedingung erfüllt." />)}
          </div>
          <div className="alert-stock-form">
            <h3>Neuen Kursalarm anlegen</h3>
            <AlertForm key={instrument.id} instrument={instrument} quote={quote.error == null ? quote.data : null} onSaved={alerts.reload} onError={alerts.reload} />
          </div>
        </div>
      </section>

      <div className="grid-two">
        <section className="card" aria-labelledby="profile-heading">
          <div className="card-header"><h2 id="profile-heading">Basisinformationen</h2></div>
          <dl className="definition-list">
            <dt>Ticker</dt><dd>{instrument.symbol}</dd>
            <dt>ISIN</dt><dd>{instrument.isin ?? "Nicht verfügbar"}</dd>
            <dt>Börsenplatz</dt><dd>{instrument.exchange} ({instrument.mic})</dd>
            <dt>Währung</dt><dd>{instrument.currency}</dd>
            <dt>Land</dt><dd>{instrument.country ?? "Nicht verfügbar"}</dd>
            <dt>Wertpapierart</dt><dd>{instrument.type ?? "Nicht verfügbar"}</dd>
            <dt>Sektor</dt><dd>{instrument.sector ?? "Nicht verfügbar"}</dd>
            <dt>Branche</dt><dd>{instrument.industry ?? "Nicht verfügbar"}</dd>
            <dt>Marktkapitalisierung</dt><dd>{instrument.marketCap == null ? "Nicht verfügbar" : money(instrument.marketCap, instrument.currency)}</dd>
            <dt>52-Wochen-Hoch</dt><dd>{instrument.fiftyTwoWeekHigh == null ? "Nicht verfügbar" : money(instrument.fiftyTwoWeekHigh, instrument.currency)}</dd>
            <dt>52-Wochen-Tief</dt><dd>{instrument.fiftyTwoWeekLow == null ? "Nicht verfügbar" : money(instrument.fiftyTwoWeekLow, instrument.currency)}</dd>
            <dt>Website</dt><dd>{website ? <a href={website} target="_blank" rel="noopener noreferrer">Unternehmenswebsite <span className="muted">(neuer Tab)</span></a> : "Nicht verfügbar"}</dd>
          </dl>
          <p>{instrument.description ?? "Unternehmensbeschreibung: Nicht verfügbar."}</p>
          <DataSourceNote meta={instrument.meta} />
        </section>

        <section className="card" aria-labelledby="position-heading">
          <div className="card-header"><h2 id="position-heading">Deine Position</h2><Link to="/portfolio">Zum Portfolio</Link></div>
          {portfolio.loading && !portfolio.data ? <LoadingState label="Position wird geladen" /> : portfolio.error ? <ErrorState error={portfolio.error} onRetry={portfolio.reload} /> : position ? (
            <>
              <p className="eyebrow">{position.quantity > 0 ? "Offene Position" : "Geschlossene Position"} · {position.currency}</p>
              <dl className="definition-list">
                <dt>Stückzahl</dt><dd>{number(position.quantity, 8)}</dd>
                <dt>Ø Einstandskurs</dt><dd>{position.averageCost == null ? "Nicht verfügbar" : money(position.averageCost, position.currency)}</dd>
                <dt>Investiertes Kapital</dt><dd>{money(position.costBasis, position.currency)}</dd>
                <dt>Marktwert</dt><dd>{position.marketValue == null ? "Nicht verfügbar" : money(position.marketValue, position.currency)}</dd>
                {position.quantity > 0 && <><dt>Unrealisierter G/V</dt><dd><ChangeValue value={position.unrealizedPnl} currency={position.currency} showLabel /><br /><ChangeValue value={position.unrealizedPnlPercent} percent /></dd></>}
                <dt>Realisierter G/V</dt><dd><ChangeValue value={position.realizedPnl} currency={position.currency} showLabel /></dd>
                {position.dividends !== 0 && <><dt>Dividenden (netto)</dt><dd>{money(position.dividends, position.currency)}</dd></>}
              </dl>
              {position.quote && <DataSourceNote meta={position.quote.meta} asOf={position.quote.asOf} />}
            </>
          ) : <EmptyState title="Noch keine Position" description="Erfasse einen Kauf, um deinen Bestand und seine Entwicklung zu verfolgen." action={<button type="button" className="button button-secondary" onClick={() => openTransaction()}>Transaktion erfassen</button>} />}
        </section>
      </div>

      <section className="card" aria-labelledby="transactions-heading">
        <div className="card-header"><h2 id="transactions-heading">Deine Transaktionen</h2><span className="muted">{ownTransactions.length} Einträge</span></div>
        {transactions.loading && !transactions.data ? <LoadingState label="Transaktionen werden geladen" /> : transactions.error ? <ErrorState error={transactions.error} onRetry={transactions.reload} /> : ownTransactions.length === 0 ? <EmptyState title="Noch keine Transaktionen" description="Käufe, Verkäufe, Dividenden und Splits für dieses Wertpapier erscheinen hier." /> : (
          <>
            <div className="desktop-table">
              <table className="data-table">
                <caption className="sr-only">Transaktionen für {instrument.name}</caption>
                <thead><tr><th scope="col">Datum</th><th scope="col">Art</th><th scope="col">Stückzahl / Verhältnis</th><th scope="col">Preis bzw. Dividende je Aktie</th><th scope="col">Gebühren / Abzüge</th><th scope="col">Aktion</th></tr></thead>
                <tbody>{ownTransactions.map((transaction) => {
                  const cells = transactionCells(transaction);
                  return <tr key={transaction.id}>
                    <td>{date(transaction.date)}</td>
                    <td>{formatTransactionType(transaction.type)}{cells.net && <p className="muted">Netto {cells.net}</p>}{transaction.note && <p className="muted">{transaction.note}</p>}</td>
                    <td>{cells.quantity}</td>
                    <td>{cells.price}</td>
                    <td>{cells.fees}</td>
                    <td><button type="button" className="button button-secondary button-small" onClick={() => openTransaction(transaction)} aria-label={`${formatTransactionType(transaction.type)} vom ${date(transaction.date)} bearbeiten`}>Bearbeiten</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <div className="mobile-cards">{ownTransactions.map((transaction) => {
              const cells = transactionCells(transaction);
              return <article className="position-card" key={transaction.id}>
                <div className="card-header"><strong>{formatTransactionType(transaction.type)}</strong><span>{date(transaction.date)}</span></div>
                {transaction.type === "SPLIT"
                  ? <dl className="definition-list"><dt>Verhältnis (neu : alt)</dt><dd>{formatSplitRatio(transaction.ratio)}</dd></dl>
                  : <dl className="definition-list"><dt>Stückzahl</dt><dd>{cells.quantity}</dd><dt>{transaction.type === "DIVIDEND" ? "Dividende je Aktie" : "Preis pro Aktie"}</dt><dd>{cells.price}</dd><dt>{transaction.type === "DIVIDEND" ? "Abzüge" : "Gebühren"}</dt><dd>{cells.fees}</dd>{cells.net && <><dt>Netto</dt><dd>{cells.net}</dd></>}</dl>}
                {transaction.note && <p className="muted">{transaction.note}</p>}
                <button type="button" className="button button-secondary button-small" onClick={() => openTransaction(transaction)} aria-label={`${formatTransactionType(transaction.type)} vom ${date(transaction.date)} bearbeiten`}>Bearbeiten</button>
              </article>;
            })}</div>
          </>
        )}
      </section>
      {formOpen && <TransactionForm key={editedTransaction?.id ?? "new"} instrument={instrument} transaction={editedTransaction} onClose={() => setFormOpen(false)} onSaved={transactionSaved} />}
    </div>
  );
}

export default StockPage;
