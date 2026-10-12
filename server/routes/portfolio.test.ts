import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Currency, FxHistory, FxPoint, FxRate, HistoryRange, Instrument, PriceHistory, PricePoint, Quote, TransactionInput } from "../../shared/types";
import type { Repositories } from "../db";
import { createTestRepositories } from "../db/testing";
import { ApiError, errorHandler } from "../errors";
import { DemoProvider } from "../market";
import { createPortfolioRouter } from "./portfolio";

const timestamp = "2026-10-11T12:00:00.000Z";
const now = () => new Date(timestamp);
const instrument: Instrument = {
  id: "AAPL:XNAS", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", mic: "XNAS",
  currency: "USD", country: "United States", type: "Common Stock",
};
const closedInstrument: Instrument = { ...instrument, id: "MSFT:XNAS", symbol: "MSFT", name: "Microsoft Corp." };
const euroInstrument: Instrument = { ...instrument, id: "SAP:XETR", symbol: "SAP", mic: "XETR", currency: "EUR" };
const sterlingInstrument: Instrument = { ...instrument, id: "VOD:XLON", symbol: "VOD", mic: "XLON", currency: "GBP" };
const buy: TransactionInput = {
  instrument, type: "BUY", date: "2026-10-01", quantity: 10, price: 100, fees: 0, currency: "USD",
};

class PortfolioProvider extends DemoProvider {
  fxPoints: Record<Currency, FxPoint[]> = {
    USD: [{ date: "2026-09-30", rate: 0.8 }, { date: "2026-10-03", rate: 0.9 }, { date: "2026-10-05", rate: 0.95 }],
    GBP: [{ date: "2026-09-30", rate: 1.2 }],
  };
  pricePoints: Record<string, PricePoint[]> = {
    [instrument.id]: [{ date: "2026-10-01", close: 100 }, { date: "2026-10-04", close: 110 }, { date: "2026-10-06", close: 120 }],
  };
  getFxRate = vi.fn(async (from: Currency, to: Currency): Promise<FxRate | null> => ({ from, to, rate: 1.1, asOf: timestamp, source: this.source }));
  getFxHistory = vi.fn(async (from: Currency, to: Currency, _range: HistoryRange): Promise<FxHistory> => ({
    from, to, points: this.fxPoints[from] ?? [], meta: this.meta(),
  }));
  getQuote = vi.fn(async (id: string): Promise<Quote> => ({
    instrumentId: id, currency: id === sterlingInstrument.id ? "GBP" : id === euroInstrument.id ? "EUR" : "USD",
    price: 120, previousClose: 118, change: 2, changePercent: 2 / 118 * 100,
    asOf: timestamp, isMarketOpen: false, meta: this.meta(),
  }));
  getHistory = vi.fn(async (id: string, range: HistoryRange): Promise<PriceHistory> => ({
    instrumentId: id, range, currency: "USD", points: this.pricePoints[id] ?? [], supportedRanges: [range], meta: this.meta(),
  }));
}

