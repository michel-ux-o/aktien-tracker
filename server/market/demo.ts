import { rangeStartDate } from "../../shared/portfolio";
import type { SearchResponse } from "../../shared/api";
import { HISTORY_RANGES } from "../../shared/types";
import type {
  Currency,
  DataMeta,
  FxHistory,
  FxRate,
  HistoryRange,
  Instrument,
  InstrumentId,
  InstrumentProfile,
  PriceHistory,
  PricePoint,
  Quote,
} from "../../shared/types";
import { ApiError } from "../errors";
import type { MarketDataProvider } from "./index";

type DemoEntry = { instrument: Instrument; initialPrice: number; sector: string };

const catalog: [string, string, string, string, string, string, number, string][] = [
  ["AAPL", "Apple Inc.", "NASDAQ", "XNAS", "USD", "USA", 90, "Technologie"],
  ["MSFT", "Microsoft Corporation", "NASDAQ", "XNAS", "USD", "USA", 145, "Technologie"],
  ["GOOGL", "Alphabet Inc.", "NASDAQ", "XNAS", "USD", "USA", 70, "Kommunikation"],
  ["AMZN", "Amazon.com Inc.", "NASDAQ", "XNAS", "USD", "USA", 80, "Konsum"],
  ["NVDA", "NVIDIA Corporation", "NASDAQ", "XNAS", "USD", "USA", 40, "Technologie"],
  ["TSLA", "Tesla Inc.", "NASDAQ", "XNAS", "USD", "USA", 95, "Automobil"],
  ["META", "Meta Platforms Inc.", "NASDAQ", "XNAS", "USD", "USA", 160, "Kommunikation"],
  ["JPM", "JPMorgan Chase & Co.", "NYSE", "XNYS", "USD", "USA", 85, "Finanzen"],
  ["KO", "The Coca-Cola Company", "NYSE", "XNYS", "USD", "USA", 35, "Konsum"],
  ["V", "Visa Inc.", "NYSE", "XNYS", "USD", "USA", 110, "Finanzen"],
  ["SAP", "SAP SE", "XETRA", "XETR", "EUR", "Deutschland", 80, "Technologie"],
  ["SAP", "SAP SE ADR", "NYSE", "XNYS", "USD", "USA", 88, "Technologie"],
  ["SIE", "Siemens AG", "XETRA", "XETR", "EUR", "Deutschland", 85, "Industrie"],
  ["ALV", "Allianz SE", "XETRA", "XETR", "EUR", "Deutschland", 135, "Versicherung"],
  ["BAS", "BASF SE", "XETRA", "XETR", "EUR", "Deutschland", 30, "Chemie"],
  ["BMW", "Bayerische Motoren Werke AG", "XETRA", "XETR", "EUR", "Deutschland", 45, "Automobil"],
  ["DTE", "Deutsche Telekom AG", "XETRA", "XETR", "EUR", "Deutschland", 11, "Kommunikation"],
  ["NESN", "Nestlé S.A.", "SIX Swiss Exchange", "XSWX", "CHF", "Schweiz", 45, "Konsum"],
  ["NOVN", "Novartis AG", "SIX Swiss Exchange", "XSWX", "CHF", "Schweiz", 42, "Gesundheit"],
  ["ROG", "Roche Holding AG", "SIX Swiss Exchange", "XSWX", "CHF", "Schweiz", 125, "Gesundheit"],
  ["SHEL", "Shell plc", "London Stock Exchange", "XLON", "GBP", "Großbritannien", 12, "Energie"],
  ["ULVR", "Unilever plc", "London Stock Exchange", "XLON", "GBP", "Großbritannien", 20, "Konsum"],
  ["NODATA", "Demo-Wertpapier ohne Kursdaten", "XETRA", "XETR", "EUR", "Deutschland", 0, "Demo"],
];

const entries: DemoEntry[] = catalog.map(([symbol, name, exchange, mic, currency, country, initialPrice, sector]) => ({
  instrument: { id: `${symbol}:${mic}`, symbol, name, exchange, mic, currency, country, type: "Common Stock" },
  initialPrice,
  sector,
}));

export const DEMO_INSTRUMENTS: readonly Instrument[] = entries.map(({ instrument }) => Object.freeze(instrument));
export const DEMO_MISSING_DATA_ID = "NODATA:XETR";

const unitsPerEuro = new Map<Currency, number>([["EUR", 1], ["USD", 1.09], ["CHF", 0.96], ["GBP", 0.84]]);

function seedFromSymbol(symbol: string): number {
  let seed = 2166136261;
  for (const char of symbol) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  return seed;
}

function closeForDate(entry: DemoEntry, date: Date): number {
  const seed = seedFromSymbol(entry.instrument.symbol);
  const day = Math.floor(date.getTime() / 86_400_000);
  const years = (day - 16_801) / 365.25;
  const growth = 0.045 + (seed % 60) / 1000;
  const cycle = Math.sin(day / 71 + seed) * 0.06 + Math.sin(day / 311 + seed) * 0.1;
  const noise = ((Math.imul(day ^ seed, 1664525) >>> 0) % 10_000) / 10_000 - 0.5;
  return Math.round(entry.initialPrice * Math.exp(growth * years) * (1 + cycle + noise * 0.025) * 100) / 100;
}

function currencyCycle(currency: Currency, day: number): number {
  if (currency === "EUR") return 0;
  const seed = seedFromSymbol(currency);
  return Math.sin(day / 31 + seed) * 0.015 + Math.sin(day / 181 + seed) * 0.01;
}

