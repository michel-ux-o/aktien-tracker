import type { SearchResponse } from "../../shared/api";
import type {
  Currency,
  DataMeta,
  DataMode,
  FxHistory,
  FxRate,
  HistoryRange,
  InstrumentId,
  InstrumentProfile,
  PriceHistory,
  Quote,
} from "../../shared/types";

export interface MarketDataProvider {
  readonly mode: DataMode;
  readonly source: string;
  readonly delayNote: string | null;
  meta(): DataMeta;
  search(query: string): Promise<SearchResponse>;
  getQuote(id: InstrumentId): Promise<Quote>;
  getQuotes(ids: InstrumentId[]): Promise<Record<InstrumentId, Quote>>;
  getHistory(id: InstrumentId, range: HistoryRange): Promise<PriceHistory>;
  getProfile(id: InstrumentId): Promise<InstrumentProfile>;
  getFxRate(from: Currency, to: Currency): Promise<FxRate | null>;
  getFxHistory(from: Currency, to: Currency, range: HistoryRange): Promise<FxHistory>;
}

export { DemoProvider, DEMO_INSTRUMENTS, DEMO_MISSING_DATA_ID } from "./demo";
export { TwelveDataProvider } from "./twelve-data";
export { CachingProvider } from "./cache";