describe("portfolio routes with historical exchange rates", () => {
  let close: () => Promise<void>;
  let repos: Repositories;
  let market: PortfolioProvider;
  let app: express.Express;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    ({ repos, close } = await createTestRepositories());
    userA = (await repos.users.create("a@example.com", "hash-a", timestamp)).id;
    userB = (await repos.users.create("b@example.com", "hash-b", timestamp)).id;
    market = new PortfolioProvider({ now });
    app = express();
    app.use((req, res, next) => {
      res.locals.userId = req.get("Test-User") ?? userA;
      next();
    });
    app.use("/api/portfolio", createPortfolioRouter({ repos, market, now }));
    app.use(errorHandler);
  });
  afterEach(async () => { await close(); vi.restoreAllMocks(); });

  function create(input: Partial<TransactionInput> = {}) {
    return repos.transactions.create(userA, { ...buy, ...input }, timestamp);
  }

  it("values costs at purchase FX, current FX effects and dividends of open and closed positions", async () => {
    await create({ fees: 10 });
    await create({ type: "DIVIDEND", date: "2026-10-03", price: 2, fees: 1 });
    await create({ instrument: closedInstrument, quantity: 2 });
    await create({ instrument: closedInstrument, type: "DIVIDEND", date: "2026-10-03", quantity: 2, price: 5 });
    await create({ instrument: closedInstrument, type: "SELL", date: "2026-10-05", quantity: 2, price: 150 });

    const result = await request(app).get("/api/portfolio").expect(200);
    expect(result.body.positions).toHaveLength(1);
    expect(result.body.positions[0]).toMatchObject({
      instrumentId: instrument.id, costBasis: 1010, costBasisBase: 808,
      marketValueBase: 1320, unrealizedPnlBase: 512, dividends: 19,
    });
    expect(result.body.positions[0].unrealizedFxEffectBase).toBeCloseTo(303);
    expect(result.body.positions[0].dividendsBase).toBeCloseTo(17.1);
    expect(result.body.closedPositions[0]).toMatchObject({ quantity: 0, realizedPnlBase: 125, dividendsBase: 9 });
    expect(result.body.summary).toMatchObject({ complete: true, totalCostBasis: 808, unrealizedPnl: 512, realizedPnl: 125 });
    expect(result.body.summary.unrealizedFxEffect).toBeCloseTo(303);
    expect(result.body.summary.dividends).toBeCloseTo(26.1);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", "1M"]]);
    expect(market.getFxRate.mock.calls).toEqual([["USD", "EUR"]]);
    expect(market.getQuote.mock.calls).toEqual([[instrument.id]]);
  });

  it("uses each chart date's historical FX and the last known prior day rather than the current rate", async () => {
    await create();
    const result = await request(app).get("/api/portfolio/history?range=1M").expect(200);
    expect(result.body.complete).toBe(true);
    expect(result.body.points).toEqual([
      { date: "2026-10-01", marketValue: 800, investedCapital: 800 },
      { date: "2026-10-04", marketValue: 990, investedCapital: 800 },
      { date: "2026-10-06", marketValue: 1140, investedCapital: 800 },
    ]);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", "1M"]]);
    expect(market.getHistory.mock.calls).toEqual([[instrument.id, "1M"]]);
  });

  // Eine Woche Puffer vor der ersten Transaktion, damit Wochenendbuchungen einen Vortageskurs finden.
  it.each<[string, HistoryRange]>([
    ["2026-10-11", "1W"], ["2026-10-10", "1M"],
    ["2026-09-18", "1M"], ["2026-09-17", "3M"], ["2026-07-18", "3M"],
    ["2026-07-17", "6M"], ["2026-04-18", "6M"], ["2026-04-17", "1Y"],
    ["2025-10-18", "1Y"], ["2025-10-17", "5Y"], ["2021-10-18", "5Y"], ["2021-10-17", "MAX"],
  ])("requests the smallest FX range covering a purchase on %s plus one week buffer (%s)", async (date, range) => {
    await create({ date });
    await request(app).get("/api/portfolio").expect(200);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", range]]);
  });

  it.each<HistoryRange>(["1M", "3M", "6M", "1Y", "5Y", "MAX"])("covers the longer chart period %s", async (range) => {
    await create({ date: "2026-10-10" });
    await request(app).get(`/api/portfolio/history?range=${range}`).expect(200);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", range]]);
  });

  it("covers the buffered purchase date when it lies before the chart period", async () => {
    await create({ date: "2026-10-10" });
    await request(app).get("/api/portfolio/history?range=1W").expect(200);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", "1M"]]);
  });

  it("covers an old purchase even when the displayed chart is shorter", async () => {
    await create({ date: "2020-01-01" });
    await request(app).get("/api/portfolio/history?range=1W").expect(200);
    expect(market.getFxHistory.mock.calls).toEqual([["USD", "EUR", "MAX"]]);
  });

  it.each(["/api/portfolio", "/api/portfolio/history?range=1M"])("fetches each foreign currency once and uses the earliest user transaction for %s", async (path) => {
    await create();
    await create({ instrument: closedInstrument });
    await create({ instrument: sterlingInstrument, currency: "GBP" });
    await create({ instrument: euroInstrument, currency: "EUR", date: "2020-01-01" });
    await request(app).get(path).expect(200);
    expect(market.getFxHistory.mock.calls).toHaveLength(2);
    expect(market.getFxHistory.mock.calls).toEqual(expect.arrayContaining([["USD", "EUR", "MAX"], ["GBP", "EUR", "MAX"]]));
    expect(market.getFxRate.mock.calls).toHaveLength(2);
    expect(market.getFxRate.mock.calls).toEqual(expect.arrayContaining([["USD", "EUR"], ["GBP", "EUR"]]));
  });

  it("fetches no FX for an empty portfolio, the user's base currency or another user's transactions", async () => {
    await create();
    const foreign = await request(app).get(`/api/portfolio?userId=${userA}`).set("Test-User", userB).expect(200);
    expect(foreign.body.positions).toEqual([]);
    const foreignHistory = await request(app).get(`/api/portfolio/history?range=MAX&userId=${userA}`).set("Test-User", userB).expect(200);
    expect(foreignHistory.body.points).toEqual([]);
    await repos.settings.update(userA, { baseCurrency: "USD" });
    const inBase = await request(app).get("/api/portfolio").expect(200);
    expect(inBase.body.positions[0]).toMatchObject({ costBasisBase: 1000, unrealizedFxEffectBase: 0 });
    expect(market.getFxHistory).not.toHaveBeenCalled();
    expect(market.getFxRate).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "MARKET_DATA_UNAVAILABLE"] as const)("keeps current valuation available when FX history fails with %s", async (code) => {
    await create();
    market.getFxHistory.mockRejectedValue(new ApiError(code === "NOT_FOUND" ? 404 : 503, code, "Der Wechselkurs fehlt."));
    const result = await request(app).get("/api/portfolio").expect(200);
    expect(result.body.positions[0]).toMatchObject({ marketValueBase: 1320, costBasisBase: null, unrealizedFxEffectBase: null });
    expect(result.body.summary).toMatchObject({ complete: false, missingFx: ["USD"] });
    expect(market.getFxRate).toHaveBeenCalledOnce();
    expect(market.getFxHistory).toHaveBeenCalledOnce();
  });

  it.each(["NOT_FOUND", "MARKET_DATA_UNAVAILABLE"] as const)("keeps historical valuation available when the current FX fails with %s", async (code) => {
    await create();
    market.getFxRate.mockRejectedValue(new ApiError(code === "NOT_FOUND" ? 404 : 503, code, "Der Wechselkurs fehlt."));
    const result = await request(app).get("/api/portfolio").expect(200);
    expect(result.body.positions[0]).toMatchObject({ marketValueBase: null, costBasisBase: 800, unrealizedFxEffectBase: null });
    expect(result.body.summary).toMatchObject({ complete: false, missingFx: ["USD"] });
    const history = await request(app).get("/api/portfolio/history?range=1M").expect(200);
    expect(history.body.complete).toBe(true);
    expect(history.body.points[0]).toEqual({ date: "2026-10-01", marketValue: 800, investedCapital: 800 });
  });

  it("does not substitute current or future FX when a purchase precedes the available history", async () => {
    await create();
    market.fxPoints.USD = [{ date: "2026-10-02", rate: 0.8 }];
    const result = await request(app).get("/api/portfolio").expect(200);
    expect(result.body.positions[0]).toMatchObject({ marketValueBase: 1320, costBasisBase: null });
    expect(result.body.summary).toMatchObject({ complete: false, missingFx: ["USD"] });
  });

  it("reports incomplete history when historical FX is unavailable instead of rejecting the request", async () => {
    await create();
    market.getFxHistory.mockRejectedValue(new ApiError(503, "MARKET_DATA_UNAVAILABLE", "Die Historie fehlt."));
    const history = await request(app).get("/api/portfolio/history?range=1M").expect(200);
    expect(history.body.complete).toBe(false);
    expect(history.body.points.every((point: { marketValue: number | null }) => point.marketValue === null)).toBe(true);
    expect(history.body.notes.some((note: string) => note.includes("USD"))).toBe(true);
  });
});
