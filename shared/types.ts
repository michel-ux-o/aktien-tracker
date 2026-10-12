/**
 * Gemeinsame Domänentypen für Server und Client.
 * Diese Datei ist der Vertrag zwischen allen Teilen der App – Änderungen nur in Absprache.
 *
 * Konventionen:
 * - Datumswerte ohne Uhrzeit: "YYYY-MM-DD"; Zeitpunkte: ISO-8601 mit Zeitzone ("2026-10-11T14:03:00.000Z").
 * - Beträge sind JavaScript-Zahlen in der jeweils angegebenen Währung, Stückzahlen dürfen Bruchteile haben.
 * - Felder, für die keine Daten vorliegen, sind `null` – niemals erfundene Werte.
 */

/** ISO-4217-Währungscode, z. B. "EUR", "USD". */
export type Currency = string;

/** Eindeutige Kennung eines Wertpapiers: `${symbol}:${mic}`, z. B. "AAPL:XNAS", "SAP:XETR". */
export type InstrumentId = string;

export type DataMode = "demo" | "live";

/** Herkunft und Aktualität von Marktdaten – wird in der UI bei jeder Kursangabe angezeigt. */
export interface DataMeta {
  /** Anzeigename der Quelle, z. B. "Twelve Data" oder "Demo-Daten". */
  source: string;
  mode: DataMode;
  /** Wann der Server die Daten vom Anbieter geholt hat (ISO). */
  fetchedAt: string;
  /** Bekannte Verzögerung in Minuten; null = unbekannt. */
  delayMinutes: number | null;
  /** Kurzer deutscher Hinweis, z. B. "Kurse ggf. bis zu 15 Min. verzögert" oder "Schlusskurs des Vortags". */
  delayNote: string | null;
}

export interface Instrument {
  id: InstrumentId;
  symbol: string;
  name: string;
  /** Anzeigename des Börsenplatzes, z. B. "NASDAQ", "XETRA". */
  exchange: string;
  /** Market Identifier Code, z. B. "XNAS". */
  mic: string;
  /** Handelswährung am Börsenplatz. */
  currency: Currency;
  country: string | null;
  /** z. B. "Common Stock", "ETF". */
  type: string | null;
}

export interface Quote {
  instrumentId: InstrumentId;
  currency: Currency;
  /** Letzter verfügbarer Kurs. */
  price: number | null;
  previousClose: number | null;
  /** price - previousClose */
  change: number | null;
  /** Prozent, z. B. 1.25 für +1,25 %. */
  changePercent: number | null;
  /** Zeitpunkt des Kurses laut Anbieter (ISO); null wenn unbekannt. */
  asOf: string | null;
  /** true, wenn der Markt laut Anbieter gerade geöffnet ist; null = unbekannt. */
  isMarketOpen: boolean | null;
  meta: DataMeta;
}

export type HistoryRange = "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "MAX";
export const HISTORY_RANGES: readonly HistoryRange[] = ["1W", "1M", "3M", "6M", "1Y", "5Y", "MAX"];

export interface PricePoint {
  /** "YYYY-MM-DD" */
  date: string;
  close: number;
}

export interface PriceHistory {
  instrumentId: InstrumentId;
  range: HistoryRange;
  currency: Currency;
  /** Aufsteigend nach Datum sortiert; kann leer sein. */
  points: PricePoint[];
  /** Zeiträume, die die Datenquelle für dieses Wertpapier unterstützt. */
  supportedRanges: HistoryRange[];
  meta: DataMeta;
}

/** Basisinformationen zur Detailansicht; nicht verfügbare Felder sind null. */
export interface InstrumentProfile extends Instrument {
  isin: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  website: string | null;
  /** Marktkapitalisierung in Handelswährung. */
  marketCap: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  meta: DataMeta;
}

/** Wechselkurs: 1 Einheit `from` = `rate` Einheiten `to`. */
export interface FxRate {
  from: Currency;
  to: Currency;
  rate: number;
  /** Datenstand des Kurses (ISO-Zeitpunkt oder bei historischen Kursen "YYYY-MM-DD"). */
  asOf: string;
  source: string;
}

/** Tagesschlusskurs eines Wechselkurses: 1 Einheit `from` = `rate` Einheiten `to`. */
export interface FxPoint {
  /** "YYYY-MM-DD" */
  date: string;
  rate: number;
}

/** Historische Wechselkurse eines Währungspaars. */
export interface FxHistory {
  from: Currency;
  to: Currency;
  /** Aufsteigend nach Datum sortiert; kann leer sein. */
  points: FxPoint[];
  meta: DataMeta;
}

/**
 * - BUY / SELL: Kauf bzw. Verkauf.
 * - DIVIDEND: Dividendengutschrift; ändert weder Stückzahl noch Einstand.
 * - SPLIT: Aktiensplit oder Zusammenlegung; ändert die Stückzahl, nicht den Einstand.
 */
export type TransactionType = "BUY" | "SELL" | "DIVIDEND" | "SPLIT";
export const TRANSACTION_TYPES: readonly TransactionType[] = ["BUY", "SELL", "DIVIDEND", "SPLIT"];

