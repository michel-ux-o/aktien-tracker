import type { SearchResponse } from "../../shared/api";
import { rangeStartDate } from "../../shared/portfolio";
import { HISTORY_RANGES } from "../../shared/types";
import type {
  Currency,
  DataMeta,
  FxHistory,
  FxPoint,
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

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function historyDate(value: unknown): string | null {
  const date = text(value)?.slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function timestamp(value: unknown): string | null {
  const parsed = number(value);
  if (parsed === null) return null;
  const date = new Date(parsed * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quoteTimestamp(data: JsonRecord): string | null {
  const unix = timestamp(data.last_quote_at) ?? timestamp(data.timestamp);
  if (unix) return unix;
  const date = text(data.datetime);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00.000Z`;
  if (date && /(?:Z|[+-]\d{2}:\d{2})$/.test(date)) {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  // Exchange-local datetimes without a timezone cannot be safely interpreted as UTC.
  return null;
}

function unavailable(): ApiError {
  return new ApiError(502, "MARKET_DATA_UNAVAILABLE", "Die Marktdaten sind derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.");
}

export interface TwelveDataOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Twelve Data credentials stay within this server-side adapter. */
export class TwelveDataProvider implements MarketDataProvider {
  readonly mode = "live" as const;
  readonly source = "Twelve Data";
  readonly delayNote = "Kurse je nach Börse ggf. verzögert (Twelve Data)";
  private readonly apiKey: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly instruments = new Map<InstrumentId, Instrument>();
  private readonly currencies = new Map<InstrumentId, Currency>();

  constructor(options: TwelveDataOptions) {
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  meta(): DataMeta {
    return { mode: this.mode, source: this.source, fetchedAt: this.now().toISOString(), delayMinutes: null, delayNote: this.delayNote };
  }

  private async request(endpoint: string, params: Record<string, string>): Promise<JsonRecord> {
    const url = new URL(`https://api.twelvedata.com/${endpoint}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apikey", this.apiKey);
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw unavailable();
      const body: unknown = await response.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw unavailable();
      const data = object(body);
      if (data.status === "error" || number(data.code) === 429) throw unavailable();
      return data;
    } catch {
      // Do not expose a fetch error, response message or URL: those may contain the API key.
      throw unavailable();
    }
  }

  private identity(id: InstrumentId): { symbol: string; mic_code: string } {
    const separator = id.lastIndexOf(":");
    const symbol = id.slice(0, separator);
    const mic = id.slice(separator + 1);
    if (separator < 1 || !symbol || !/^[A-Z0-9]{4}$/.test(mic)) {
      throw new ApiError(404, "NOT_FOUND", "Das Wertpapier wurde nicht gefunden.");
    }
    return { symbol, mic_code: mic };
  }

  private mapInstrument(data: JsonRecord): Instrument | null {
    const symbol = text(data.symbol);
    const mic = text(data.mic_code);
    if (!symbol || !mic) return null;
    const id = `${symbol}:${mic}`;
    const known = this.instruments.get(id);
    const currency = text(data.currency) ?? known?.currency ?? this.currencies.get(id);
    const exchange = text(data.exchange) ?? known?.exchange;
    const name = text(data.instrument_name) ?? text(data.name) ?? known?.name;
    if (!currency || !exchange || !name) return null;
    const instrument: Instrument = {
      id, symbol, mic, currency, name, exchange,
      country: text(data.country) ?? known?.country ?? null,
      type: text(data.instrument_type) ?? text(data.type) ?? known?.type ?? null,
    };
    this.instruments.set(instrument.id, instrument);
    this.currencies.set(instrument.id, currency);
    return instrument;
  }

  private currency(id: InstrumentId, value: unknown): Currency {
    const currency = text(value) ?? this.instruments.get(id)?.currency ?? this.currencies.get(id);
    if (!currency) throw unavailable();
    this.currencies.set(id, currency);
    return currency;
  }

  private historyParameters(range: HistoryRange) {
    const today = this.now().toISOString().slice(0, 10);
    const start = rangeStartDate(range, today);
    const days = start === null ? null : Math.ceil((Date.parse(today) - Date.parse(start)) / 86_400_000);
    const params: Record<string, string> = {
      interval: "1day", order: "asc", end_date: today,
      outputsize: String(days === null ? 5000 : Math.min(5000, Math.ceil(days * 5 / 7) + 8)),
    };
    if (start !== null) params.start_date = start;
    return { today, start, params };
  }

  async search(query: string): Promise<SearchResponse> {
    const data = await this.request("symbol_search", { symbol: query.trim(), outputsize: "50" });
    const results: Instrument[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(data.data) ? data.data : []) {
      const instrument = this.mapInstrument(object(item));
      if (instrument && !seen.has(instrument.id)) {
        results.push(instrument);
        seen.add(instrument.id);
      }
    }
    return { results, meta: this.meta() };
  }

  async getQuote(id: InstrumentId): Promise<Quote> {
    const identity = this.identity(id);
    const data = await this.request("quote", identity);
    const currency = this.currency(id, data.currency);
    this.mapInstrument({ ...data, symbol: identity.symbol, mic_code: identity.mic_code });
    const price = number(data.close) ?? number(data.price);
    const previousClose = number(data.previous_close);
    const change = price !== null && previousClose !== null ? price - previousClose : number(data.change);
    const changePercent = price !== null && previousClose !== null && previousClose !== 0
      ? (price - previousClose) / previousClose * 100
      : number(data.percent_change);
    return {
      instrumentId: id, currency,
      price, previousClose, change, changePercent,
      asOf: quoteTimestamp(data),
      isMarketOpen: typeof data.is_market_open === "boolean" ? data.is_market_open : null,
      meta: this.meta(),
    };
  }

  async getQuotes(ids: InstrumentId[]): Promise<Record<InstrumentId, Quote>> {
    const quotes: Record<InstrumentId, Quote> = {};
    await Promise.all([...new Set(ids)].map(async (id) => {
      try {
        quotes[id] = await this.getQuote(id);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
      }
    }));
    return quotes;
  }

  async getHistory(id: InstrumentId, range: HistoryRange): Promise<PriceHistory> {
    const identity = this.identity(id);
    const { today, start, params } = this.historyParameters(range);
    const data = await this.request("time_series", { ...identity, ...params });
    const metadata = object(data.meta);
    const currency = this.currency(id, metadata.currency);
    this.mapInstrument({ ...metadata, symbol: identity.symbol, mic_code: identity.mic_code });
    const unique = new Map<string, PricePoint>();
    for (const item of Array.isArray(data.values) ? data.values : []) {
      const point = object(item);
      const date = historyDate(point.datetime);
      const close = number(point.close);
      if (date && close !== null && close > 0 && date <= today && (start === null || date >= start)) {
        unique.set(date, { date, close });
      }
    }
    return {
      instrumentId: id, range,
      currency,
      points: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)),
      supportedRanges: [...HISTORY_RANGES], meta: this.meta(),
    };
  }

  async getProfile(id: InstrumentId): Promise<InstrumentProfile> {
    const identity = this.identity(id);
    const data = await this.request("profile", identity);
    // /profile does not normally contain currency. Resolve it from market metadata, never by guessing an exchange.
    if (!text(data.currency) && !this.currencies.has(id)) {
      await this.getQuote(id);
    }
    const currency = this.currency(id, data.currency);
    const instrument = this.mapInstrument({ ...data, currency, ...identity });
    if (!instrument) throw unavailable();
    const fiftyTwoWeek = object(data.fifty_two_week);
    return {
      ...instrument,
      isin: text(data.isin), sector: text(data.sector), industry: text(data.industry),
      description: text(data.description), website: text(data.website),
      marketCap: number(data.market_capitalization) ?? number(data.market_cap),
      fiftyTwoWeekHigh: number(data.fifty_two_week_high) ?? number(fiftyTwoWeek.high),
      fiftyTwoWeekLow: number(data.fifty_two_week_low) ?? number(fiftyTwoWeek.low),
      meta: this.meta(),
    };
  }

  async getFxRate(from: Currency, to: Currency): Promise<FxRate | null> {
    if (from === to) return { from, to, rate: 1, asOf: this.now().toISOString(), source: this.source };
    const data = await this.request("exchange_rate", { symbol: `${from}/${to}` });
    const rate = number(data.rate);
    const asOf = timestamp(data.timestamp);
    if (rate === null || rate <= 0 || asOf === null) return null;
    return { from, to, rate, asOf, source: this.source };
  }

  async getFxHistory(from: Currency, to: Currency, range: HistoryRange): Promise<FxHistory> {
    const { today, start, params } = this.historyParameters(range);
    const data = await this.request("time_series", { symbol: `${from}/${to}`, ...params });
    const unique = new Map<string, FxPoint>();
    for (const item of Array.isArray(data.values) ? data.values : []) {
      const point = object(item);
      const date = historyDate(point.datetime);
      const rate = number(point.close);
      if (date && rate !== null && rate > 0 && date <= today && (start === null || date >= start)) {
        unique.set(date, { date, rate });
      }
    }
    return {
      from, to,
      points: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)),
      meta: this.meta(),
    };
  }
}
