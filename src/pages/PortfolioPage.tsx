import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Portfolio, Position, Transaction } from '@shared/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { downloadCsv, transactionsToCsv } from '../lib/csv';
import { date, dateTime, formatSplitRatio, formatTransactionType, instrumentPath, money, number, percent, today } from '../lib/format';
import { ChangeValue } from '../components/ChangeValue';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataSourceNote } from '../components/DataSourceNote';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { KpiCard } from '../components/KpiCard';
import { ImportDialog } from '../components/ImportDialog';
import { LoadingState } from '../components/LoadingState';
import { tableDataSources, TableDataSources, TableQuoteTimestamp } from '../components/TableDataSources';
import { TransactionForm } from '../components/TransactionForm';

const REFRESH_INTERVAL = 5 * 60 * 1_000;

function PortfolioNotes({ portfolio }: { portfolio: Portfolio }) {
  const { summary } = portfolio;
  return (
    <>
      {!summary.complete && <aside className="notice notice-warning" role="status"><strong>Eingeschränkte Gesamtauswertung</strong><p>Gesamtwerte enthalten nur bewertbare Positionen.</p>{summary.missingPrices.length > 0 && <p>Fehlende Kurse: {summary.missingPrices.map((id) => portfolio.positions.find((position) => position.instrumentId === id)?.instrument.name ?? id).join(', ')}.</p>}{summary.missingFx.length > 0 && <p>Fehlende Wechselkurse: {summary.missingFx.join(', ')} nach {summary.baseCurrency}.</p>}</aside>}
      {summary.fxRates.length > 0 && <details className="details-disclosure"><summary>Verwendete Wechselkurse · Basiswährung {summary.baseCurrency}</summary><ul className="fx-list">{summary.fxRates.map((rate) => <li key={`${rate.from}-${rate.to}`}>1 {rate.from} = {number(rate.rate, 6)} {rate.to} · {rate.source} · Stand {dateTime(rate.asOf)}</li>)}</ul></details>}
    </>
  );
}

function PositionValue({ position, baseCurrency }: { position: Position; baseCurrency: string }) {
  return <>{money(position.marketValue, position.currency)}{position.currency !== baseCurrency && <span className="table-secondary">{money(position.marketValueBase, baseCurrency)}</span>}</>;
}

function PositionGain({ position }: { position: Position }) {
  return <><ChangeValue value={position.unrealizedPnl} currency={position.currency} showLabel /><span className="table-secondary"><ChangeValue value={position.unrealizedPnlPercent} percent /></span></>;
}

function PositionIncome({ position, baseCurrency }: { position: Position; baseCurrency: string }) {
  return <div className="position-income">
    {position.dividendsBase != null && <div><span className="table-secondary">Dividenden (netto)</span>{money(position.dividendsBase, baseCurrency)}</div>}
    {position.unrealizedFxEffectBase != null && <div><span className="table-secondary">Währungseffekt</span><ChangeValue value={position.unrealizedFxEffectBase} currency={baseCurrency} /></div>}
  </div>;
}

