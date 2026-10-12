import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PRICE_ALERTS } from "../../shared/api";
import type { Instrument, PriceAlert, PriceAlertInput, Quote } from "../../shared/types";
import type { Repositories } from "../db";
import { createTestRepositories } from "../db/testing";
import { ApiError, errorHandler } from "../errors";
import { DemoProvider } from "../market";
import { createAlertsRouter } from "./alerts";

const timestamp = "2026-10-11T12:00:00.000Z";
const instrument: Instrument = {
  id: "SAP:XETR", symbol: "SAP", name: "SAP SE", exchange: "XETRA", mic: "XETR",
  currency: "EUR", country: "Germany", type: "Common Stock",
};
const secondInstrument: Instrument = { ...instrument, id: "SIE:XETR", symbol: "SIE", name: "Siemens AG" };
const input: PriceAlertInput = { instrument, condition: "ABOVE", targetPrice: 180 };

describe("alert routes", () => {
  let close: () => Promise<void>;
  let repos: Repositories;
  let app: express.Express;
  let market: DemoProvider;
  let currentTime: string;
  let userA: string;
  let userB: string;
  let quotes: Record<string, Quote>;

  function quote(value: number | null, forInstrument = instrument): Quote {
    return {
      instrumentId: forInstrument.id, currency: forInstrument.currency, price: value,
      previousClose: null, change: null, changePercent: null, asOf: timestamp, isMarketOpen: null,
      meta: market.meta(),
    };
  }

  beforeEach(async () => {
    currentTime = timestamp;
    ({ repos, close } = await createTestRepositories());
    userA = (await repos.users.create("a@example.com", "hash-a", timestamp)).id;
    userB = (await repos.users.create("b@example.com", "hash-b", timestamp)).id;
    market = new DemoProvider({ now: () => new Date(currentTime) });
    quotes = {};
    vi.spyOn(market, "getQuotes").mockImplementation(async (ids) => Object.fromEntries(
      ids.filter((id) => quotes[id] !== undefined).map((id) => [id, quotes[id]!]),
    ));
    app = express();
    app.use(express.json());
    // The app tests cover real session and CSRF enforcement.
    app.use((req, res, next) => {
      res.locals.userId = req.get("Test-User") ?? userA;
      next();
    });
    app.use("/api/alerts", createAlertsRouter({ repos, market, now: () => new Date(currentTime) }));
    app.use(errorHandler);
  });
  afterEach(async () => { await close(); vi.restoreAllMocks(); });

  it("creates an alert in the instrument currency and trims optional notes", async () => {
    const created = await request(app).post("/api/alerts").send({ ...input, note: "  Ziel erreicht  ", currency: "USD", userId: userB }).expect(201);
    expect(created.body).toMatchObject({
      instrument, instrumentId: instrument.id, condition: "ABOVE", targetPrice: 180, currency: "EUR",
      note: "Ziel erreicht", createdAt: timestamp, triggeredAt: null, triggeredPrice: null, quote: null,
    });
    expect(await repos.alerts.get(userA, created.body.id)).toBeDefined();
    expect(await repos.alerts.get(userB, created.body.id)).toBeUndefined();
    const emptyNote = await request(app).post("/api/alerts").send({ ...input, note: "   " }).expect(201);
    expect(emptyNote.body.note).toBeNull();
    expect(market.getQuotes).not.toHaveBeenCalled();
  });

  it("collects invalid instrument, condition, target price and note fields", async () => {
    const invalid = await request(app).post("/api/alerts").send({
      ...input, instrument: { ...instrument, id: "SIE:XETR" }, condition: "CROSSES", targetPrice: 0, note: "x".repeat(201),
    }).expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalid.body.error.fields).toMatchObject({
      "instrument.id": expect.any(String), condition: expect.any(String), targetPrice: expect.any(String), note: expect.any(String),
    });
    expect(await repos.alerts.list(userA)).toEqual([]);
  });

  it.each([-1, 0, null, "180"])("rejects invalid targetPrice %s", async (targetPrice) => {
    const invalid = await request(app).post("/api/alerts").send({ ...input, targetPrice }).expect(400);
    expect(invalid.body.error.fields.targetPrice).toBeTruthy();
  });

  it("rejects nonfinite prices and accepts the 200-character note boundary", async () => {
    const raw = JSON.stringify(input).replace('"targetPrice":180', '"targetPrice":1e400');
    const invalid = await request(app).post("/api/alerts").set("Content-Type", "application/json").send(raw).expect(400);
    expect(invalid.body.error.fields.targetPrice).toBeTruthy();
    const created = await request(app).post("/api/alerts").send({ ...input, note: "x".repeat(200) }).expect(201);
    expect(created.body.note).toHaveLength(200);
  });

  it("triggers ABOVE and BELOW inclusively, attaches quotes and persists the trigger", async () => {
    const above = await repos.alerts.create(userA, input, timestamp);
    const below = await repos.alerts.create(userA, { ...input, condition: "BELOW" }, timestamp);
    const stillAbove = await repos.alerts.create(userA, { ...input, targetPrice: 181 }, timestamp);
    const stillBelow = await repos.alerts.create(userA, { ...input, condition: "BELOW", targetPrice: 179 }, timestamp);
    quotes[instrument.id] = quote(180);
    const response = await request(app).get("/api/alerts").expect(200);
    expect(response.body.triggeredCount).toBe(2);
    for (const id of [above.id, below.id]) {
      expect(response.body.alerts.find((alert: PriceAlert) => alert.id === id)).toMatchObject({
        triggeredAt: timestamp, triggeredPrice: 180, quote: { price: 180, currency: "EUR" },
      });
      expect((await repos.alerts.get(userA, id))?.triggeredAt).toBe(timestamp);
    }
    for (const id of [stillAbove.id, stillBelow.id]) expect((await repos.alerts.get(userA, id))?.triggeredAt).toBeNull();
    expect(market.getQuotes).toHaveBeenCalledExactlyOnceWith([instrument.id]);

    // A triggered alert remains triggered even if its current quote changes.
    currentTime = "2026-10-11T13:00:00.000Z";
    quotes[instrument.id] = quote(170);
    const changed = await request(app).get("/api/alerts").expect(200);
    expect(changed.body.alerts.find((alert: PriceAlert) => alert.id === above.id)).toMatchObject({
      triggeredAt: timestamp, triggeredPrice: 180, quote: { price: 170 },
    });
  });

  it("leaves missing, null-price and wrong-currency quotes active", async () => {
    const missing = await repos.alerts.create(userA, input, timestamp);
    const noPrice = await repos.alerts.create(userA, { ...input, instrument: secondInstrument }, timestamp);
    const usdInstrument: Instrument = { ...instrument, id: "SAP:XNYS", mic: "XNYS", exchange: "NYSE", currency: "USD" };
    const wrongCurrency = await repos.alerts.create(userA, { ...input, instrument: usdInstrument }, timestamp);
    quotes[secondInstrument.id] = quote(null, secondInstrument);
    quotes[usdInstrument.id] = { ...quote(200, usdInstrument), currency: "EUR" };
    const response = await request(app).get("/api/alerts").expect(200);
    expect(response.body.triggeredCount).toBe(0);
    for (const id of [missing.id, noPrice.id, wrongCurrency.id]) {
      expect(response.body.alerts.find((alert: PriceAlert) => alert.id === id)).toMatchObject({ quote: null, triggeredAt: null });
      expect((await repos.alerts.get(userA, id))?.triggeredAt).toBeNull();
    }
  });

  it.each([
    new ApiError(503, "MARKET_DATA_UNAVAILABLE", "Die Quelle ist nicht verfügbar."),
    new ApiError(404, "NOT_FOUND", "Kein Kurs verfügbar."),
    new Error("provider-failure"),
  ])("returns alerts without quotes when market data throws %s", async (error) => {
    const active = await repos.alerts.create(userA, input, timestamp);
    const triggered = await repos.alerts.create(userA, { ...input, condition: "BELOW" }, timestamp);
    await repos.alerts.markTriggered(userA, triggered.id, timestamp, 170);
    vi.mocked(market.getQuotes).mockRejectedValue(error);
    const response = await request(app).get("/api/alerts").expect(200);
    expect(response.body.triggeredCount).toBe(1);
    expect(response.body.alerts).toHaveLength(2);
    expect(response.body.alerts.every((alert: PriceAlert) => alert.quote === null)).toBe(true);
    expect((await repos.alerts.get(userA, active.id))?.triggeredAt).toBeNull();
    expect((await repos.alerts.get(userA, triggered.id))?.triggeredPrice).toBe(170);
  });

  it("checks all own active alerts before filtering and counts only the returned triggers", async () => {
    const selected = await repos.alerts.create(userA, input, timestamp);
    const other = await repos.alerts.create(userA, { ...input, instrument: secondInstrument }, timestamp);
    quotes[instrument.id] = quote(180);
    quotes[secondInstrument.id] = quote(190, secondInstrument);
    const response = await request(app).get(`/api/alerts?instrumentId=${encodeURIComponent(instrument.id)}`).expect(200);
    expect(response.body.alerts.map((alert: PriceAlert) => alert.id)).toEqual([selected.id]);
    expect(response.body.triggeredCount).toBe(1);
    expect((await repos.alerts.get(userA, other.id))?.triggeredAt).toBe(timestamp);
    expect(vi.mocked(market.getQuotes).mock.calls[0]?.[0].sort()).toEqual([instrument.id, secondInstrument.id].sort());
    await request(app).get("/api/alerts?instrumentId=invalid").expect(400);
  });

  it("sorts triggered alerts by newest trigger and active alerts by newest creation", async () => {
    const olderTrigger = await repos.alerts.create(userA, input, "2026-10-05T12:00:00.000Z");
    const newerTrigger = await repos.alerts.create(userA, input, "2026-10-04T12:00:00.000Z");
    const activeOlder = await repos.alerts.create(userA, input, "2026-10-08T12:00:00.000Z");
    const activeNewer = await repos.alerts.create(userA, input, "2026-10-09T12:00:00.000Z");
    await repos.alerts.markTriggered(userA, olderTrigger.id, "2026-10-06T12:00:00.000Z", 180);
    await repos.alerts.markTriggered(userA, newerTrigger.id, "2026-10-07T12:00:00.000Z", 185);
    const response = await request(app).get("/api/alerts").expect(200);
    expect(response.body.alerts.map((alert: PriceAlert) => alert.id)).toEqual([
      newerTrigger.id, olderTrigger.id, activeNewer.id, activeOlder.id,
    ]);
    expect(response.body.triggeredCount).toBe(2);
  });

  it("reactivates, triggers again on a later fetch and deletes own alerts", async () => {
    const alert = await repos.alerts.create(userA, input, timestamp);
    await repos.alerts.markTriggered(userA, alert.id, timestamp, 190);
    const active = await request(app).post(`/api/alerts/${alert.id}/reactivate`).expect(200);
    expect(active.body).toMatchObject({ id: alert.id, triggeredAt: null, triggeredPrice: null, quote: null });
    expect(market.getQuotes).not.toHaveBeenCalled();
    currentTime = "2026-10-11T14:00:00.000Z";
    quotes[instrument.id] = quote(185);
    await request(app).get("/api/alerts").expect(200);
    expect(await repos.alerts.get(userA, alert.id)).toMatchObject({ triggeredAt: currentTime, triggeredPrice: 185 });
    await request(app).delete(`/api/alerts/${alert.id}`).expect(204);
    expect(await repos.alerts.get(userA, alert.id)).toBeUndefined();
    await request(app).post(`/api/alerts/${alert.id}/reactivate`).expect(404);
    await request(app).delete(`/api/alerts/${alert.id}`).expect(404);
    await request(app).post("/api/alerts/unknown/reactivate").expect(404);
    await request(app).delete("/api/alerts/unknown").expect(404);
  });

  it("enforces the limit across active and triggered alerts independently for each user", async () => {
    for (let index = 0; index < MAX_PRICE_ALERTS - 1; index += 1) {
      const alert = await repos.alerts.create(userA, input, timestamp);
      if (index % 2 === 0) await repos.alerts.markTriggered(userA, alert.id, timestamp, 180);
    }
    const last = await request(app).post("/api/alerts").send(input).expect(201);
    const limited = await request(app).post("/api/alerts").send(input).expect(409);
    expect(limited.body.error.code).toBe("CONFLICT");
    expect(limited.body.error.message).toContain(String(MAX_PRICE_ALERTS));
    expect(await repos.alerts.count(userA)).toBe(MAX_PRICE_ALERTS);
    await request(app).post("/api/alerts").set("Test-User", userB).send(input).expect(201);
    await request(app).delete(`/api/alerts/${last.body.id}`).expect(204);
    await request(app).post("/api/alerts").send(input).expect(201);
  });

  it("keeps concurrent alarm creations within the user's limit", async () => {
    await Promise.all(Array.from({ length: MAX_PRICE_ALERTS - 1 }, () => repos.alerts.create(userA, input, timestamp)));
    const atomic = vi.spyOn(repos, "atomic");
    const results = await Promise.all([
      request(app).post("/api/alerts").send(input),
      request(app).post("/api/alerts").send(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await repos.alerts.count(userA)).toBe(MAX_PRICE_ALERTS);
    expect(atomic).toHaveBeenCalledTimes(2);
    expect(atomic.mock.calls.every(([, options]) => options?.lockKey === userA)).toBe(true);
  });

  it("checks the fresh alarm state after fetching quotes outside the transaction", async () => {
    const previous = await repos.alerts.create(userA, input, timestamp);
    let freshId: string | undefined;
    vi.mocked(market.getQuotes).mockImplementationOnce(async () => {
      await repos.alerts.delete(userA, previous.id);
      freshId = (await repos.alerts.create(userA, input, timestamp)).id;
      return { [instrument.id]: quote(185) };
    });
    const response = await request(app).get("/api/alerts").expect(200);
    expect(response.body.alerts).toHaveLength(1);
    expect(response.body.alerts[0]).toMatchObject({ id: freshId, triggeredAt: timestamp, triggeredPrice: 185 });
    expect(await repos.alerts.get(userA, previous.id)).toBeUndefined();
  });

  it("batches more than 50 distinct instruments and retains successful batch quotes", async () => {
    const created = await Promise.all(Array.from({ length: 51 }, async (_, index) => {
      const nextInstrument = { ...instrument, id: `STOCK${index}:XETR`, symbol: `STOCK${index}` };
      quotes[nextInstrument.id] = quote(185, nextInstrument);
      return repos.alerts.create(userA, { ...input, instrument: nextInstrument }, timestamp);
    }));
    vi.mocked(market.getQuotes).mockRejectedValueOnce(new Error("first-batch-unavailable"));
    const response = await request(app).get("/api/alerts").expect(200);
    const calls = vi.mocked(market.getQuotes).mock.calls.map(([ids]) => ids);
    expect(calls.map((ids) => ids.length)).toEqual([50, 1]);
    expect(new Set(calls.flat()).size).toBe(51);
    expect(response.body.alerts).toHaveLength(51);
    expect(response.body.triggeredCount).toBe(1);
    const triggeredId = created.find((alert) => alert.instrumentId === calls[1]![0])!.id;
    expect(response.body.alerts[0]).toMatchObject({ id: triggeredId, triggeredPrice: 185 });
    expect(response.body.alerts.filter((alert: PriceAlert) => alert.quote === null)).toHaveLength(50);
  });

  it("never exposes or mutates another user's alerts and ignores supplied user IDs", async () => {
    const foreign = await repos.alerts.create(userA, input, timestamp);
    quotes[instrument.id] = quote(185);
    const response = await request(app).get(`/api/alerts?userId=${userA}&instrumentId=${encodeURIComponent(instrument.id)}`)
      .set("Test-User", userB).expect(200);
    expect(response.body).toEqual({ alerts: [], triggeredCount: 0 });
    expect(market.getQuotes).not.toHaveBeenCalled();
    expect((await repos.alerts.get(userA, foreign.id))?.triggeredAt).toBeNull();
    await request(app).post(`/api/alerts/${foreign.id}/reactivate`).set("Test-User", userB).expect(404);
    await request(app).delete(`/api/alerts/${foreign.id}`).set("Test-User", userB).expect(404);
    expect(await repos.alerts.get(userA, foreign.id)).toBeDefined();
    const own = await request(app).post("/api/alerts").set("Test-User", userB).send({ ...input, userId: userA }).expect(201);
    expect(await repos.alerts.get(userA, own.body.id)).toBeUndefined();
    await request(app).get("/api/alerts").set("Test-User", userB).expect(200);
    expect((await repos.alerts.get(userB, own.body.id))?.triggeredAt).toBe(timestamp);
    expect((await repos.alerts.get(userA, foreign.id))?.triggeredAt).toBeNull();
  });
});