/**
 * Eingabe für Anlegen/Bearbeiten einer Transaktion. Bedeutung der Felder je Art:
 *
 * | Art      | quantity                     | price                    | fees                              | ratio |
 * |----------|------------------------------|--------------------------|-----------------------------------|-------|
 * | BUY      | Stück > 0                    | Kurs je Aktie > 0        | Gebühren >= 0                     | null  |
 * | SELL     | Stück > 0                    | Kurs je Aktie > 0        | Gebühren >= 0                     | null  |
 * | DIVIDEND | berechtigte Stück > 0        | Dividende je Aktie > 0   | Abzüge (Quellensteuer, Gebühren) >= 0 und <= quantity * price | null |
 * | SPLIT    | 0 (wird vom Server auf 0 gesetzt) | 0 (dto.)            | 0 (dto.)                          | neue Stücke je alte Stücke, > 0 und != 1 |
 *
 * Beispiele für `ratio`: Split 4:1 -> 4; Zusammenlegung 1:10 -> 0.1.
 */
export interface TransactionInput {
  instrument: Instrument;
  type: TransactionType;
  /** "YYYY-MM-DD", nicht in der Zukunft. */
  date: string;
  /** Siehe Tabelle oben; Bruchstücke erlaubt (max. 8 Nachkommastellen). */
  quantity: number;
  /** In `currency`; siehe Tabelle oben. */
  price: number;
  /** In `currency`; siehe Tabelle oben. */
  fees: number;
  /** Handelswährung; muss der Handelswährung des Wertpapiers entsprechen. */
  currency: Currency;
  /** Nur bei SPLIT: neue Stücke je altem Stück (max. 8 Nachkommastellen, 0,0001 bis 10.000). Sonst null/fehlend. */
  ratio?: number | null;
  /** Optional, max. 500 Zeichen. */
  note?: string | null;
  /**
   * Vom Client pro Formular-Öffnung erzeugte UUID. Der Server legt pro Nutzer und clientRequestId
   * höchstens eine Transaktion an (Schutz vor Doppel-Absenden). Nur bei POST relevant.
   */
  clientRequestId?: string;
}

export interface Transaction {
  id: string;
  instrumentId: InstrumentId;
  instrument: Instrument;
  type: TransactionType;
  date: string;
  quantity: number;
  price: number;
  fees: number;
  currency: Currency;
  /** Nur bei SPLIT gesetzt, sonst null. */
  ratio: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aus Transaktionen berechneter Bestand je Wertpapier (ohne Kursdaten).
 * Methode: Durchschnittskostenmethode, Gebühren erhöhen beim Kauf den Einstand und
 * mindern beim Verkauf den Erlös. Ein Split multipliziert die Stückzahl mit `ratio`,
 * der Einstand bleibt gleich. Dividenden ändern weder Stückzahl noch Einstand.
 * Alle Beträge in der Handelswährung des Wertpapiers.
 *
 * Reihenfolge am selben Tag: SPLIT, BUY, DIVIDEND, SELL (danach createdAt, id).
 */
export interface Holding {
  instrumentId: InstrumentId;
  instrument: Instrument;
  currency: Currency;
  quantity: number;
  /** Einstandswert der offenen Stücke inkl. anteiliger Kaufgebühren. */
  costBasis: number;
  /** costBasis / quantity; null bei quantity = 0. */
  averageCost: number | null;
  /** Summe realisierter Ergebnisse aus Verkäufen (nach Gebühren). */
  realizedPnl: number;
  /** Summe der Netto-Dividenden (quantity * price - fees je Dividende). */
  dividends: number;
  /** Summe aller Kauf- und Verkaufsgebühren (ohne Dividendenabzüge). */
  totalFees: number;
  transactionCount: number;
}

export interface Position extends Holding {
  quote: Quote | null;
  lastPrice: number | null;
  /** quantity * lastPrice (Handelswährung). */
  marketValue: number | null;
  /** marketValue - costBasis (Handelswährung). */
  unrealizedPnl: number | null;
  /** unrealizedPnl / costBasis * 100. */
  unrealizedPnlPercent: number | null;
  /** quantity * quote.change (Handelswährung). */
  dayChange: number | null;