function Positions({ positions, baseCurrency }: { positions: Position[]; baseCurrency: string }) {
  const sources = tableDataSources(positions.map((position) => position.quote));
  return (
    <>
      <div className="desktop-table">
        <table className="data-table"><caption className="sr-only">Offene Positionen, Kurse und unrealisierte Ergebnisse</caption>
          <thead><tr><th scope="col">Wertpapier</th><th scope="col">Stück</th><th scope="col">Ø Einstand</th><th scope="col">Aktueller Kurs</th><th scope="col">Marktwert</th><th scope="col">Anteil</th><th scope="col">Unrealisierter G/V</th><th scope="col">Dividenden / Währungseffekt ({baseCurrency})</th></tr></thead>
          <tbody>{positions.map((position) => <tr key={position.instrumentId}>
            <th scope="row"><Link className="position-name" to={instrumentPath(position.instrumentId)}>{position.instrument.name}</Link><span className="table-secondary">{position.instrument.symbol} · {position.instrument.exchange} · {position.currency}</span></th>
            <td>{number(position.quantity, 8)}</td><td>{money(position.averageCost, position.currency)}</td>
            <td>{money(position.lastPrice, position.currency)}<TableQuoteTimestamp quote={position.quote} sources={sources} /></td>
            <td><PositionValue position={position} baseCurrency={baseCurrency} /></td><td>{percent(position.weightPercent)}</td><td><PositionGain position={position} /></td><td><PositionIncome position={position} baseCurrency={baseCurrency} /></td>
          </tr>)}</tbody>
        </table>
        <TableDataSources sources={sources} />
      </div>
      <div className="mobile-cards">{positions.map((position) => <article className="position-card" key={position.instrumentId}>
        <h3><Link to={instrumentPath(position.instrumentId)}>{position.instrument.name}</Link></h3><p className="muted">{position.instrument.symbol} · {position.instrument.exchange} · {position.currency}</p>
        <dl className="stat-list"><dt>Stückzahl</dt><dd>{number(position.quantity, 8)}</dd><dt>Ø Einstand</dt><dd>{money(position.averageCost, position.currency)}</dd><dt>Aktueller Kurs</dt><dd>{money(position.lastPrice, position.currency)}</dd><dt>Marktwert</dt><dd><PositionValue position={position} baseCurrency={baseCurrency} /></dd><dt>Anteil</dt><dd>{percent(position.weightPercent)}</dd><dt>Unrealisierter G/V</dt><dd><PositionGain position={position} /></dd>{position.dividendsBase != null && <><dt>Dividenden (netto, {baseCurrency})</dt><dd>{money(position.dividendsBase, baseCurrency)}</dd></>}{position.unrealizedFxEffectBase != null && <><dt>Währungseffekt ({baseCurrency})</dt><dd><ChangeValue value={position.unrealizedFxEffectBase} currency={baseCurrency} /></dd></>}</dl>
        <DataSourceNote meta={position.quote?.meta} asOf={position.quote?.asOf} />
      </article>)}</div>
    </>
  );
}

function RealizedPositions({ positions, baseCurrency }: { positions: Position[]; baseCurrency: string }) {
  return <div className="section-stack">{positions.map((position) => <article className="position-card realized-position" key={position.instrumentId}><div className="toolbar"><div><Link className="position-name" to={instrumentPath(position.instrumentId)}>{position.instrument.name}</Link><p className="muted">{position.instrument.symbol} · {position.quantity === 0 ? 'Geschlossene Position' : 'Offene Position mit Verkäufen'}</p></div><div><ChangeValue value={position.realizedPnlBase} currency={baseCurrency} showLabel />{position.currency !== baseCurrency && <span className="table-secondary"><ChangeValue value={position.realizedPnl} currency={position.currency} /></span>}</div></div><p className="muted">{position.transactionCount} Transaktionen · Gebühren gesamt {money(position.totalFees, position.currency)}</p><PositionIncome position={position} baseCurrency={baseCurrency} /></article>)}</div>;
}

function TransactionActions({ transaction, onEdit, onDelete }: { transaction: Transaction; onEdit: (transaction: Transaction) => void; onDelete: (transaction: Transaction) => void }) {
  const description = `${formatTransactionType(transaction.type)}, ${transaction.instrument.name}, ${date(transaction.date)}`;
  return <div className="row-actions"><button className="button button-secondary button-small" type="button" onClick={() => onEdit(transaction)} aria-label={`Transaktion bearbeiten: ${description}`}>Bearbeiten</button><button className="button button-danger button-small" type="button" onClick={() => onDelete(transaction)} aria-label={`Transaktion löschen: ${description}`}>Löschen</button></div>;
}

