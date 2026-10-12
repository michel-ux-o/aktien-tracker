import { Link, useSearchParams } from "react-router-dom";
import { SearchBox } from "../components/SearchBox";

export function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";

  return (
    <div className="section-stack">
      <div className="page-heading">
        <div><p className="eyebrow">Wertpapiere entdecken</p><h1>Aktie suchen</h1><p className="muted">Suche nach Unternehmensname oder Ticker und wähle den passenden Börsenplatz.</p></div>
      </div>
      <section className="card" aria-labelledby="search-heading">
        <h2 id="search-heading">Welches Wertpapier suchst du?</h2>
        <SearchBox key={query} initialQuery={query} autoFocus showResults label="Name oder Ticker" placeholder="Zum Beispiel SAP oder AAPL" />
      </section>
      <div className="grid-two">
        <section className="card">
          <h2>Deine Watchlist</h2>
          <p className="muted">Behalte Wertpapiere im Blick. Öffne einen Treffer und füge ihn zu deiner Watchlist hinzu.</p>
          <Link className="button button-secondary" to="/watchlist">Watchlist ansehen</Link>
        </section>
        <section className="card">
          <h2>Dein Portfolio</h2>
          <p className="muted">Erfasse deine Käufe und Verkäufe direkt in der Aktienansicht. Dein Portfolio zeigt dir Bestand und Ergebnisse.</p>
          <Link className="button button-secondary" to="/portfolio">Portfolio ansehen</Link>
        </section>
      </div>
    </div>
  );
}

export default SearchPage;
