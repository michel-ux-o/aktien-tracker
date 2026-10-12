import type { SearchResponse } from "../../shared/api";
import type { Currency, DataMeta, FxHistory, FxRate, HistoryRange, InstrumentId, InstrumentProfile, PriceHistory, Quote } from "../../shared/types";
import { ApiError } from "../errors";
import type { MarketDataProvider } from "./index";

export interface CacheOptions {
  quoteTtlSeconds?: number;
  historyTtlSeconds?: number;
  searchTtlSeconds?: number;
  now?: () => number;
}

type CacheEntry = { expiresAt: number; value: unknown };

function ttl(value: number | undefined, environment: string | undefined, fallback: number): number {
  const seconds = value ?? (environment?.trim() ? Number(environment) : fallback);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallback * 1000;
}

/** Stores successful results and shares a single provider request among simultaneous callers. */
export class CachingProvider implements MarketDataProvider {
  private readonly provider: MarketDataProvider;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly quoteTtl: number;
  private readonly historyTtl: number;
  private readonly searchTtl: number;
  private readonly now: () => number;

  constructor(provider: MarketDataProvider, options: CacheOptions = {}) {
    this.provider = provider;
    this.quoteTtl = ttl(options.quoteTtlSeconds, process.env.QUOTE_CACHE_TTL_SECONDS, 300);
    this.historyTtl = ttl(options.historyTtlSeconds, process.env.HISTORY_CACHE_TTL_SECONDS, 3600);
    this.searchTtl = ttl(options.searchTtlSeconds, process.env.SEARCH_CACHE_TTL_SECONDS, 86400);
    this.now = options.now ?? Date.now;
  }

  get mode() { return this.provider.mode; }
  get source() { return this.provider.source; }
  get delayNote() { return this.provider.delayNote; }
  meta(): DataMeta { return this.provider.meta(); }

  private async cached<T>(key: string, lifetime: number, request: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > this.now()) return structuredClone(existing.value) as T;
    if (existing) this.cache.delete(key);
    let pending = this.pending.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = Promise.resolve().then(request).then((value) => {
        if (lifetime > 0) {
          // Keep the cache bounded even when many different searches are made.
          if (this.cache.size >= 2000) {
            for (const [oldKey, entry] of this.cache) if (entry.expiresAt <= this.now()) this.cache.delete(oldKey);
            if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!);
          }
          this.cache.set(key, { expiresAt: this.now() + lifetime, value: structuredClone(value) });
        }
        return value;
      }).finally(() => { this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }

  search(query: string): Promise<SearchResponse> {
    const trimmed = query.trim();
    return this.cached(`search:${trimmed.toLocaleLowerCase("de-DE")}`, this.searchTtl, () => this.provider.search(trimmed));
  }

  getQuote(id: InstrumentId): Promise<Quote> {
    return this.cached(`quote:${id}`, this.quoteTtl, () => this.provider.getQuote(id));
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

  getHistory(id: InstrumentId, range: HistoryRange): Promise<PriceHistory> {
    return this.cached(`history:${id}:${range}`, this.historyTtl, () => this.provider.getHistory(id, range));
  }

  getProfile(id: InstrumentId): Promise<InstrumentProfile> {
    return this.cached(`profile:${id}`, this.historyTtl, () => this.provider.getProfile(id));
  }

  getFxRate(from: Currency, to: Currency): Promise<FxRate | null> {
    return this.cached(`fx:${from}:${to}`, this.quoteTtl, () => this.provider.getFxRate(from, to));
  }

  getFxHistory(from: Currency, to: Currency, range: HistoryRange): Promise<FxHistory> {
    return this.cached(`fxHistory:${from}:${to}:${range}`, this.historyTtl, () => this.provider.getFxHistory(from, to, range));
  }
}