function Transactions({ transactions, onEdit, onDelete }: { transactions: Transaction[]; onEdit: (transaction: Transaction) => void; onDelete: (transaction: Transaction) => void }) {
  return <>
    <div className="desktop-table"><table className="data-table"><caption className="sr-only">Erfasste Transaktionen, absteigend nach Datum</caption><thead><tr><th scope="col">Datum</th><th scope="col">Wertpapier</th><th scope="col">Vorgang</th><th scope="col">Ausführung</th><th scope="col">Gebühren / Abzüge</th><th scope="col">Aktionen</th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id}>
      <td>{date(transaction.date)}</td><th scope="row"><Link to={instrumentPath(transaction.instrumentId)}>{transaction.instrument.name}</Link><span className="table-secondary">{transaction.instrument.symbol} · {transaction.currency}</span>{transaction.note && <span className="table-secondary">{transaction.note}</span>}</th>
      <td>{formatTransactionType(transaction.type)}</td><td>{transaction.type === 'SPLIT' ? <>{formatSplitRatio(transaction.ratio)}<span className="table-secondary">Neue : alte Stücke</span></> : transaction.type === 'DIVIDEND' ? <>{money(transaction.quantity * transaction.price - transaction.fees, transaction.currency)} netto<span className="table-secondary">{number(transaction.quantity, 8)} berechtigte Stück · {money(transaction.price, transaction.currency)} je Aktie</span></> : <>{number(transaction.quantity, 8)} Stück<span className="table-secondary">zu {money(transaction.price, transaction.currency)}</span></>}</td>
      <td>{transaction.type === 'SPLIT' ? '—' : money(transaction.fees, transaction.currency)}</td><td><TransactionActions transaction={transaction} onEdit={onEdit} onDelete={onDelete} /></td>
    </tr>)}</tbody></table></div>
    <div className="mobile-cards">{transactions.map((transaction) => <article className="position-card transaction-card" key={transaction.id}>
      <div className="toolbar"><strong>{formatTransactionType(transaction.type)}</strong><span className="muted">{date(transaction.date)}</span></div><h3><Link to={instrumentPath(transaction.instrumentId)}>{transaction.instrument.name}</Link></h3><p className="muted">{transaction.instrument.symbol} · {transaction.currency}</p>
      <dl className="stat-list">{transaction.type === 'SPLIT' ? <><dt>Verhältnis (neu : alt)</dt><dd>{formatSplitRatio(transaction.ratio)}</dd></> : <><dt>{transaction.type === 'DIVIDEND' ? 'Berechtigte Stückzahl' : 'Stückzahl'}</dt><dd>{number(transaction.quantity, 8)}</dd><dt>{transaction.type === 'DIVIDEND' ? 'Dividende je Aktie' : 'Preis je Aktie'}</dt><dd>{money(transaction.price, transaction.currency)}</dd><dt>{transaction.type === 'DIVIDEND' ? 'Abzüge' : 'Gebühren'}</dt><dd>{money(transaction.fees, transaction.currency)}</dd>{transaction.type === 'DIVIDEND' && <><dt>Nettobetrag</dt><dd>{money(transaction.quantity * transaction.price - transaction.fees, transaction.currency)}</dd></>}</>}</dl>
      {transaction.note && <p>{transaction.note}</p>}<TransactionActions transaction={transaction} onEdit={onEdit} onDelete={onDelete} />
    </article>)}</div>
  </>;
}