  /** Aktueller Wechselkurs Handelswährung -> Basiswährung; null wenn nicht verfügbar. */
  fxRate: FxRate | null;
  /** marketValue zum aktuellen Wechselkurs. */
  marketValueBase: number | null;
  /**
   * Einstand in Basiswährung zu den Wechselkursen der jeweiligen Kauftage
   * (Durchschnittskostenmethode, parallel in Basiswährung geführt). null, wenn ein historischer Kurs fehlt.
   */
  costBasisBase: number | null;
  /** marketValueBase - costBasisBase; enthält den Währungseffekt. */
  unrealizedPnlBase: number | null;
  /**
   * Anteil des unrealisierten Ergebnisses, der aus Wechselkursänderungen seit dem Kauf stammt:
   * costBasis * aktueller FX - costBasisBase. In der Basiswährung immer 0.
   */
  unrealizedFxEffectBase: number | null;
  /** Realisierte Ergebnisse: Erlöse zum FX des Verkaufstags minus Einstand zu historischen Kauf-FX. */
  realizedPnlBase: number | null;
  /** Netto-Dividenden, jeweils zum FX des Dividendentags. */
  dividendsBase: number | null;
  dayChangeBase: number | null;
  /** Anteil am Gesamtmarktwert der offenen Positionen in Prozent; null wenn nicht berechenbar. */
  weightPercent: number | null;
}

export interface PortfolioSummary {
  baseCurrency: Currency;
  /** Summe Marktwerte (Basiswährung) der offenen Positionen, bei denen Kurs und FX vorliegen. */
  totalMarketValue: number | null;
  /** Investiertes Kapital der offenen Positionen (Einstand, Basiswährung). */
  totalCostBasis: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  /** Summe unrealizedFxEffectBase der offenen Positionen (Teil von unrealizedPnl). */
  unrealizedFxEffect: number | null;
  /** Realisierte Ergebnisse aller Positionen (Basiswährung). */
  realizedPnl: number | null;
  /** Netto-Dividenden aller Positionen inkl. geschlossener (Basiswährung). */
  dividends: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  /**
   * false, wenn Kurse oder Wechselkurse fehlen. Die Summen enthalten dann nur die bewertbaren
   * Positionen und die UI muss „Eingeschränkte Gesamtauswertung“ anzeigen.
   */
  complete: boolean;
  /** InstrumentIds offener Positionen ohne Kurs. */
  missingPrices: InstrumentId[];
  /** Währungen ohne aktuellen Wechselkurs oder ohne historischen Kurs für mindestens einen Transaktionstag. */
  missingFx: Currency[];
  /** Alle verwendeten aktuellen Wechselkurse (ohne Basis->Basis). */
  fxRates: FxRate[];
  openPositionCount: number;
}

export interface Portfolio {
  summary: PortfolioSummary;
  /** Offene Positionen (quantity > 0), absteigend nach marketValueBase. */
  positions: Position[];
  /** Vollständig verkaufte Positionen mit realisiertem Ergebnis. */
  closedPositions: Position[];
}

export interface PortfolioHistoryPoint {
  date: string;
  /**
   * Marktwert der an diesem Tag gehaltenen Positionen (Basiswährung, Wechselkurs dieses Tages);
   * null wenn nicht bewertbar. Kursreihen gelten als split-bereinigt: Stückzahlen vor einem Split
   * werden für die Bewertung mit den späteren Split-Verhältnissen umgerechnet.
   */
  marketValue: number | null;
  /** Investiertes Kapital (Einstand zu historischen Kauf-Wechselkursen) der an diesem Tag offenen Positionen. */
  investedCapital: number;
}

export interface PortfolioHistory {
  range: HistoryRange;
  baseCurrency: Currency;
  points: PortfolioHistoryPoint[];
  /** false, wenn für einzelne Positionen/Tage Kurse oder Wechselkurse fehlten. */
  complete: boolean;
  /** Deutsche Hinweise zu Einschränkungen, z. B. "Für XYZ liegen keine historischen Kurse vor." */
  notes: string[];
  meta: DataMeta;
}

export interface WatchlistItem {
  instrument: Instrument;
  addedAt: string;
  quote: Quote | null;
}

/**
 * Kursalarm. ABOVE löst aus, wenn der letzte Kurs >= targetPrice ist; BELOW bei Kurs <= targetPrice.
 * Der Server prüft aktive Alarme beim Abruf von GET /api/alerts gegen die (gecachten) aktuellen Kurse
 * und setzt dabei triggeredAt/triggeredPrice. Ein ausgelöster Alarm bleibt ausgelöst, bis er reaktiviert wird.
 */
export type AlertCondition = "ABOVE" | "BELOW";

export interface PriceAlertInput {
  instrument: Instrument;
  condition: AlertCondition;
  /** In der Handelswährung des Wertpapiers, > 0. */
  targetPrice: number;
  /** Optional, max. 200 Zeichen. */
  note?: string | null;
}

export interface PriceAlert {
  id: string;
  instrumentId: InstrumentId;
  instrument: Instrument;
  condition: AlertCondition;
  targetPrice: number;
  /** = instrument.currency */
  currency: Currency;
  note: string | null;
  createdAt: string;
  /** Zeitpunkt der Auslösung (ISO); null = aktiv. */
  triggeredAt: string | null;
  /** Kurs, bei dem ausgelöst wurde; null = aktiv. */
  triggeredPrice: number | null;
  /** Aktueller Kurs zum Zeitpunkt der Abfrage; null wenn nicht verfügbar. */
  quote: Quote | null;
}

export type ThemePreference = "system" | "light" | "dark";
export const SUPPORTED_BASE_CURRENCIES: readonly Currency[] = ["EUR", "USD", "CHF", "GBP"];

export interface UserSettings {
  baseCurrency: Currency;
  theme: ThemePreference;
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
}
