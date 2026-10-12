import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors";
import { CachingProvider, DEMO_INSTRUMENTS, DEMO_MISSING_DATA_ID, DemoProvider, TwelveDataProvider } from "./index";
import { HISTORY_RANGES } from "../../shared/types";
import type { FxHistory, Quote } from "../../shared/types";

const fixedNow = () => new Date("2026-10-11T12:00:00.000Z");
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

describe("DemoProvider", () => {
  it("finds similarly named instruments separately at different exchanges", async () => {
    const provider = new DemoProvider({ now: fixedNow });
    expect(DEMO_INSTRUMENTS.length).toBeGreaterThanOrEqual(20);
    const search = await provider.search("sap");
    expect(search.results.map(({ id }) => id)).toEqual(["SAP:XETR", "SAP:XNYS"]);
    expect(search.results.map(({ currency }) => currency)).toEqual(["EUR", "USD"]);
    expect(search.meta).toMatchObject({ mode: "demo", source: "Demo-Daten", delayNote: "Demo – keine echten Marktdaten" });
  });

  it("generates stable ten-year weekday histories and quotes from the last two closes", async () => {
    const provider = new DemoProvider({ now: fixedNow });
    const history = await provider.getHistory("AAPL:XNAS", "MAX");
    expect(history.points.length).toBeGreaterThan(2500);
    expect(history.points[0]?.date).toBe("2016-10-11");
    expect(history.points.at(-1)?.date).toBe("2026-10-09");
    expect(history.points.every(({ date }) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()))).toBe(true);
    expect(history.points).toEqual((await new DemoProvider({ now: fixedNow }).getHistory("AAPL:XNAS", "MAX")).points);
    const quote = await provider.getQuote("AAPL:XNAS");
    expect(quote.price).toBe(history.points.at(-1)?.close);
    expect(quote.previousClose).toBe(history.points.at(-2)?.close);
    expect(quote.change).toBeCloseTo(quote.price! - quote.previousClose!);
    expect(quote.changePercent).toBeCloseTo(quote.change! / quote.previousClose! * 100);
    expect((await provider.getHistory("AAPL:XNAS", "1W")).points.every(({ date }) => date >= "2026-10-04")).toBe(true);
  });

  it("preserves missing data and reports unknown instruments", async () => {
    const provider = new DemoProvider({ now: fixedNow });
    expect(await provider.getQuote(DEMO_MISSING_DATA_ID)).toMatchObject({ price: null, previousClose: null, change: null, asOf: null });
    expect((await provider.getHistory(DEMO_MISSING_DATA_ID, "MAX")).points).toEqual([]);
    expect(await provider.getQuotes(["UNKNOWN:XNAS", DEMO_MISSING_DATA_ID])).toHaveProperty(DEMO_MISSING_DATA_ID);
    await expect(provider.getQuote("UNKNOWN:XNAS")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await provider.getFxRate("JPY", "EUR")).toBeNull();
    const eurUsd = await provider.getFxRate("EUR", "USD");
    const usdEur = await provider.getFxRate("USD", "EUR");
    expect(eurUsd!.rate * usdEur!.rate).toBeCloseTo(1);
    expect(await provider.getFxRate("CHF", "GBP")).toMatchObject({ from: "CHF", to: "GBP", source: "Demo-Daten" });
  });

  it.each(HISTORY_RANGES)("generates deterministic weekday FX histories over the same %s span as prices", async (range) => {
    const provider = new DemoProvider({ now: fixedNow });
    const history = await provider.getFxHistory("EUR", "USD", range);
    const prices = await provider.getHistory("AAPL:XNAS", range);
    expect(history.points.map(({ date }) => date)).toEqual(prices.points.map(({ date }) => date));
    expect(history.points).toEqual((await new DemoProvider({ now: fixedNow }).getFxHistory("EUR", "USD", range)).points);
    expect(history.points.at(-1)).toEqual({ date: "2026-10-09", rate: (await provider.getFxRate("EUR", "USD"))!.rate });
    expect(history.points.every(({ rate }) => rate > 1 && rate < 1.2)).toBe(true);
    expect(new Set(history.points.map(({ rate }) => rate)).size).toBeGreaterThan(1);
    expect(history).toMatchObject({ from: "EUR", to: "USD", meta: { source: "Demo-Daten", mode: "demo" } });
    const full = await provider.getFxHistory("EUR", "USD", "MAX");
    const dates = new Set(history.points.map(({ date }) => date));
    expect(history.points).toEqual(full.points.filter(({ date }) => dates.has(date)));
  });

  it.each([
    ["EUR", "USD"], ["EUR", "CHF"], ["EUR", "GBP"],
    ["USD", "CHF"], ["USD", "GBP"], ["CHF", "GBP"],
  ])("keeps %s/%s daily histories reciprocal and aligned with current rates", async (from, to) => {
    const provider = new DemoProvider({ now: fixedNow });
    const forward = await provider.getFxHistory(from, to, "1Y");
    const reverse = await provider.getFxHistory(to, from, "1Y");
    expect(forward.points.map(({ date }) => date)).toEqual(reverse.points.map(({ date }) => date));
    forward.points.forEach(({ rate }, index) => { expect(rate * reverse.points[index]!.rate).toBeCloseTo(1, 12); });
    expect(forward.points.at(-1)?.rate).toBe((await provider.getFxRate(from, to))!.rate);
    expect(reverse.points.at(-1)?.rate).toBe((await provider.getFxRate(to, from))!.rate);
  });

  it("uses one for known identity pairs and keeps unknown currencies unavailable", async () => {
    const provider = new DemoProvider({ now: () => new Date("2026-10-12T12:00:00.000Z") });
    const history = await provider.getFxHistory("CHF", "CHF", "1W");
    expect(history.points.length).toBeGreaterThan(0);
    expect(history.points.every(({ rate }) => rate === 1)).toBe(true);
    expect(history.points.at(-1)).toEqual({ date: "2026-10-12", rate: 1 });
    for (const [from, to] of [["JPY", "EUR"], ["EUR", "JPY"], ["JPY", "JPY"], ["toString", "EUR"]] as const) {
      expect((await provider.getFxHistory(from, to, "MAX")).points).toEqual([]);
      expect(await provider.getFxRate(from, to)).toBeNull();
    }
  });
});