export class DemoProvider implements MarketDataProvider {
  readonly mode = "demo" as const;
  readonly source = "Demo-Daten";
  readonly delayNote = "Demo – keine echten Marktdaten";
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  meta(): DataMeta {
    return { mode: this.mode, source: this.source, fetchedAt: this.now().toISOString(), delayMinutes: null, delayNote: this.delayNote };
  }

  private entry(id: InstrumentId): DemoEntry {
    const entry = entries.find((candidate) => candidate.instrument.id === id);
    if (!entry) throw new ApiError(404, "NOT_FOUND", "Das Wertpapier wurde nicht gefunden.");
    return entry;
  }

  private historyDates(): Date[] {
    const today = this.now().toISOString().slice(0, 10);
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCFullYear(date.getUTCFullYear() - 10);
    const dates: Date[] = [];
    while (date.toISOString().slice(0, 10) <= today) {
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
        dates.push(new Date(date));
      }
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return dates;
  }

  private history(entry: DemoEntry): PricePoint[] {
    if (entry.instrument.id === DEMO_MISSING_DATA_ID) return [];
    return this.historyDates().map((date) => ({ date: date.toISOString().slice(0, 10), close: closeForDate(entry, date) }));
  }

  async search(query: string): Promise<SearchResponse> {
    const normalized = query.trim().toLocaleLowerCase("de-DE");
    const results = entries.filter(({ instrument }) =>
      [instrument.symbol, instrument.name, instrument.id, instrument.exchange, instrument.mic]
        .some((text) => text.toLocaleLowerCase("de-DE").includes(normalized)),
    ).map(({ instrument }) => ({ ...instrument }));
    return { results, meta: this.meta() };
  }

  async getQuote(id: InstrumentId): Promise<Quote> {
    const entry = this.entry(id);
    const points = this.history(entry);
    const last = points.at(-1);
    const previous = points.at(-2);
    const price = last?.close ?? null;
    const previousClose = previous?.close ?? null;
    const change = price === null || previousClose === null ? null : price - previousClose;
    return {
      instrumentId: id, currency: entry.instrument.currency, price, previousClose, change,
      changePercent: change === null || previousClose === null || previousClose === 0 ? null : change / previousClose * 100,
      asOf: last ? `${last.date}T16:00:00.000Z` : null,
      isMarketOpen: last ? false : null,
      meta: this.meta(),
    };
  }

  async getQuotes(ids: InstrumentId[]): Promise<Record<InstrumentId, Quote>> {
    const quotes: Record<InstrumentId, Quote> = {};
    for (const id of new Set(ids)) {
      if (entries.some(({ instrument }) => instrument.id === id)) quotes[id] = await this.getQuote(id);
    }
    return quotes;
  }

  async getHistory(id: InstrumentId, range: HistoryRange): Promise<PriceHistory> {
    const entry = this.entry(id);
    const start = rangeStartDate(range, this.now().toISOString().slice(0, 10));
    return {
      instrumentId: id, range, currency: entry.instrument.currency,
      points: this.history(entry).filter(({ date }) => start === null || date >= start),
      supportedRanges: [...HISTORY_RANGES], meta: this.meta(),
    };
  }

  async getProfile(id: InstrumentId): Promise<InstrumentProfile> {
    const entry = this.entry(id);
    const oneYearAgo = new Date(this.now());
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    const prices = this.history(entry).filter(({ date }) => date >= oneYearAgo.toISOString().slice(0, 10)).map(({ close }) => close);
    return {
      ...entry.instrument, isin: null, sector: entry.sector, industry: null,
      description: "Dieses Profil und alle Kurse sind Demo-Daten für den lokalen Aktien-Tracker.",
      website: null, marketCap: null,
      fiftyTwoWeekHigh: prices.length ? Math.max(...prices) : null,
      fiftyTwoWeekLow: prices.length ? Math.min(...prices) : null,
      meta: this.meta(),
    };
  }

  async getFxRate(from: Currency, to: Currency): Promise<FxRate | null> {
    const fromRate = unitsPerEuro.get(from);
    const toRate = unitsPerEuro.get(to);
    if (fromRate === undefined || toRate === undefined) return null;
    return { from, to, rate: toRate / fromRate, asOf: this.now().toISOString(), source: this.source };
  }

  async getFxHistory(from: Currency, to: Currency, range: HistoryRange): Promise<FxHistory> {
    const fromRate = unitsPerEuro.get(from);
    const toRate = unitsPerEuro.get(to);
    if (fromRate === undefined || toRate === undefined) return { from, to, points: [], meta: this.meta() };
    const dates = this.historyDates();
    const lastDay = Math.floor(dates.at(-1)!.getTime() / 86_400_000);
    const start = rangeStartDate(range, this.now().toISOString().slice(0, 10));
    return {
      from, to,
      points: dates.filter((date) => start === null || date.toISOString().slice(0, 10) >= start).map((date) => {
        const day = Math.floor(date.getTime() / 86_400_000);
        // Currency-specific paths preserve reciprocal pairs and meet the current constants on the last weekday.
        const fromUnits = fromRate * Math.exp(currencyCycle(from, day) - currencyCycle(from, lastDay));
        const toUnits = toRate * Math.exp(currencyCycle(to, day) - currencyCycle(to, lastDay));
        return { date: date.toISOString().slice(0, 10), rate: toUnits / fromUnits };
      }),
      meta: this.meta(),
    };
  }
}
