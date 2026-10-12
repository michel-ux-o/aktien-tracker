import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../shared/api";
import type { Instrument, TransactionInput } from "../shared/types";
import { createApp } from "./app";
import { createTestRepositories } from "./db/testing";
import type { Repositories } from "./db/types";
import { ApiError } from "./errors";
import { DemoProvider } from "./market";
import type { Mailer } from "./mail";

const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
const now = () => new Date("2026-10-11T12:00:00.000Z");
const mailer: Mailer = { mode: "console", sendPasswordReset: async () => {} };

describe("API-Zugriffsschutz und Verträge", () => {
  let repos: Repositories;
  let close: () => Promise<void>;
  let market: DemoProvider;
  let app: ReturnType<typeof createApp>;
  let instrument: Instrument;
  beforeEach(async () => {
    ({ repos, close } = await createTestRepositories());
    market = new DemoProvider({ now });
    app = createApp({ repos, market, mailer, now });
    instrument = (await market.search("AAPL")).results[0]!;
  });
  afterEach(async () => { await close(); vi.restoreAllMocks(); });

  async function user(email: string) {
    const agent = request.agent(app);
    const registered = await agent.post("/api/auth/register").set(csrf).send({ email, password: "Sicheres-Passwort-123" }).expect(201);
    return { agent, id: registered.body.user.id as string };
  }
  function buy(): TransactionInput {
    return { instrument, type: "BUY", date: "2026-10-01", quantity: 5, price: 100, fees: 1, currency: "USD", clientRequestId: randomUUID() };
  }

  it("liefert einen öffentlichen Status und schützt sämtliche Datenrouten ohne Session", async () => {
    const status = await request(app).get("/api/status").expect(200);
    expect(status.body).toEqual({ marketData: { mode: "demo", source: "Demo-Daten", delayNote: "Demo – keine echten Marktdaten" }, email: { mode: "console" } });
    for (const path of ["/api/settings", "/api/watchlist", "/api/transactions", "/api/alerts", "/api/portfolio", "/api/portfolio/history?range=1M", "/api/market/search?q=SAP"]) {
      const response = await request(app).get(path).expect(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    }
    await request(app).post("/api/transactions").set(csrf).send(buy()).expect(401);
    await request(app).post("/api/transactions/import").set(csrf).send({ importId: randomUUID(), transactions: [buy()] }).expect(401);
    await request(app).post("/api/alerts").set(csrf).send({ instrument, condition: "ABOVE", targetPrice: 100 }).expect(401);
    await request(app).post(`/api/alerts/${randomUUID()}/reactivate`).set(csrf).expect(401);
    await request(app).delete(`/api/alerts/${randomUUID()}`).set(csrf).expect(401);
  });

  it("verlangt den CSRF-Header auch auf öffentlichen Auth-Routen und authentifizierten Mutationen", async () => {
    for (const path of ["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/password-reset/request", "/api/auth/password-reset/confirm"]) {
      const response = await request(app).post(path).send({}).expect(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    const { agent } = await user("csrf@example.com");
    await agent.post("/api/transactions").send(buy()).expect(403);
    await agent.post("/api/transactions/import").send({ importId: randomUUID(), transactions: [buy()] }).expect(403);
    await agent.post("/api/alerts").send({ instrument, condition: "ABOVE", targetPrice: 100 }).expect(403);
    await agent.post(`/api/alerts/${randomUUID()}/reactivate`).expect(403);
    await agent.delete(`/api/alerts/${randomUUID()}`).expect(403);
    await agent.post("/api/watchlist").send({ instrument }).expect(403);
    await agent.put("/api/settings").send({ theme: "dark" }).expect(403);
    await agent.delete("/api/watchlist/AAPL%3AXNAS").expect(403);
    await agent.post("/api/watchlist").set(CSRF_HEADER, "falsch").send({ instrument }).expect(403);
  });

  it("trennt Transaktionen, Watchlist, Einstellungen und Portfolio zweier Nutzer", async () => {
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const created = await a.agent.post("/api/transactions").set(csrf).send(buy()).expect(201);
    const transactionId = created.body.id as string;
    await a.agent.post("/api/watchlist").set(csrf).send({ instrument }).expect(201);
    await a.agent.put("/api/settings").set(csrf).send({ baseCurrency: "USD", theme: "dark" }).expect(200);

    const transactions = await b.agent.get(`/api/transactions?userId=${a.id}&instrumentId=AAPL%3AXNAS`).expect(200);
    expect(transactions.body.transactions).toEqual([]);
    await b.agent.put(`/api/transactions/${transactionId}`).set(csrf).send(buy()).expect(404);
    await b.agent.delete(`/api/transactions/${transactionId}`).set(csrf).expect(404);
    const watchlist = await b.agent.get(`/api/watchlist?userId=${a.id}`).expect(200);
    expect(watchlist.body.items).toEqual([]);
    await b.agent.delete("/api/watchlist/AAPL%3AXNAS").set(csrf).expect(404);
    const settings = await b.agent.get(`/api/settings?userId=${a.id}`).expect(200);
    expect(settings.body).toEqual({ baseCurrency: "EUR", theme: "system" });
    await b.agent.put("/api/settings").set(csrf).send({ userId: a.id, theme: "light" }).expect(200);
    await b.agent.put(`/api/settings/${a.id}`).set(csrf).send({ theme: "light" }).expect(404);
    await b.agent.delete(`/api/settings/${a.id}`).set(csrf).expect(404);
    const emptyPortfolio = await b.agent.get(`/api/portfolio?userId=${a.id}`).expect(200);
    expect(emptyPortfolio.body.positions).toEqual([]);
    expect(emptyPortfolio.body.closedPositions).toEqual([]);
    const emptyHistory = await b.agent.get(`/api/portfolio/history?range=1M&userId=${a.id}`).expect(200);
    expect(emptyHistory.body.points).toEqual([]);
    await b.agent.put(`/api/portfolio/${a.id}`).set(csrf).send({}).expect(404);
    await b.agent.delete(`/api/portfolio/${a.id}`).set(csrf).expect(404);

    // Derselbe Börsenwert kann unabhängig auf beiden Watchlists liegen.
    await b.agent.post("/api/watchlist").set(csrf).send({ instrument }).expect(201);
    await b.agent.delete("/api/watchlist/AAPL%3AXNAS").set(csrf).expect(204);
    expect((await a.agent.get("/api/watchlist")).body.items).toHaveLength(1);
    expect((await a.agent.get("/api/transactions")).body.transactions).toHaveLength(1);
    expect((await a.agent.get("/api/settings")).body).toEqual({ baseCurrency: "USD", theme: "dark" });
    expect((await a.agent.get("/api/portfolio").expect(200)).body.positions).toHaveLength(1);
  });

  it("trennt importierte Transaktionen und Kursalarme zweier Nutzer auch bei derselben Importkennung", async () => {
    const a = await user("import-a@example.com");
    const b = await user("import-b@example.com");
    const importId = randomUUID();
    const importedA = await a.agent.post("/api/transactions/import").set(csrf)
      .send({ importId, transactions: [{ ...buy(), note: "Import von Nutzer A" }] }).expect(201);
    const transactionA = importedA.body.transactions[0];
    const alarmA = await a.agent.post("/api/alerts").set(csrf)
      .send({ instrument, condition: "ABOVE", targetPrice: 100_000, note: "Alarm von Nutzer A" }).expect(201);

    expect((await b.agent.get(`/api/transactions?userId=${a.id}`).expect(200)).body.transactions).toEqual([]);
    const emptyAlerts = await b.agent.get(`/api/alerts?userId=${a.id}&instrumentId=AAPL%3AXNAS`).expect(200);
    expect(emptyAlerts.body).toEqual({ alerts: [], triggeredCount: 0 });
    await b.agent.put(`/api/transactions/${transactionA.id}`).set(csrf).send(buy()).expect(404);
    await b.agent.delete(`/api/transactions/${transactionA.id}`).set(csrf).expect(404);
    await b.agent.post(`/api/alerts/${alarmA.body.id}/reactivate`).set(csrf).expect(404);
    await b.agent.delete(`/api/alerts/${alarmA.body.id}`).set(csrf).expect(404);

    const importedB = await b.agent.post("/api/transactions/import").set(csrf)
      .send({ importId, transactions: [{ ...buy(), note: "Import von Nutzer B" }], userId: a.id }).expect(201);
    expect(importedB.body.created).toBe(1);
    expect(importedB.body.transactions[0].id).not.toBe(transactionA.id);
    expect(importedB.body.transactions[0].note).toBe("Import von Nutzer B");
    const replayB = await b.agent.post("/api/transactions/import").set(csrf)
      .send({ importId, transactions: [buy()] }).expect(200);
    expect(replayB.body).toEqual(importedB.body);
    expect((await b.agent.get("/api/transactions").expect(200)).body.transactions).toEqual(importedB.body.transactions);
    expect((await a.agent.get("/api/transactions").expect(200)).body.transactions).toEqual(importedA.body.transactions);
    const preservedAlerts = await a.agent.get("/api/alerts").expect(200);
    expect(preservedAlerts.body.alerts).toHaveLength(1);
    expect(preservedAlerts.body.alerts[0]).toMatchObject({ id: alarmA.body.id, note: "Alarm von Nutzer A", triggeredAt: null });
  });

  it("erlaubt gültige Importe über 100 kB und begrenzt sie auf 2 MB", async () => {
    const { agent } = await user("import-size@example.com");
    const transactions = Array.from({ length: 160 }, () => ({ ...buy(), note: "x".repeat(500) }));
    const payload = { importId: randomUUID(), transactions };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(2 * 1024 * 1024);
    const imported = await agent.post("/api/transactions/import").set(csrf).send(payload).expect(201);
    expect(imported.body.created).toBe(transactions.length);
    expect(imported.body.transactions).toHaveLength(transactions.length);

    const oversized = await agent.post("/api/transactions/import").set(csrf)
      .send({ importId: randomUUID(), transactions: [buy()], padding: "x".repeat(2 * 1024 * 1024) }).expect(400);
    expect(oversized.body.error).toEqual({ code: "VALIDATION_ERROR", message: "Die Anfrage ist zu groß." });
    expect((await agent.get("/api/transactions").expect(200)).body.transactions).toHaveLength(transactions.length);
  });

  it("behält 100 kB für andere Routen und Methoden am Importpfad bei", async () => {
    const { agent } = await user("body-limits@example.com");
    const body = { padding: "x".repeat(101 * 1024) };
    const responses = [
      await agent.post("/api/transactions").set(csrf).send(body).expect(400),
      await agent.post("/api/alerts").set(csrf).send(body).expect(400),
      await agent.put("/api/settings").set(csrf).send(body).expect(400),
      await agent.put("/api/transactions/import").set(csrf).send(body).expect(400),
      await agent.delete("/api/transactions/import").set(csrf).send(body).expect(400),
      await agent.post("/api/transactions/import/extra").set(csrf).send(body).expect(400),
    ];
    for (const response of responses) {
      expect(response.body.error).toEqual({ code: "VALIDATION_ERROR", message: "Die Anfrage ist zu groß." });
    }
    expect((await agent.get("/api/transactions").expect(200)).body.transactions).toEqual([]);
    expect((await agent.get("/api/alerts").expect(200)).body.alerts).toEqual([]);
  });

  it("bewertet importierte Dividenden und Splits mit historischen Wechselkursen", async () => {
    const { agent } = await user("historical-fx@example.com");
    await agent.post("/api/transactions/import").set(csrf).send({
      importId: randomUUID(),
      transactions: [
        { ...buy(), fees: 0 },
        { ...buy(), type: "DIVIDEND", date: "2026-10-02", price: 2, fees: 1 },
        { ...buy(), type: "SPLIT", date: "2026-10-04", quantity: 0, price: 0, fees: 0, ratio: 2 },
      ],
    }).expect(201);
    const quote = await market.getQuote(instrument.id);
    vi.spyOn(market, "getQuote").mockResolvedValue({ ...quote, price: 60, previousClose: 55, change: 5 });
    vi.spyOn(market, "getFxRate").mockResolvedValue({ from: "USD", to: "EUR", rate: 0.95, asOf: now().toISOString(), source: market.source });
    const fxHistory = vi.spyOn(market, "getFxHistory").mockResolvedValue({
      from: "USD", to: "EUR", meta: market.meta(),
      points: [{ date: "2026-10-01", rate: 0.8 }, { date: "2026-10-02", rate: 0.9 }],
    });

    const portfolio = await agent.get("/api/portfolio").expect(200);
    expect(portfolio.body.positions).toHaveLength(1);
    expect(portfolio.body.positions[0]).toMatchObject({ quantity: 10, costBasis: 500, costBasisBase: 400, dividends: 9, dividendsBase: 8.1 });
    expect(portfolio.body.positions[0].unrealizedFxEffectBase).toBeCloseTo(75);
    expect(portfolio.body.summary).toMatchObject({ totalMarketValue: 570, totalCostBasis: 400, unrealizedPnl: 170, dividends: 8.1, complete: true });
    expect(portfolio.body.summary.unrealizedFxEffect).toBeCloseTo(75);
    expect(fxHistory).toHaveBeenCalledExactlyOnceWith("USD", "EUR", "1M");
  });

  it("hält Watchlist-POST idempotent und validiert Basiswährung sowie Marktparameter", async () => {
    const { agent } = await user("validation@example.com");
    const first = await agent.post("/api/watchlist").set(csrf).send({ instrument }).expect(201);
    const second = await agent.post("/api/watchlist").set(csrf).send({ instrument }).expect(200);
    expect(second.body.addedAt).toBe(first.body.addedAt);
    expect((await agent.get("/api/watchlist")).body.items).toHaveLength(1);
    const invalid = await agent.put("/api/settings").set(csrf).send({ baseCurrency: "JPY" }).expect(400);
    expect(invalid.body.error.fields.baseCurrency).toBeTruthy();
    const wrongType = await agent.put("/api/settings").set(csrf).send({ baseCurrency: 123 }).expect(400);
    expect(wrongType.body.error.fields.baseCurrency).toBe("Dieses Feld enthält einen ungültigen Wert.");
    const missingQuery = await agent.get("/api/market/search").expect(400);
    expect(missingQuery.body.error.fields.q).toBe("Dieses Feld enthält einen ungültigen Wert.");
    await agent.get("/api/market/search?q=").expect(400);
    await agent.get("/api/market/history?id=AAPL%3AXNAS&range=2Y").expect(400);
    await agent.get("/api/market/quote?id=UNKNOWN%3AXNAS").expect(404);
    await agent.get(`/api/market/quotes?ids=${Array.from({ length: 51 }, () => "AAPL:XNAS").join(",")}`).expect(400);
    const search = await agent.get("/api/market/search?q=SAP").expect(200);
    expect(search.body.results.map((entry: Instrument) => entry.id)).toEqual(expect.arrayContaining(["SAP:XETR", "SAP:XNYS"]));
    await agent.get("/api/market/profile?id=AAPL%3AXNAS").expect(200);
    const history = await agent.get("/api/market/history?id=AAPL%3AXNAS&range=1M").expect(200);
    expect(history.body.points.length).toBeGreaterThan(0);
  });

  it("liefert bei fehlenden Kursen und Wechselkursen eine eingeschränkte Portfolioauswertung", async () => {
    const { agent } = await user("missing@example.com");
    const missing = (await market.search("NODATA")).results[0]!;
    await agent.post("/api/transactions").set(csrf).send({ ...buy(), instrument: missing, currency: "EUR" }).expect(201);
    await agent.post("/api/transactions").set(csrf).send(buy()).expect(201);
    vi.spyOn(market, "getFxRate").mockResolvedValue(null);
    vi.spyOn(market, "getFxHistory").mockResolvedValue({ from: "USD", to: "EUR", points: [], meta: market.meta() });
    const portfolio = await agent.get("/api/portfolio").expect(200);
    expect(portfolio.body.summary.complete).toBe(false);
    expect(portfolio.body.summary.missingPrices).toContain("NODATA:XETR");
    expect(portfolio.body.summary.missingFx).toContain("USD");
    const history = await agent.get("/api/portfolio/history?range=1M").expect(200);
    expect(history.body.complete).toBe(false);
    expect(history.body.notes.length).toBeGreaterThan(0);
    // Ein Ausfall der Quelle macht die berechneten Bestände weiterhin abrufbar.
    vi.spyOn(market, "getQuote").mockRejectedValue(new ApiError(503, "MARKET_DATA_UNAVAILABLE", "Die Quelle ist nicht verfügbar."));
    expect((await agent.get("/api/portfolio").expect(200)).body.positions).toHaveLength(2);
  });

  it("gibt deutsche JSON-Fehler ohne interne Details zurück", async () => {
    const { agent } = await user("errors@example.com");
    const invalidJson = await agent.put("/api/settings").set(csrf).set("Content-Type", "application/json").send("{").expect(400);
    expect(invalidJson.body.error.code).toBe("VALIDATION_ERROR");
    const unknown = await agent.get("/api/does-not-exist").expect(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(market, "search").mockRejectedValue(new Error("secret-internal-stack"));
    const internal = await agent.get("/api/market/search?q=SAP").expect(500);
    expect(internal.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(internal.body)).not.toContain("secret-internal-stack");
    expect(internal.body.error).not.toHaveProperty("stack");
  });

  it("leitet abgelehnte Datenbank-Promises als interne Fehler ohne Datenbankdetails weiter", async () => {
    const { agent } = await user("database-errors@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const databaseError = Object.assign(new Error("postgres://secret-password@internal-host/database"), {
      code: "23505", detail: "Interne Tabelle und private Nutzerdaten",
    });
    vi.spyOn(repos.settings, "get").mockRejectedValueOnce(databaseError);
    vi.spyOn(repos.sessions, "findValid").mockRejectedValueOnce(databaseError);
    // Sowohl die asynchrone Auth-Middleware als auch die Route müssen den errorHandler erreichen.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await agent.get("/api/settings").expect(500);
      expect(response.body).toEqual({ error: {
        code: "INTERNAL_ERROR", message: "Ein interner Fehler ist aufgetreten. Bitte versuche es später erneut.",
      } });
    }
  });

  it("vertraut standardmäßig nur in Produktion einem Proxy-Hop und erlaubt eine explizite Vorgabe", () => {
    expect(app.get("trust proxy")).toBe(false);
    expect(createApp({ repos, market, mailer, production: true }).get("trust proxy")).toBe(1);
    expect(createApp({ repos, market, mailer, production: true, trustProxy: 0 }).get("trust proxy")).toBe(0);
    expect(createApp({ repos, market, mailer, production: false, trustProxy: 2 }).get("trust proxy")).toBe(2);
  });

  it("liefert im Produktionsmodus Assets und SPA-Seiten, während API-Pfade JSON bleiben", async () => {
    // mkdtemp erstellt ausschließlich eine eigene Test-Directory unter server/.
    const distDir = mkdtempSync(join(import.meta.dirname, "static-test-"));
    try {
      writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Aktien-Tracker</title>");
      writeFileSync(join(distDir, "asset.js"), "window.tracker = true;");
      const productionApp = createApp({ repos, market, mailer, now, production: true, distDir });
      const page = await request(productionApp).get("/portfolio").expect(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.text).toContain("Aktien-Tracker");
      expect((await request(productionApp).get("/asset.js").expect(200)).text).toContain("window.tracker");
      const anonymous = await request(productionApp).get("/api/unknown").expect(401);
      expect(anonymous.headers["content-type"]).toContain("application/json");
      const registered = await user("production@example.com");
      const cookie = (await registered.agent.post("/api/auth/login").set(csrf).send({ email: "production@example.com", password: "Sicheres-Passwort-123" })).headers["set-cookie"]![0]!.split(";")[0]!;
      const missing = await request(productionApp).get("/api/unknown").set("Cookie", cookie).expect(404);
      expect(missing.body.error.code).toBe("NOT_FOUND");
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});