describe("CachingProvider", () => {
  it("reuses quotes across single and batch requests until their TTL expires", async () => {
    let now = 0;
    const provider = new DemoProvider({ now: fixedNow });
    const quote = vi.spyOn(provider, "getQuote");
    const cached = new CachingProvider(provider, { now: () => now, quoteTtlSeconds: 10 });
    const first = await cached.getQuote("AAPL:XNAS");
    first.price = -1;
    expect((await cached.getQuote("AAPL:XNAS")).price).toBeGreaterThan(0);
    await cached.getQuotes(["AAPL:XNAS", "AAPL:XNAS"]);
    expect(quote).toHaveBeenCalledTimes(1);
    now = 10_000;
    await cached.getQuote("AAPL:XNAS");
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it("shares in-flight requests and retries failed requests", async () => {
    const provider = new DemoProvider({ now: fixedNow });
    const value = await provider.getQuote("AAPL:XNAS");
    let finish!: (quote: Quote) => void;
    const pending = new Promise<Quote>((resolve) => { finish = resolve; });
    const spy = vi.spyOn(provider, "getQuote").mockReturnValueOnce(pending);
    const cached = new CachingProvider(provider);
    const first = cached.getQuote("AAPL:XNAS");
    const second = cached.getQuote("AAPL:XNAS");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    finish(value);
    expect(await first).toEqual(await second);
    spy.mockRejectedValueOnce(new ApiError(502, "MARKET_DATA_UNAVAILABLE", "Keine Marktdaten."));
    await expect(cached.getQuote("SAP:XETR")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    await cached.getQuote("SAP:XETR");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("uses separate TTLs for search and history, and caches profiles and FX", async () => {
    let now = 0;
    const provider = new DemoProvider({ now: fixedNow });
    const search = vi.spyOn(provider, "search");
    const history = vi.spyOn(provider, "getHistory");
    const profile = vi.spyOn(provider, "getProfile");
    const fx = vi.spyOn(provider, "getFxRate");
    const cached = new CachingProvider(provider, { now: () => now, searchTtlSeconds: 30, historyTtlSeconds: 20, quoteTtlSeconds: 10 });
    for (let count = 0; count < 2; count++) {
      await cached.search(count ? " SAP " : "sap");
      await cached.getHistory("SAP:XETR", "1M");
      await cached.getProfile("SAP:XETR");
      await cached.getFxRate("EUR", "USD");
    }
    expect(search).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(1);
    expect(profile).toHaveBeenCalledTimes(1);
    expect(fx).toHaveBeenCalledTimes(1);
    now = 20_000;
    await cached.search("sap");
    await cached.getHistory("SAP:XETR", "1M");
    await cached.getFxRate("EUR", "USD");
    expect(search).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(2);
    expect(fx).toHaveBeenCalledTimes(2);
  });

  it("caches FX histories by pair and range with the history TTL and independent cloned results", async () => {
    let now = 0;
    const provider = new DemoProvider({ now: fixedNow });
    const history = vi.spyOn(provider, "getFxHistory");
    const fx = vi.spyOn(provider, "getFxRate");
    const prices = vi.spyOn(provider, "getHistory");
    const cached = new CachingProvider(provider, { now: () => now, quoteTtlSeconds: 1, historyTtlSeconds: 10 });
    const first = await cached.getFxHistory("EUR", "USD", "1W");
    first.points[0]!.rate = -1;
    first.points.push({ date: "invalid", rate: -1 });
    expect((await cached.getFxHistory("EUR", "USD", "1W")).points.every(({ rate }) => rate > 0)).toBe(true);
    await cached.getFxRate("EUR", "USD");
    await cached.getHistory("SAP:XETR", "1W");
    now = 1000;
    await cached.getFxHistory("EUR", "USD", "1W");
    await cached.getFxRate("EUR", "USD");
    expect(history).toHaveBeenCalledTimes(1);
    expect(fx).toHaveBeenCalledTimes(2);
    expect(prices).toHaveBeenCalledTimes(1);
    await cached.getFxHistory("USD", "EUR", "1W");
    await cached.getFxHistory("EUR", "CHF", "1W");
    await cached.getFxHistory("EUR", "USD", "1M");
    expect(history).toHaveBeenCalledTimes(4);
    now = 10_000;
    await cached.getFxHistory("EUR", "USD", "1W");
    expect(history).toHaveBeenCalledTimes(5);
  });

  it("shares pending FX histories and retries errors without caching them", async () => {
    const provider = new DemoProvider({ now: fixedNow });
    const value = await provider.getFxHistory("EUR", "USD", "1W");
    let finish!: (history: FxHistory) => void;
    const pending = new Promise<FxHistory>((resolve) => { finish = resolve; });
    const spy = vi.spyOn(provider, "getFxHistory").mockReturnValueOnce(pending);
    const cached = new CachingProvider(provider);
    const first = cached.getFxHistory("EUR", "USD", "1W");
    const second = cached.getFxHistory("EUR", "USD", "1W");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    finish(value);
    const firstResult = await first;
    const secondResult = await second;
    expect(firstResult).toEqual(secondResult);
    firstResult.points[0]!.rate = -1;
    expect(secondResult.points[0]!.rate).toBeGreaterThan(0);
    spy.mockRejectedValueOnce(new ApiError(502, "MARKET_DATA_UNAVAILABLE", "Keine Marktdaten."));
    await expect(cached.getFxHistory("USD", "EUR", "1W")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    await cached.getFxHistory("USD", "EUR", "1W");
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("TwelveDataProvider (mocked fetch only)", () => {
  it("maps search and quotes, includes the selected MIC, and keeps credentials out of returned data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("apikey")).toBe("private-api-key");
      if (url.pathname === "/symbol_search") {
        expect(url.searchParams.get("symbol")).toBe("SAP");
        return jsonResponse({ status: "ok", data: [
          { symbol: "SAP", instrument_name: "SAP SE", exchange: "XETRA", mic_code: "XETR", currency: "EUR", country: "Germany", instrument_type: "Common Stock" },
          { symbol: "SAP", instrument_name: "SAP SE ADR", exchange: "NYSE", mic_code: "XNYS", currency: "USD" },
          { symbol: "INVALID" },
        ] });
      }
      expect(url.pathname).toBe("/quote");
      expect(url.searchParams.get("symbol")).toBe("SAP");
      expect(url.searchParams.get("mic_code")).toBe("XETR");
      return jsonResponse({ symbol: "SAP", currency: "EUR", close: "210.25", previous_close: "200", last_quote_at: 1791547200, is_market_open: false });
    });
    const provider = new TwelveDataProvider({ apiKey: "private-api-key", fetch: fetcher, now: fixedNow });
    const search = await provider.search(" SAP ");
    expect(search.results.map(({ id }) => id)).toEqual(["SAP:XETR", "SAP:XNYS"]);
    const quote = await provider.getQuote("SAP:XETR");
    expect(quote).toMatchObject({ instrumentId: "SAP:XETR", currency: "EUR", price: 210.25, previousClose: 200, change: 10.25, changePercent: 5.125, isMarketOpen: false });
    expect(quote.asOf).toBe(new Date(1791547200 * 1000).toISOString());
    expect(quote.meta).toMatchObject({ source: "Twelve Data", mode: "live", delayNote: "Kurse je nach Börse ggf. verzögert (Twelve Data)" });
    expect(JSON.stringify({ search, quote })).not.toContain("private-api-key");
  });

  it("maps unavailable quote fields to null instead of zero", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ currency: "USD", close: null, previous_close: "", change: "NaN", percent_change: "null" }));
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher });
    expect(await provider.getQuote("AAPL:XNAS")).toMatchObject({ price: null, previousClose: null, change: null, changePercent: null, asOf: null, isMarketOpen: null });
  });

  it("sorts and bounds daily histories and discards missing closes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/time_series");
      expect(url.searchParams.get("interval")).toBe("1day");
      expect(url.searchParams.get("mic_code")).toBe("XNAS");
      expect(url.searchParams.get("start_date")).toBe("2026-10-04");
      expect(Number(url.searchParams.get("outputsize"))).toBeLessThan(50);
      return jsonResponse({ status: "ok", meta: { currency: "USD" }, values: [
        { datetime: "2026-10-09", close: "210" }, { datetime: "2026-10-08", close: "208" },
        { datetime: "2026-10-07", close: null }, { datetime: "2026-10-03", close: "202" },
        { datetime: "2026-10-12", close: "211" },
      ] });
    });
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher, now: fixedNow });
    expect((await provider.getHistory("AAPL:XNAS", "1W")).points).toEqual([
      { date: "2026-10-08", close: 208 }, { date: "2026-10-09", close: 210 },
    ]);
  });

  it("maps profile fields and resolves missing profile currency through a quote", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/profile") return jsonResponse({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", mic_code: "XNAS", type: "Common Stock", sector: "Technology", industry: "Consumer Electronics", website: "https://www.apple.com", description: "Company profile.", country: "US" });
      return jsonResponse({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", mic_code: "XNAS", currency: "USD", close: "210" });
    });
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher });
    expect(await provider.getProfile("AAPL:XNAS")).toMatchObject({ id: "AAPL:XNAS", currency: "USD", sector: "Technology", industry: "Consumer Electronics", description: "Company profile.", isin: null, marketCap: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains known instrument metadata when later endpoints omit it", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/symbol_search") return jsonResponse({ data: [{
        symbol: "SAP", instrument_name: "SAP SE", exchange: "XETRA", mic_code: "XETR",
        currency: "EUR", country: "Germany", instrument_type: "Common Stock",
      }] });
      if (url.pathname === "/quote") return jsonResponse({ close: "210", previous_close: "208" });
      return jsonResponse({ sector: "Technology" });
    });
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher });
    const [instrument] = (await provider.search("SAP")).results;
    expect(await provider.getQuote("SAP:XETR")).toMatchObject({ currency: "EUR", price: 210 });
    expect(await provider.getProfile("SAP:XETR")).toMatchObject({
      ...instrument, sector: "Technology", industry: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects unavailable required metadata instead of returning empty currencies or exchanges", async () => {
    const provider = new TwelveDataProvider({
      apiKey: "test", now: fixedNow,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/profile") return jsonResponse({ name: "Apple Inc.", currency: "USD" });
        return jsonResponse({ close: "210", values: [] });
      }),
    });
    await expect(provider.getQuote("AAPL:XNAS")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    await expect(provider.getHistory("AAPL:XNAS", "1W")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    await expect(provider.getProfile("AAPL:XNAS")).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
  });

  it("maps exchange rates and returns null for missing rate metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/exchange_rate");
      expect(url.searchParams.get("symbol")).toBe("USD/EUR");
      return jsonResponse({ rate: 0.91, timestamp: 1791547200 });
    });
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher });
    expect(await provider.getFxRate("USD", "EUR")).toMatchObject({ from: "USD", to: "EUR", rate: 0.91, source: "Twelve Data" });
    fetcher.mockImplementationOnce(async () => jsonResponse({ rate: null }));
    expect(await provider.getFxRate("USD", "EUR")).toBeNull();
  });

  it("maps, sorts, deduplicates and bounds FX history without requiring instrument metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/time_series");
      expect(url.searchParams.get("symbol")).toBe("USD/EUR");
      expect(url.searchParams.get("mic_code")).toBeNull();
      expect(url.searchParams.get("interval")).toBe("1day");
      expect(url.searchParams.get("order")).toBe("asc");
      expect(url.searchParams.get("start_date")).toBe("2026-09-11");
      expect(url.searchParams.get("end_date")).toBe("2026-10-11");
      return jsonResponse({ values: [
        { datetime: "2026-10-09", close: "0.92" }, { datetime: "2026-10-08", close: 0.91 },
        { datetime: "2026-10-09", close: "0.93" }, { datetime: "2026-09-11", close: "0.9" },
        { datetime: "2026-10-07", close: null }, { datetime: "2026-10-07", close: "" },
        { datetime: "2026-10-07", close: "NaN" }, { datetime: "2026-10-07", close: "Infinity" },
        { datetime: "2026-10-07", close: 0 }, { datetime: "2026-10-07", close: -1 },
        { datetime: "2026-10-07", close: true }, { datetime: "invalid", close: 1 },
        { datetime: "2026-09-31", close: 1 }, { datetime: "2026-09-10", close: 1 },
        { datetime: "2026-10-12", close: 1 }, { close: 1 }, null,
      ] });
    });
    const provider = new TwelveDataProvider({ apiKey: "private-api-key", fetch: fetcher, now: fixedNow });
    const history = await provider.getFxHistory("USD", "EUR", "1M");
    expect(history.points).toEqual([
      { date: "2026-09-11", rate: 0.9 }, { date: "2026-10-08", rate: 0.91 }, { date: "2026-10-09", rate: 0.93 },
    ]);
    expect(history).toMatchObject({ from: "USD", to: "EUR", meta: { mode: "live", source: "Twelve Data", fetchedAt: fixedNow().toISOString() } });
    expect(JSON.stringify(history)).not.toContain("private-api-key");
  });

  it.each(HISTORY_RANGES)("uses the same %s request period for FX and instrument histories", async (range) => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ meta: { currency: "USD" }, values: [] }));
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: fetcher, now: fixedNow });
    await provider.getHistory("AAPL:XNAS", range);
    await provider.getFxHistory("EUR", "USD", range);
    const priceUrl = new URL(String(fetcher.mock.calls[0]![0]));
    const fxUrl = new URL(String(fetcher.mock.calls[1]![0]));
    for (const parameter of ["interval", "order", "start_date", "end_date", "outputsize"]) {
      expect(fxUrl.searchParams.get(parameter)).toBe(priceUrl.searchParams.get(parameter));
    }
    if (range === "MAX") {
      expect(fxUrl.searchParams.has("start_date")).toBe(false);
      expect(fxUrl.searchParams.get("outputsize")).toBe("5000");
    }
  });

  it.each([{}, { values: [] }, { values: null }, { values: {} }])("returns empty FX points for missing data (%j)", async (data) => {
    const provider = new TwelveDataProvider({ apiKey: "test", fetch: vi.fn(async () => jsonResponse(data)), now: fixedNow });
    expect(await provider.getFxHistory("USD", "EUR", "1W")).toMatchObject({ from: "USD", to: "EUR", points: [] });
  });

  it.each([
    ["provider limit", () => Promise.resolve(jsonResponse({ status: "error", code: 429, message: "private-api-key" }))],
    ["HTTP limit", () => Promise.resolve(jsonResponse({}, 429))],
    ["network error", () => Promise.reject(new Error("URL with private-api-key"))],
    ["bad JSON", () => Promise.resolve(new Response("not JSON"))],
  ])("returns a sanitized German provider error for %s", async (_name, response) => {
    const provider = new TwelveDataProvider({ apiKey: "private-api-key", fetch: vi.fn(response) });
    const error = await provider.getQuote("AAPL:XNAS").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, code: "MARKET_DATA_UNAVAILABLE" });
    expect((error as Error).message).not.toContain("private-api-key");
    expect((error as Error).message).toContain("Marktdaten");
    const fxError = await provider.getFxHistory("USD", "EUR", "1W").catch((caught: unknown) => caught);
    expect(fxError).toMatchObject({ status: 502, code: "MARKET_DATA_UNAVAILABLE" });
    expect((fxError as Error).message).not.toContain("private-api-key");
    expect((fxError as Error).message).toContain("Marktdaten");
  });
});