export default function PortfolioPage() {
  const { settings } = useAuth();
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | undefined>();
  const [deletingTransaction, setDeletingTransaction] = useState<Transaction | null>(null);
  const [filter, setFilter] = useState('all');
  const portfolio = useResource(() => api.portfolio(), [settings?.baseCurrency], { refreshInterval: REFRESH_INTERVAL });
  const transactions = useResource(() => api.transactions(), []);
  const data = portfolio.data;
  const soldInstruments = new Set(transactions.data?.transactions.filter((transaction) => transaction.type === 'SELL').map((transaction) => transaction.instrumentId));
  const realizedPositions = data ? [...data.positions, ...data.closedPositions].filter((position) => position.realizedPnl !== 0 || position.quantity === 0 || soldInstruments.has(position.instrumentId)) : [];
  const instrumentOptions = Array.from(new Map((transactions.data?.transactions ?? []).map((transaction) => [transaction.instrumentId, transaction.instrument])).values()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const activeFilter = filter === 'all' || instrumentOptions.some((instrument) => instrument.id === filter) ? filter : 'all';
  const displayedTransactions = transactions.data?.transactions.filter((transaction) => activeFilter === 'all' || transaction.instrumentId === activeFilter) ?? [];
  const reload = () => { portfolio.reload(); transactions.reload(); };
  const openEdit = (transaction: Transaction) => { setEditingTransaction(transaction); setFormOpen(true); };
  const closeForm = () => { setFormOpen(false); setEditingTransaction(undefined); };
  const exportTransactions = () => {
    if (!transactions.data) return;
    downloadCsv(`transaktionen-${today()}.csv`, transactionsToCsv(transactions.data.transactions));
  };

  const deleteTransaction = async () => {
    if (!deletingTransaction) return;
    try {
      await api.deleteTransaction(deletingTransaction.id);
    } catch (error) {
      // A lost response may leave a successful deletion looking like a failed request.
      if (!(error instanceof ApiError && error.status === 404)) {
        reload();
        throw error;
      }
    }
    setDeletingTransaction(null);
    reload();
  };

  return (
    <div className="section-stack">
      <header className="page-heading"><div><p className="eyebrow">Dein Bestand</p><h1>Portfolio</h1><p className="muted">Offene Positionen und erfasste Transaktionen.</p></div><button className="button button-primary" type="button" onClick={() => { setEditingTransaction(undefined); setFormOpen(true); }}>Transaktion hinzufügen</button></header>
      {portfolio.error != null && <ErrorState error={portfolio.error} onRetry={portfolio.reload} />}
      {portfolio.loading && !data && <LoadingState label="Portfolio wird geladen" />}
      {data && <>
        <PortfolioNotes portfolio={data} />
        <div className="kpi-grid portfolio-kpis"><KpiCard title="Portfoliowert" value={money(data.summary.totalMarketValue, data.summary.baseCurrency)} subtitle={`Bewertung in ${data.summary.baseCurrency}`} /><KpiCard title="Investiertes Kapital" value={money(data.summary.totalCostBasis, data.summary.baseCurrency)} subtitle="Einstand der offenen Positionen" /><KpiCard title="Unrealisierter G/V" value={<ChangeValue value={data.summary.unrealizedPnl} currency={data.summary.baseCurrency} showLabel />} subtitle={<ChangeValue value={data.summary.unrealizedPnlPercent} percent />} /><KpiCard title="Dividenden (netto)" value={money(data.summary.dividends, data.summary.baseCurrency)} subtitle={`Nach eingegebenen Abzügen · ${data.summary.baseCurrency}`} /><KpiCard title="Währungseffekt" value={<ChangeValue value={data.summary.unrealizedFxEffect} currency={data.summary.baseCurrency} showLabel />} subtitle="Anteil am unrealisierten Ergebnis aus Wechselkursänderungen seit dem Kauf." /></div>
        <section className="card"><div className="card-header"><h2>Offene Positionen</h2><span className="muted">{data.positions.length} {data.positions.length === 1 ? 'Position' : 'Positionen'}</span></div>{data.positions.length > 0 ? <Positions positions={data.positions} baseCurrency={data.summary.baseCurrency} /> : <EmptyState title="Noch keine offenen Positionen" description="Suche eine Aktie und erfasse deinen ersten Kauf. Bereits verkaufte Positionen findest du bei den realisierten Ergebnissen." action={<Link className="button button-secondary" to="/suche">Aktie suchen</Link>} />}</section>
        <section className="card"><div className="card-header"><h2>Realisierte Ergebnisse</h2><ChangeValue value={data.summary.realizedPnl} currency={data.summary.baseCurrency} showLabel /></div><p className="muted">Ergebnisse aus Verkäufen nach Gebühren, einschließlich vollständig geschlossener Positionen.</p>{realizedPositions.length > 0 ? <RealizedPositions positions={realizedPositions} baseCurrency={data.summary.baseCurrency} /> : <p className="muted">Noch keine realisierten Ergebnisse oder geschlossenen Positionen.</p>}</section>
      </>}

      <section className="card"><div className="card-header"><h2>Transaktionen</h2>{transactions.data && <div className="actions portfolio-csv-actions"><span className="muted">{transactions.data.transactions.length} Einträge</span>{transactions.data.transactions.length > 0 && <button className="button button-secondary button-small" type="button" onClick={exportTransactions}>CSV exportieren</button>}<button className="button button-secondary button-small" type="button" onClick={() => setImportOpen(true)}>CSV importieren</button></div>}</div>
        {transactions.error != null && <ErrorState error={transactions.error} onRetry={transactions.reload} />}
        {transactions.loading && !transactions.data && <LoadingState label="Transaktionen werden geladen" />}
        {transactions.data && (transactions.data.transactions.length === 0 ? <EmptyState title="Noch keine Transaktionen" description="Erfasse Käufe, Verkäufe, Dividenden und Splits mit ihrem tatsächlichen Datum oder importiere deinen CSV-Export." action={<button className="button button-primary" type="button" onClick={() => setFormOpen(true)}>Erste Transaktion erfassen</button>} /> : <>
          <div className="field portfolio-filters"><label htmlFor="transaction-instrument-filter">Wertpapier filtern</label><select id="transaction-instrument-filter" value={activeFilter} onChange={(event) => setFilter(event.target.value)}><option value="all">Alle Wertpapiere</option>{instrumentOptions.map((instrument) => <option value={instrument.id} key={instrument.id}>{instrument.name} ({instrument.symbol})</option>)}</select></div>
          {displayedTransactions.length > 0 ? <Transactions transactions={displayedTransactions} onEdit={openEdit} onDelete={setDeletingTransaction} /> : <p className="muted">Für dieses Wertpapier sind keine Transaktionen vorhanden.</p>}
        </>)}
      </section>
      <details className="card details-disclosure"><summary>So rechnen wir</summary><div className="section-stack"><p><strong>Durchschnittskostenmethode:</strong> Der Einstandskurs entspricht den durchschnittlichen Kosten der noch gehaltenen Stücke. Kaufgebühren erhöhen den Einstand; Verkaufsgebühren mindern den Erlös.</p><p><strong>Realisiert und unrealisiert:</strong> Realisierte Ergebnisse entstehen durch Verkäufe. Unrealisierte Ergebnisse vergleichen den aktuellen Marktwert mit dem Einstand der offenen Positionen.</p><p><strong>Dividenden und Splits:</strong> Dividenden werden nach den eingegebenen Abzügen separat ausgewiesen. Splits ändern die Stückzahl und den Einstand je Aktie, der gesamte Einstand bleibt gleich.</p><p><strong>Kapital und Rendite:</strong> Käufe und Einzahlungen sind keine Rendite. Ein höherer Portfoliowert kann aus zusätzlichem investiertem Kapital entstehen.</p><p><strong>Währungsumrechnung:</strong> Einstand und realisierte Ergebnisse werden mit historischen Wechselkursen der jeweiligen Kauf- und Verkaufstage berechnet, Dividenden mit dem Wechselkurs ihres Transaktionstags. Der Marktwert verwendet den aktuellen Wechselkurs zur Basiswährung. Der Währungseffekt zeigt den Anteil am unrealisierten Ergebnis aus Wechselkursänderungen seit dem Kauf. Einzelpositionen zeigen zusätzlich ihre Handelswährung.</p><p>Es erfolgt keine Steuerberechnung. Die Darstellung dient deiner Dokumentation und enthält keine Anlageempfehlung.</p></div></details>
      {formOpen && <TransactionForm transaction={editingTransaction} instrument={editingTransaction?.instrument} transactions={transactions.data?.transactions} onClose={closeForm} onSaved={() => { closeForm(); reload(); }} />}
      {importOpen && transactions.data && <ImportDialog transactions={transactions.data.transactions} onClose={() => setImportOpen(false)} onImported={reload} />}
      {deletingTransaction && <ConfirmDialog title="Transaktion löschen?" description={`${formatTransactionType(deletingTransaction.type)} für ${deletingTransaction.instrument.name} am ${date(deletingTransaction.date)} (${deletingTransaction.type === 'SPLIT' ? formatSplitRatio(deletingTransaction.ratio) : deletingTransaction.type === 'DIVIDEND' ? `${money(deletingTransaction.quantity * deletingTransaction.price - deletingTransaction.fees, deletingTransaction.currency)} netto` : `${number(deletingTransaction.quantity, 8)} Stück`}) wird gelöscht. Bestand und Ergebnisse werden neu berechnet. Die verbleibenden Transaktionen müssen weiterhin zum Bestand passen.`} confirmLabel="Transaktion löschen" onConfirm={deleteTransaction} onClose={() => setDeletingTransaction(null)} />}
    </div>
  );
}
