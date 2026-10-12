/**
 * Portfolio-Berechnung nach der Durchschnittskostenmethode (reine Funktionen, keine I/O).
 * Käufe erhöhen Stückzahl und Einstand um Kaufpreis inklusive Gebühren, niemals den Gewinn.
 * Verkäufe lösen den anteiligen durchschnittlichen Einstand auf; Erlös abzüglich Gebühren
 * und Einstand ergibt den realisierten Gewinn oder Verlust. Der offene Marktwert abzüglich
 * Einstand ergibt das getrennt ausgewiesene unrealisierte Ergebnis.
 * Netto-Dividenden werden getrennt gesammelt, ohne Bestand, Einstand oder Handelsgebühren zu ändern.
 * Splits und Zusammenlegungen multiplizieren den Bestand mit ratio und lassen den Einstand unverändert.
 *
 * Transaktionen werden nach Datum, am selben Tag als SPLIT, BUY, DIVIDEND, SELL und danach nach
 * createdAt und id verarbeitet. Intern wird nicht gerundet; Bestandsreste unter 1e-9 werden
 * nach Verkäufen auf exakt 0 gesetzt. Eingaben erlauben bis zu acht Nachkommastellen bei Stückzahl und ratio.
 *
 * Alle Summen werden in die Basiswährung umgerechnet. In der Basiswährung gilt Faktor 1,
 * obwohl fxRate null bleibt, weil dafür kein externer Wechselkurs gebraucht wird.
 * Der Basis-Einstand verwendet historische Kaufkurse; Verkäufe und Dividenden die Kurse ihres Tages.
 * Marktwerte verwenden den aktuellen FX, im Verlauf den FX des jeweiligen Bewertungstags.
 * Der unrealisierte Währungseffekt ist Einstand zum aktuellen FX minus historischer Basis-Einstand.
 * Fehlende Kurse oder Wechselkurse bleiben als null erkennbar und führen zu einer eingeschränkten Gesamtauswertung.
 *
 * Server und Client verwenden dieselben Berechnungen und dieselbe Eingabevalidierung.
 */
import type {
  Currency,
  DataMeta,
  FxPoint,
  FxRate,
  HistoryRange,
  Holding,
  InstrumentId,
  Portfolio,
  PortfolioHistory,
  PricePoint,
  Quote,
  Transaction,
  TransactionInput,
} from "../types";
import { validateTransactionInput as validateInput, validateTransactionSequence as validateSequence } from "./validation";
import { computeHoldings as holdings } from "./holdings";
import { buildPortfolio as portfolio } from "./valuation";
import { rangeStartDate as startDate, computePortfolioHistory as portfolioHistory } from "./history";
import { createFxLookup as fxLookup } from "./fx";

/** date null: aktueller Kurs; sonst letzter Kurs am oder vor dem Tag. Für from === to wird nie gefragt. */
export type FxLookup = (from: Currency, to: Currency, date: string | null) => FxRate | null;

/** Reiner FX-Lookup nur zur Basiswährung; historische Abfragen weichen niemals auf aktuelle Kurse aus. */
export function createFxLookup(args: {
  baseCurrency: Currency;
  current: Record<Currency, FxRate | null>;
  /** Historische Kurse je Handelswährung; die Eingaben werden nicht verändert. */
  histories: Record<Currency, FxPoint[]>;
  source: string;
}): FxLookup {
  return fxLookup(args);
}

/** Minimale Transaktionsdaten, die für die Bestandsprüfung nötig sind. */
export type SequenceItem = Pick<Transaction, "id" | "type" | "date" | "quantity" | "ratio" | "createdAt">;

export type InputValidationResult =
  | { ok: true; value: TransactionInput }
  | { ok: false; fields: Record<string, string> };

export type SequenceValidationResult =
  | { ok: true }
  | { ok: false; transactionId: string; message: string };

/**
 * Prüft und normalisiert eine Transaktionseingabe (unbekannte Daten, z. B. Request-Body).
 * Fehlermeldungen sind deutsch und je Feld (`instrument`, `type`, `date`, `quantity`, `price`, `fees`, `ratio`, `currency`, `note`).
 * SPLIT normalisiert quantity, price und fees auf 0; andere Arten normalisieren ratio auf null.
 * `today` ("YYYY-MM-DD") für die Prüfung „nicht in der Zukunft“.
 */
export function validateTransactionInput(input: unknown, today: string): InputValidationResult {
  return validateInput(input, today);
}

/**
 * Prüft die Transaktionsfolge EINES Wertpapiers: Der Bestand darf zu keinem Zeitpunkt negativ werden.
 * SPLIT benötigt einen positiven Bestand, DIVIDEND einen Bestand oder einen Kauf am selben/früheren Tag.
 * Reihenfolge: Datum aufsteigend; am selben Tag SPLIT, BUY, DIVIDEND, SELL; danach createdAt, dann id.
 */
export function validateTransactionSequence(items: SequenceItem[]): SequenceValidationResult {
  return validateSequence(items);
}

/** Bestände aller Wertpapiere (inkl. vollständig verkaufter, quantity = 0) nach Durchschnittskostenmethode. */
export function computeHoldings(transactions: Transaction[]): Holding[] {
  return holdings(transactions);
}

/** Bewertetes Portfolio in Basiswährung. Fehlende Kurse/FX führen zu null-Werten und summary.complete = false. */
export function buildPortfolio(
  transactions: Transaction[],
  quotes: Record<InstrumentId, Quote | undefined>,
  baseCurrency: Currency,
  fx: FxLookup,
): Portfolio {
  return portfolio(transactions, quotes, baseCurrency, fx);
}

/** Erstes Datum ("YYYY-MM-DD") des Zeitraums relativ zu `today`; für "MAX" null. */
export function rangeStartDate(range: HistoryRange, today: string): string | null {
  return startDate(range, today);
}

/**
 * Portfolioentwicklung: je Handelstag (Vereinigung aller Kursdaten im Zeitraum) Marktwert und investiertes Kapital.
 * Marktwerte verwenden FX am oder vor dem Bewertungstag, Einstand die historischen Transaktionskurse.
 * Schlusskurse gelten als split-bereinigt; frühere Bestände werden mit späteren Split-Verhältnissen bewertet.
 */
export function computePortfolioHistory(args: {
  transactions: Transaction[];
  /** Schlusskurse je Wertpapier, aufsteigend sortiert. */
  histories: Record<InstrumentId, PricePoint[]>;
  baseCurrency: Currency;
  fx: FxLookup;
  range: HistoryRange;
  today: string;
  meta: DataMeta;
}): PortfolioHistory {
  return portfolioHistory(args);
}
