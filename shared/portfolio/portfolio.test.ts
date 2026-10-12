import { describe, expect, it, vi } from "vitest";
import type { DataMeta, FxRate, Instrument, Quote, Transaction } from "../types";
import { buildPortfolio, computeHoldings, type FxLookup } from "./index";

const meta: DataMeta = {
  source: "Testdaten",
  mode: "demo",
  fetchedAt: "2024-05-03T18:00:00.000Z",
  delayMinutes: null,
  delayNote: null,
};

function instrument(symbol = "TEST", currency = "EUR"): Instrument {
  return {
    id: `${symbol}:XETR`,
    symbol,
    name: `${symbol} Aktien`,
    exchange: "XETRA",
    mic: "XETR",
    currency,
    country: null,
    type: "Common Stock",
  };
}

function transaction(
  security: Instrument,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id: "buy-1",
    instrumentId: security.id,
    instrument: security,
    type: "BUY",
    date: "2024-05-01",
    quantity: 1,
    price: 100,
    fees: 0,
    currency: security.currency,
    ratio: null,
    note: null,
    createdAt: "2024-05-01T10:00:00.000Z",
    updatedAt: "2024-05-01T10:00:00.000Z",
    ...overrides,
  };
}

function quote(security: Instrument, price: number | null, change = 0): Quote {
  return {
    instrumentId: security.id,
    currency: security.currency,
    price,
    previousClose: price === null ? null : price - change,
    change,
    changePercent: price === null ? null : (change / (price - change)) * 100,
    asOf: "2024-05-03T17:30:00.000Z",
    isMarketOpen: false,
    meta,
  };
}

function fxRate(from: string, rate: number): FxRate {
  return {
    from,
    to: "EUR",
    rate,
    asOf: "2024-05-03T18:00:00.000Z",
    source: "Test-Wechselkurse",
  };
}

const noFx: FxLookup = () => null;

function datedUsdFx(rates: Record<string, number>, currentRate: number | null): FxLookup {
  return (from, to, date) => {
    if (from !== "USD" || to !== "EUR") return null;
    const rate = date === null ? currentRate : rates[date] ?? null;
    return rate === null ? null : { ...fxRate(from, rate), asOf: date ?? meta.fetchedAt };
  };
}

describe("computeHoldings", () => {
  it("liefert ohne Transaktionen keine Bestände", () => {
    expect(computeHoldings([])).toEqual([]);
  });

  it("gewichtet mehrere Käufe einschließlich Kaufgebühren", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 3, price: 120, fees: 3 }),
      transaction(security, { quantity: 2, price: 100, fees: 2 }),
    ]);

    expect(holding).toMatchObject({
      instrumentId: security.id,
      instrument: security,
      currency: "EUR",
      quantity: 5,
      costBasis: 565,
      averageCost: 113,
      realizedPnl: 0,
      totalFees: 5,
      transactionCount: 2,
    });
  });

  it("entfernt beim Teilverkauf den anteiligen Einstand und mindert den Erlös um Gebühren", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 2, price: 100, fees: 2 }),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 3, price: 120, fees: 3 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", quantity: 2, price: 140, fees: 4 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 3,
      costBasis: 339,
      averageCost: 113,
      realizedPnl: 50,
      totalFees: 9,
      transactionCount: 3,
    });
  });

  it("setzt Bestand und Einstand beim Komplettverkauf exakt auf null Stück und null Euro", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 2, price: 100, fees: 2 }),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 3, price: 120, fees: 3 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", quantity: 5, price: 140, fees: 4 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 0,
      costBasis: 0,
      averageCost: null,
      realizedPnl: 131,
      totalFees: 9,
    });
  });

  it("behält realisierte Ergebnisse bei einem späteren Neukauf bei", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 2, price: 100, fees: 4 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-02", quantity: 2, price: 120, fees: 2 }),
      transaction(security, { id: "buy-2", date: "2024-05-03", quantity: 1, price: 90, fees: 1 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 1,
      costBasis: 91,
      averageCost: 91,
      realizedPnl: 34,
      totalFees: 7,
      transactionCount: 3,
    });
  });

  it("berechnet Bruchstücke und anteilige Gebühren ohne Zwischenrundung", () => {
    const security = instrument();
    const transactions = [
      transaction(security, { quantity: 0.1, price: 50, fees: 0.05 }),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 0.2, price: 65, fees: 0.1 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", quantity: 0.05, price: 80, fees: 0.05 }),
    ];
    const [partial] = computeHoldings(transactions);

    expect(partial!.quantity).toBeCloseTo(0.25, 12);
    expect(partial!.costBasis).toBeCloseTo(15.125, 12);
    expect(partial!.averageCost).toBeCloseTo(60.5, 12);
    expect(partial!.realizedPnl).toBeCloseTo(0.925, 12);
    expect(partial!.totalFees).toBeCloseTo(0.2, 12);

    const [closed] = computeHoldings([
      ...transactions,
      transaction(security, { id: "sell-2", type: "SELL", date: "2024-05-04", quantity: 0.25, price: 70, fees: 0.1 }),
    ]);
    expect(closed!.quantity).toBe(0);
    expect(closed!.costBasis).toBe(0);
    expect(closed!.averageCost).toBeNull();
    expect(closed!.realizedPnl).toBeCloseTo(3.2, 12);
  });

  it("entfernt binäre Rundungsreste nach dem Verkauf aller Bruchstücke", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 0.1 }),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 0.2 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", quantity: 0.3, price: 110 }),
    ]);

    expect(holding!.quantity).toBe(0);
    expect(holding!.costBasis).toBe(0);
    expect(holding!.averageCost).toBeNull();
    expect(holding!.realizedPnl).toBeCloseTo(3, 12);
  });

  it("behält auch einen periodischen Durchschnittseinstand mit voller Genauigkeit", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 2, price: 101 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", price: 120 }),
    ]);

    expect(holding!.quantity).toBe(2);
    expect(holding!.averageCost).toBeCloseTo(302 / 3, 12);
    expect(holding!.costBasis).toBeCloseTo((302 / 3) * 2, 12);
    expect(holding!.realizedPnl).toBeCloseTo(120 - 302 / 3, 12);
  });

  it("verarbeitet am selben Tag Käufe vor Verkäufen unabhängig von der Eingabereihenfolge", () => {
    const security = instrument();
    const transactions = [
      transaction(security, { id: "sell", type: "SELL", quantity: 1, price: 250, createdAt: "2024-05-01T08:00:00.000Z" }),
      transaction(security, { id: "buy-b", quantity: 1, price: 200, createdAt: "2024-05-01T10:00:00.000Z" }),
      transaction(security, { id: "buy-a", quantity: 1, price: 100, createdAt: "2024-05-01T10:00:00.000Z" }),
    ];
    const [holding] = computeHoldings(transactions);

    expect(holding).toMatchObject({
      quantity: 1,
      costBasis: 150,
      averageCost: 150,
      realizedPnl: 100,
      transactionCount: 3,
    });
    expect(computeHoldings([...transactions].reverse())).toEqual([holding]);
  });

  it("summiert Netto-Dividenden ohne Bestand, Einstand, Ergebnis oder Kauf-/Verkaufsgebühren zu ändern", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 3, price: 100, fees: 3 }),
      transaction(security, { id: "dividend", type: "DIVIDEND", date: "2024-05-02", quantity: 3, price: 2, fees: 1 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 3,
      costBasis: 303,
      averageCost: 101,
      realizedPnl: 0,
      dividends: 5,
      totalFees: 3,
      transactionCount: 2,
    });
  });

  it("erfasst eine nach dem Komplettverkauf gutgeschriebene Dividende", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 3 }),
      transaction(security, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 3, price: 110 }),
      transaction(security, { id: "dividend", type: "DIVIDEND", date: "2024-05-03", quantity: 3, price: 2, fees: 1 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 0, costBasis: 0, averageCost: null, realizedPnl: 30, dividends: 5, totalFees: 0, transactionCount: 3,
    });
  });

  it.each([
    { ratio: 4, quantity: 40, averageCost: 25.125 },
    { ratio: 0.1, quantity: 1, averageCost: 1005 },
  ])("ändert beim Split mit Verhältnis $ratio nur Stückzahl und Durchschnittseinstand", ({ ratio, quantity, averageCost }) => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 10, fees: 5 }),
      transaction(security, { id: "split", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio }),
    ]);

    expect(holding).toMatchObject({
      quantity, costBasis: 1005, averageCost, realizedPnl: 0, dividends: 0, totalFees: 5, transactionCount: 2,
    });
  });

  it("bucht beim Verkauf nach einem Split den neuen Durchschnittseinstand aus", () => {
    const security = instrument();
    const [holding] = computeHoldings([
      transaction(security, { quantity: 2, fees: 2 }),
      transaction(security, { id: "split", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 4 }),
      transaction(security, { id: "sell", type: "SELL", date: "2024-05-03", quantity: 3, price: 30, fees: 1 }),
    ]);

    expect(holding).toMatchObject({
      quantity: 5, costBasis: 126.25, averageCost: 25.25, realizedPnl: 13.25, totalFees: 3, transactionCount: 3,
    });
  });

  it("verarbeitet am selben Tag Split, Kauf, Dividende und Verkauf vor createdAt und id", () => {
    const security = instrument();
    const transactions = [
      transaction(security, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 3, price: 200, fees: 3, createdAt: "2024-05-02T08:00:00.000Z" }),
      transaction(security, { id: "dividend", type: "DIVIDEND", date: "2024-05-02", quantity: 6, price: 2, fees: 2, createdAt: "2024-05-02T09:00:00.000Z" }),
      transaction(security, { id: "buy", date: "2024-05-02", quantity: 2, price: 150, createdAt: "2024-05-02T10:00:00.000Z" }),
      transaction(security, { id: "split", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 2, createdAt: "2024-05-02T11:00:00.000Z" }),
      transaction(security, { id: "previous-buy", quantity: 2 }),
    ];
    const [holding] = computeHoldings(transactions);

    expect(holding).toMatchObject({
      quantity: 3, costBasis: 250, realizedPnl: 347, dividends: 10, totalFees: 3, transactionCount: 5,
    });
    expect(holding!.averageCost).toBeCloseTo(250 / 3, 12);
    expect(computeHoldings([...transactions].reverse())).toEqual([holding]);
  });

  it("führt Bestände und Handelswährungen verschiedener Wertpapiere getrennt", () => {
    const euro = instrument("EURO");
    const dollar = instrument("DOLLAR", "USD");
    const holdings = computeHoldings([
      transaction(euro, { id: "eur-buy", quantity: 2, price: 10, fees: 1 }),
      transaction(dollar, { id: "usd-buy", quantity: 3, price: 100, fees: 2 }),
      transaction(euro, { id: "eur-sell", type: "SELL", date: "2024-05-02", quantity: 1, price: 20, fees: 1 }),
    ]);

    expect(holdings).toHaveLength(2);
    expect(holdings.find((holding) => holding.instrumentId === euro.id)).toMatchObject({
      currency: "EUR", quantity: 1, costBasis: 10.5, realizedPnl: 8.5, totalFees: 2,
    });
    expect(holdings.find((holding) => holding.instrumentId === dollar.id)).toMatchObject({
      currency: "USD", quantity: 3, costBasis: 302, realizedPnl: 0, totalFees: 2,
    });
  });

  it("verändert weder das Eingabearray noch die Transaktionen", () => {
    const security = instrument();
    const transactions = [
      transaction(security, { id: "later", date: "2024-05-02", price: 120 }),
      transaction(security, { id: "earlier", price: 100 }),
    ];
    const snapshot = structuredClone(transactions);
    Object.freeze(security);
    transactions.forEach(Object.freeze);
    Object.freeze(transactions);

    computeHoldings(transactions);

    expect(transactions).toEqual(snapshot);
  });
});

describe("buildPortfolio", () => {
  it("liefert für ein leeres Portfolio vollständige Nullsummen ohne FX-Abfrage", () => {
    const fx = vi.fn(noFx);
    const portfolio = buildPortfolio([], {}, "EUR", fx);

    expect(portfolio).toEqual({
      positions: [],
      closedPositions: [],
      summary: {
        baseCurrency: "EUR",
        totalMarketValue: 0,
        totalCostBasis: 0,
        unrealizedPnl: 0,
        unrealizedPnlPercent: null,
        unrealizedFxEffect: 0,
        realizedPnl: 0,
        dividends: 0,
        dayChange: 0,
        dayChangePercent: null,
        complete: true,
        missingPrices: [],
        missingFx: [],
        fxRates: [],
        openPositionCount: 0,
      },
    });
    expect(fx).not.toHaveBeenCalled();
  });

  it("trennt realisierte und unrealisierte Ergebnisse und bewertet Basiswährung mit Faktor 1", () => {
    const security = instrument();
    const currentQuote = quote(security, 150, 10);
    const fx = vi.fn(noFx);
    const portfolio = buildPortfolio([
      transaction(security, { quantity: 2, price: 100, fees: 2 }),
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 3, price: 120, fees: 3 }),
      transaction(security, { id: "sell-1", type: "SELL", date: "2024-05-03", quantity: 2, price: 140, fees: 4 }),
    ], { [security.id]: currentQuote }, "EUR", fx);
    const [position] = portfolio.positions;

    expect(position).toMatchObject({
      quantity: 3,
      costBasis: 339,
      realizedPnl: 50,
      quote: currentQuote,
      lastPrice: 150,
      marketValue: 450,
      unrealizedPnl: 111,
      dayChange: 30,
      fxRate: null,
      marketValueBase: 450,
      costBasisBase: 339,
      unrealizedPnlBase: 111,
      unrealizedFxEffectBase: 0,
      realizedPnlBase: 50,
      dividendsBase: 0,
      dayChangeBase: 30,
      weightPercent: 100,
    });
    expect(position!.unrealizedPnlPercent).toBeCloseTo((111 / 339) * 100, 12);
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 450,
      totalCostBasis: 339,
      unrealizedPnl: 111,
      realizedPnl: 50,
      dayChange: 30,
      complete: true,
      missingPrices: [],
      missingFx: [],
      fxRates: [],
      openPositionCount: 1,
    });
    expect(portfolio.summary.unrealizedPnlPercent).toBeCloseTo((111 / 339) * 100, 12);
    expect(portfolio.summary.dayChangePercent).toBeCloseTo((30 / 420) * 100, 12);
    expect(fx).not.toHaveBeenCalled();
  });

  it("erzeugt beim zusätzlichen Kauf zum aktuellen Kurs keinen zusätzlichen Gewinn", () => {
    const security = instrument();
    const firstBuy = transaction(security, { price: 100 });
    const quotes = { [security.id]: quote(security, 125) };
    const before = buildPortfolio([firstBuy], quotes, "EUR", noFx);
    const after = buildPortfolio([
      firstBuy,
      transaction(security, { id: "buy-2", date: "2024-05-02", quantity: 2, price: 125 }),
    ], quotes, "EUR", noFx);

    expect(before.summary.totalMarketValue).toBe(125);
    expect(before.summary.totalCostBasis).toBe(100);
    expect(after.summary.totalMarketValue).toBe(375);
    expect(after.summary.totalCostBasis).toBe(350);
    expect(before.summary.unrealizedPnl).toBe(25);
    expect(after.summary.unrealizedPnl).toBe(25);
    expect(before.summary.realizedPnl).toBe(0);
    expect(after.summary.realizedPnl).toBe(0);
  });

  it("rechnet USD-Werte bei identischen historischen und aktuellen Wechselkursen in EUR um", () => {
    const dollar = instrument("USD", "USD");
    const rate = fxRate("USD", 0.9);
    const fx = vi.fn((from: string, to: string, _date: string | null) => from === "USD" && to === "EUR" ? rate : null);
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 4, price: 100, fees: 4 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 1, price: 130, fees: 1 }),
    ], { [dollar.id]: quote(dollar, 120, 2) }, "EUR", fx);
    const [position] = portfolio.positions;

    expect(position).toMatchObject({
      currency: "USD",
      quantity: 3,
      costBasis: 303,
      marketValue: 360,
      unrealizedPnl: 57,
      realizedPnl: 28,
      dayChange: 6,
      fxRate: rate,
      marketValueBase: 324,
      weightPercent: 100,
    });
    expect(position!.costBasisBase).toBeCloseTo(272.7, 12);
    expect(position!.unrealizedPnlBase).toBeCloseTo(51.3, 12);
    expect(position!.realizedPnlBase).toBeCloseTo(25.2, 12);
    expect(position!.dayChangeBase).toBeCloseTo(5.4, 12);
    expect(portfolio.summary.totalMarketValue).toBe(324);
    expect(portfolio.summary.totalCostBasis).toBeCloseTo(272.7, 12);
    expect(portfolio.summary.unrealizedPnl).toBeCloseTo(51.3, 12);
    expect(portfolio.summary.realizedPnl).toBeCloseTo(25.2, 12);
    expect(portfolio.summary.fxRates).toEqual([rate]);
    expect(portfolio.summary.complete).toBe(true);
    expect(fx).toHaveBeenCalledWith("USD", "EUR", null);
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-05-01");
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-05-02");
  });

  it("addiert mehrere Handelswährungen erst nach Umrechnung und berechnet daraus Gewichte und Tagesänderung", () => {
    const euro = instrument("EUR");
    const dollar = instrument("USD", "USD");
    const rate = fxRate("USD", 0.9);
    const fx = vi.fn((from: string) => from === "USD" ? rate : null);
    const portfolio = buildPortfolio([
      transaction(euro, { id: "eur", price: 50 }),
      transaction(dollar, { id: "usd", quantity: 2, price: 100, fees: 2 }),
    ], { [euro.id]: quote(euro, 100, 10), [dollar.id]: quote(dollar, 125, 5) }, "EUR", fx);

    expect(portfolio.positions.map((position) => position.instrumentId)).toEqual([dollar.id, euro.id]);
    expect(portfolio.summary.totalMarketValue).toBe(325);
    expect(portfolio.summary.totalCostBasis).toBeCloseTo(231.8, 12);
    expect(portfolio.summary.unrealizedPnl).toBeCloseTo(93.2, 12);
    expect(portfolio.summary.unrealizedPnlPercent).toBeCloseTo((93.2 / 231.8) * 100, 12);
    expect(portfolio.summary.dayChange).toBe(19);
    expect(portfolio.summary.dayChangePercent).toBeCloseTo((19 / (325 - 19)) * 100, 12);
    expect(portfolio.positions[0]!.weightPercent).toBeCloseTo((225 / 325) * 100, 12);
    expect(portfolio.positions[1]!.weightPercent).toBeCloseTo((100 / 325) * 100, 12);
    expect(portfolio.summary.fxRates).toEqual([rate]);
    expect(fx.mock.calls.every(([from]) => from !== "EUR")).toBe(true);
  });

  it("führt denselben verwendeten Wechselkurs für mehrere Positionen nur einmal auf", () => {
    const first = instrument("USD-A", "USD");
    const second = instrument("USD-B", "USD");
    const rate = fxRate("USD", 0.9);
    const portfolio = buildPortfolio([
      transaction(first, { id: "first" }),
      transaction(second, { id: "second" }),
    ], { [first.id]: quote(first, 120), [second.id]: quote(second, 130) }, "EUR", () => ({ ...rate }));

    expect(portfolio.summary.fxRates).toEqual([rate]);
    expect(portfolio.summary.totalMarketValue).toBe(225);
    expect(portfolio.summary.totalCostBasis).toBe(180);
    expect(portfolio.summary.unrealizedPnl).toBe(45);
    expect(portfolio.summary.complete).toBe(true);
  });

  it("behält ohne USD-Wechselkurs die lokalen Werte, aber summiert ausschließlich EUR-Werte", () => {
    const euro = instrument("EUR");
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([
      transaction(euro, { id: "eur", price: 80 }),
      transaction(dollar, { id: "usd", quantity: 2, price: 100, fees: 2 }),
    ], { [euro.id]: quote(euro, 100, 10), [dollar.id]: quote(dollar, 125, 5) }, "EUR", noFx);

    expect(portfolio.positions.map((position) => position.instrumentId)).toEqual([euro.id, dollar.id]);
    expect(portfolio.positions[1]).toMatchObject({
      lastPrice: 125,
      marketValue: 250,
      costBasis: 202,
      unrealizedPnl: 48,
      dayChange: 10,
      fxRate: null,
      marketValueBase: null,
      costBasisBase: null,
      unrealizedPnlBase: null,
      realizedPnlBase: null,
      dayChangeBase: null,
      weightPercent: null,
    });
    expect(portfolio.positions[0]!.weightPercent).toBe(100);
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 100,
      totalCostBasis: 80,
      unrealizedPnl: 20,
      unrealizedPnlPercent: 25,
      realizedPnl: 0,
      dayChange: 10,
      complete: false,
      missingPrices: [],
      missingFx: ["USD"],
      fxRates: [],
      openPositionCount: 2,
    });
    expect(portfolio.summary.dayChangePercent).toBeCloseTo((10 / 90) * 100, 12);
  });

  it("zählt eine mehrfach fehlende Währung nur einmal", () => {
    const first = instrument("USD-A", "USD");
    const second = instrument("USD-B", "USD");
    const portfolio = buildPortfolio([
      transaction(first, { id: "first" }),
      transaction(second, { id: "second" }),
    ], { [first.id]: quote(first, 120), [second.id]: quote(second, 130) }, "EUR", noFx);

    expect(portfolio.summary.missingFx).toEqual(["USD"]);
    expect(portfolio.summary.complete).toBe(false);
    expect(portfolio.summary.totalMarketValue).toBeNull();
    expect(portfolio.summary.totalCostBasis).toBeNull();
    expect(portfolio.summary.unrealizedPnl).toBeNull();
    expect(portfolio.summary.realizedPnl).toBeNull();
    expect(portfolio.summary.dayChange).toBeNull();
  });

  it("berücksichtigt Einstand mit vorhandenem FX auch ohne Kurs, aber Ergebnisprozente nur für bewertete Positionen", () => {
    const valued = instrument("KURS");
    const missingEuro = instrument("OHNE-EUR");
    const missingDollar = instrument("OHNE-USD", "USD");
    const rate = fxRate("USD", 0.9);
    const portfolio = buildPortfolio([
      transaction(valued, { id: "valued", quantity: 2, price: 50 }),
      transaction(missingEuro, { id: "missing-eur", price: 80 }),
      transaction(missingDollar, { id: "missing-usd", quantity: 2, price: 50 }),
    ], { [valued.id]: quote(valued, 100, 10) }, "EUR", () => rate);

    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 200,
      totalCostBasis: 270,
      unrealizedPnl: 100,
      unrealizedPnlPercent: 100,
      dayChange: 20,
      complete: false,
      missingFx: [],
      fxRates: [rate],
      openPositionCount: 3,
    });
    expect(portfolio.summary.missingPrices).toHaveLength(2);
    expect(portfolio.summary.missingPrices).toEqual(expect.arrayContaining([missingEuro.id, missingDollar.id]));
    expect(portfolio.positions[0]!.instrumentId).toBe(valued.id);
    expect(portfolio.positions[0]!.weightPercent).toBe(100);
    expect(portfolio.positions.find((position) => position.instrumentId === missingEuro.id)).toMatchObject({
      quote: null,
      lastPrice: null,
      marketValue: null,
      unrealizedPnl: null,
      unrealizedPnlPercent: null,
      dayChange: null,
      fxRate: null,
      marketValueBase: null,
      costBasisBase: 80,
      unrealizedPnlBase: null,
      dayChangeBase: null,
      weightPercent: null,
    });
    expect(portfolio.positions.find((position) => position.instrumentId === missingDollar.id)).toMatchObject({
      costBasis: 100,
      costBasisBase: 90,
      marketValueBase: null,
      fxRate: rate,
      weightPercent: null,
    });
  });

  it("behandelt einen vorhandenen Quote mit price=null als fehlenden Kurs", () => {
    const security = instrument();
    const currentQuote = quote(security, null);
    const portfolio = buildPortfolio([transaction(security)], { [security.id]: currentQuote }, "EUR", noFx);

    expect(portfolio.positions[0]).toMatchObject({
      quote: currentQuote,
      lastPrice: null,
      marketValue: null,
      unrealizedPnl: null,
      marketValueBase: null,
      costBasisBase: 100,
      unrealizedPnlBase: null,
      weightPercent: null,
    });
    expect(portfolio.summary.totalMarketValue).toBeNull();
    expect(portfolio.summary.totalCostBasis).toBe(100);
    expect(portfolio.summary.unrealizedPnl).toBeNull();
    expect(portfolio.summary.complete).toBe(false);
    expect(portfolio.summary.missingPrices).toEqual([security.id]);
    expect(portfolio.summary.missingFx).toEqual([]);
  });

  it("setzt ohne Tagesänderungsdaten die Tagesänderung auf null, obwohl der Marktwert berechenbar ist", () => {
    const security = instrument();
    const currentQuote = { ...quote(security, 120), change: null, changePercent: null, previousClose: null };
    const portfolio = buildPortfolio([transaction(security)], { [security.id]: currentQuote }, "EUR", noFx);

    expect(portfolio.positions[0]).toMatchObject({ marketValueBase: 120, dayChange: null, dayChangeBase: null });
    expect(portfolio.summary).toMatchObject({ totalMarketValue: 120, dayChange: null, dayChangePercent: null, complete: true });
  });

  it("behält vollständig verkaufte Positionen auch bei realisiertem Ergebnis von null", () => {
    const security = instrument();
    const portfolio = buildPortfolio([
      transaction(security, { quantity: 2, price: 100 }),
      transaction(security, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 2, price: 100 }),
    ], {}, "EUR", noFx);

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.closedPositions).toHaveLength(1);
    expect(portfolio.closedPositions[0]).toMatchObject({
      quantity: 0,
      costBasis: 0,
      averageCost: null,
      realizedPnl: 0,
      realizedPnlBase: 0,
    });
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 0,
      totalCostBasis: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      complete: true,
      missingPrices: [],
      missingFx: [],
      openPositionCount: 0,
    });
  });

  it("summiert realisierte Ergebnisse offener und geschlossener Positionen zum historischen FX", () => {
    const open = instrument("OFFEN");
    const closed = instrument("GESCHLOSSEN", "USD");
    const rate = fxRate("USD", 0.9);
    const portfolio = buildPortfolio([
      transaction(open, { id: "open-buy", quantity: 2, price: 100, fees: 2 }),
      transaction(open, { id: "open-sell", type: "SELL", date: "2024-05-02", price: 120, fees: 1 }),
      transaction(closed, { id: "closed-buy", quantity: 2, price: 100, fees: 4 }),
      transaction(closed, { id: "closed-sell", type: "SELL", date: "2024-05-02", quantity: 2, price: 120, fees: 2 }),
    ], { [open.id]: quote(open, 130) }, "EUR", () => rate);

    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.closedPositions).toHaveLength(1);
    expect(portfolio.positions[0]!.realizedPnlBase).toBe(18);
    expect(portfolio.closedPositions[0]!.realizedPnlBase).toBeCloseTo(30.6, 12);
    expect(portfolio.summary.realizedPnl).toBeCloseTo(48.6, 12);
    expect(portfolio.summary.totalMarketValue).toBe(130);
    expect(portfolio.summary.totalCostBasis).toBe(101);
    expect(portfolio.summary.unrealizedPnl).toBe(29);
    expect(portfolio.summary.missingPrices).toEqual([]);
    expect(portfolio.summary.fxRates).toEqual([rate]);
    expect(portfolio.summary.complete).toBe(true);
  });

  it("meldet fehlendes FX auch für realisierte Ergebnisse einer geschlossenen Position", () => {
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 1, price: 100 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 1, price: 130 }),
    ], {}, "EUR", noFx);

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.closedPositions[0]).toMatchObject({ realizedPnl: 30, realizedPnlBase: null, fxRate: null });
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 0,
      totalCostBasis: 0,
      realizedPnl: null,
      complete: false,
      missingPrices: [],
      missingFx: ["USD"],
      fxRates: [],
    });
  });

  it("führt den Basis-Einstand je Kaufkurs und trennt Preis- und Währungseffekt nach einem Teilverkauf", () => {
    const dollar = instrument("USD", "USD");
    const fx = vi.fn(datedUsdFx({ "2024-05-01": 0.8, "2024-05-02": 0.9, "2024-05-03": 1 }, 1.1));
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 2, price: 100, fees: 2 }),
      transaction(dollar, { id: "buy-2", date: "2024-05-02", quantity: 3, price: 120, fees: 3 }),
      transaction(dollar, { id: "dividend", type: "DIVIDEND", date: "2024-05-02", quantity: 5, price: 2, fees: 1 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-03", quantity: 2, price: 140, fees: 4 }),
    ], { [dollar.id]: quote(dollar, 150) }, "EUR", fx);
    const [position] = portfolio.positions;

    expect(position).toMatchObject({ quantity: 3, costBasis: 339, realizedPnl: 50, dividends: 9, totalFees: 9 });
    expect(position!.marketValueBase).toBeCloseTo(495, 12);
    expect(position!.costBasisBase).toBeCloseTo(292.98, 12);
    expect(position!.realizedPnlBase).toBeCloseTo(80.68, 12);
    expect(position!.dividendsBase).toBeCloseTo(8.1, 12);
    expect(position!.unrealizedPnlBase).toBeCloseTo(202.02, 12);
    expect(position!.unrealizedFxEffectBase).toBeCloseTo(79.92, 12);
    expect(position!.unrealizedPnlBase).toBeCloseTo(position!.unrealizedPnl! * 1.1 + position!.unrealizedFxEffectBase!, 12);
    expect(portfolio.summary.totalCostBasis).toBeCloseTo(292.98, 12);
    expect(portfolio.summary.unrealizedPnl).toBeCloseTo(202.02, 12);
    expect(portfolio.summary.unrealizedPnlPercent).toBeCloseTo((202.02 / 292.98) * 100, 12);
    expect(portfolio.summary.unrealizedFxEffect).toBeCloseTo(79.92, 12);
    expect(portfolio.summary.realizedPnl).toBeCloseTo(80.68, 12);
    expect(portfolio.summary.dividends).toBeCloseTo(8.1, 12);
    expect(portfolio.summary.complete).toBe(true);
    expect(portfolio.summary.fxRates).toEqual([fxRate("USD", 1.1)]);
    expect(fx).toHaveBeenCalledWith("USD", "EUR", null);
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-05-01");
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-05-02");
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-05-03");
  });

  it("weist einen negativen Währungseffekt auch bei unverändertem Aktienkurs aus", () => {
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([transaction(dollar)], { [dollar.id]: quote(dollar, 100) }, "EUR", datedUsdFx({ "2024-05-01": 0.8 }, 0.7));

    expect(portfolio.positions[0]).toMatchObject({
      unrealizedPnl: 0, marketValueBase: 70, costBasisBase: 80, unrealizedPnlBase: -10, unrealizedFxEffectBase: -10,
    });
    expect(portfolio.summary).toMatchObject({ unrealizedPnl: -10, unrealizedFxEffect: -10, complete: true });
  });

  it("erhält den historischen Basis-Einstand beim Split und berücksichtigt ihn beim anschließenden Verkauf", () => {
    const dollar = instrument("USD", "USD");
    const fx = vi.fn(datedUsdFx({ "2024-05-01": 0.8, "2024-05-03": 0.9 }, 1));
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 2, fees: 2 }),
      transaction(dollar, { id: "split", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 4 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-03", quantity: 3, price: 30, fees: 1 }),
    ], { [dollar.id]: quote(dollar, 30) }, "EUR", fx);
    const [position] = portfolio.positions;

    expect(position).toMatchObject({ quantity: 5, costBasis: 126.25, averageCost: 25.25, realizedPnl: 13.25 });
    expect(position!.costBasisBase).toBeCloseTo(101, 12);
    expect(position!.realizedPnlBase).toBeCloseTo(19.5, 12);
    expect(position!.unrealizedFxEffectBase).toBeCloseTo(25.25, 12);
    expect(position!.unrealizedPnlBase).toBeCloseTo(49, 12);
    expect(portfolio.summary.complete).toBe(true);
    expect(fx).not.toHaveBeenCalledWith("USD", "EUR", "2024-05-02");
  });

  it("berechnet realisierte Ergebnisse mit getrennten Kauf- und Verkaufskursen auch für geschlossene Positionen", () => {
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 2, fees: 4 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-02", quantity: 2, price: 120, fees: 2 }),
      transaction(dollar, { id: "dividend", type: "DIVIDEND", date: "2024-05-03", quantity: 2, price: 5, fees: 1 }),
    ], {}, "EUR", datedUsdFx({ "2024-05-01": 0.8, "2024-05-02": 0.9, "2024-05-03": 0.7 }, 1.1));

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.closedPositions[0]).toMatchObject({
      quantity: 0, costBasisBase: 0, marketValueBase: 0, unrealizedPnlBase: 0, unrealizedFxEffectBase: 0,
      realizedPnl: 34, dividends: 9, totalFees: 6,
    });
    expect(portfolio.closedPositions[0]!.realizedPnlBase).toBeCloseTo(51, 12);
    expect(portfolio.closedPositions[0]!.dividendsBase).toBeCloseTo(6.3, 12);
    expect(portfolio.summary.realizedPnl).toBeCloseTo(51, 12);
    expect(portfolio.summary.dividends).toBeCloseTo(6.3, 12);
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 0, totalCostBasis: 0, unrealizedPnl: 0, unrealizedFxEffect: 0, complete: true, missingPrices: [],
    });
  });

  it.each([
    { type: "BUY", date: "2024-05-01" },
    { type: "DIVIDEND", date: "2024-05-02" },
    { type: "SELL", date: "2024-05-03" },
  ])("setzt bei fehlendem historischen FX für $type alle Basis-Ledgerwerte auf null", ({ date }) => {
    const dollar = instrument("USD", "USD");
    const rates: Record<string, number> = { "2024-05-01": 0.8, "2024-05-02": 0.85, "2024-05-03": 0.9 };
    delete rates[date];
    const fx = vi.fn(datedUsdFx(rates, 0.95));
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 2 }),
      transaction(dollar, { id: "dividend", type: "DIVIDEND", date: "2024-05-02", quantity: 2, price: 2, fees: 0.5 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-03", quantity: 1, price: 120 }),
    ], { [dollar.id]: quote(dollar, 120) }, "EUR", fx);

    expect(portfolio.positions[0]).toMatchObject({
      quantity: 1, costBasis: 100, realizedPnl: 20, dividends: 3.5,
      marketValueBase: 114, costBasisBase: null, realizedPnlBase: null, dividendsBase: null,
      unrealizedPnlBase: null, unrealizedFxEffectBase: null,
    });
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 114, totalCostBasis: null, realizedPnl: null, dividends: null,
      unrealizedPnl: null, unrealizedPnlPercent: null, unrealizedFxEffect: null,
      missingFx: ["USD"], complete: false,
    });
    expect(fx).toHaveBeenCalledWith("USD", "EUR", date);
  });

  it("meldet historische FX-Lücken auch nach vollständiger Auflösung des Bestands", () => {
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([
      transaction(dollar),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-02", price: 120 }),
    ], {}, "EUR", datedUsdFx({ "2024-05-02": 0.9 }, 1));

    expect(portfolio.closedPositions[0]).toMatchObject({
      quantity: 0, marketValueBase: 0, costBasisBase: null, realizedPnlBase: null,
      dividendsBase: null, unrealizedPnlBase: null, unrealizedFxEffectBase: null,
    });
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 0, totalCostBasis: 0, realizedPnl: null, dividends: null, missingFx: ["USD"], complete: false,
    });
  });

  it("erhält historische Basiswerte bei fehlendem aktuellem FX", () => {
    const dollar = instrument("USD", "USD");
    const portfolio = buildPortfolio([
      transaction(dollar, { quantity: 2 }),
      transaction(dollar, { id: "sell", type: "SELL", date: "2024-05-02", price: 120 }),
      transaction(dollar, { id: "dividend", type: "DIVIDEND", date: "2024-05-03", price: 4, fees: 1 }),
    ], { [dollar.id]: quote(dollar, 120) }, "EUR", datedUsdFx({ "2024-05-01": 0.8, "2024-05-02": 0.9, "2024-05-03": 0.7 }, null));

    expect(portfolio.positions[0]).toMatchObject({
      costBasisBase: 80, realizedPnlBase: 28, marketValueBase: null, fxRate: null,
      unrealizedPnlBase: null, unrealizedFxEffectBase: null,
    });
    expect(portfolio.positions[0]!.dividendsBase).toBeCloseTo(2.1, 12);
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: null, totalCostBasis: 80, realizedPnl: 28, missingFx: ["USD"], complete: false,
    });
    expect(portfolio.summary.dividends).toBeCloseTo(2.1, 12);
  });

  it("summiert bekannte Dividenden aller Positionen und FX-Effekte offener Positionen trotz historischer Lücken", () => {
    const open = instrument("OFFEN");
    const closed = instrument("GESCHLOSSEN");
    const missing = instrument("OHNE-FX", "USD");
    const portfolio = buildPortfolio([
      transaction(open, { id: "open-buy" }),
      transaction(open, { id: "open-dividend", type: "DIVIDEND", date: "2024-05-02", price: 4, fees: 1 }),
      transaction(closed, { id: "closed-buy" }),
      transaction(closed, { id: "closed-sell", type: "SELL", date: "2024-05-02", price: 110 }),
      transaction(closed, { id: "closed-dividend", type: "DIVIDEND", date: "2024-05-03", price: 6, fees: 1 }),
      transaction(missing, { id: "missing-buy" }),
      transaction(missing, { id: "missing-dividend", type: "DIVIDEND", date: "2024-05-02", price: 2 }),
    ], { [open.id]: quote(open, 120), [missing.id]: quote(missing, 500) }, "EUR", datedUsdFx({ "2024-05-02": 0.9 }, 1));

    expect(portfolio.positions.find((position) => position.instrumentId === missing.id)).toMatchObject({
      marketValueBase: 500, dividendsBase: null, unrealizedPnlBase: null, unrealizedFxEffectBase: null,
    });
    expect(portfolio.summary).toMatchObject({
      totalMarketValue: 620, totalCostBasis: 100, unrealizedPnl: 20, unrealizedPnlPercent: 20,
      unrealizedFxEffect: 0, realizedPnl: 10, dividends: 8, missingFx: ["USD"], complete: false,
    });
  });

  it("sortiert nach Basis-Marktwert statt Handelswährungswert und setzt nicht bewertbare Positionen zuletzt", () => {
    const euro = instrument("EUR");
    const dollar = instrument("USD", "USD");
    const swiss = instrument("CHF", "CHF");
    const unpriced = instrument("OHNE-KURS");
    const rate = fxRate("USD", 0.5);
    const portfolio = buildPortfolio([
      transaction(swiss, { id: "chf" }),
      transaction(unpriced, { id: "missing" }),
      transaction(euro, { id: "eur" }),
      transaction(dollar, { id: "usd" }),
    ], { [euro.id]: quote(euro, 200), [dollar.id]: quote(dollar, 500), [swiss.id]: quote(swiss, 1000) }, "EUR", (from) => from === "USD" ? rate : null);

    expect(portfolio.positions.slice(0, 2).map((position) => position.instrumentId)).toEqual([dollar.id, euro.id]);
    expect(portfolio.positions.slice(2).map((position) => position.instrumentId)).toEqual(expect.arrayContaining([swiss.id, unpriced.id]));
    expect(portfolio.positions.slice(2).every((position) => position.marketValueBase === null && position.weightPercent === null)).toBe(true);
    expect(portfolio.positions[0]!.weightPercent).toBeCloseTo((250 / 450) * 100, 12);
    expect(portfolio.positions[1]!.weightPercent).toBeCloseTo((200 / 450) * 100, 12);
    expect(portfolio.summary.totalMarketValue).toBe(450);
    expect(portfolio.summary.totalCostBasis).toBe(250);
    expect(portfolio.summary.complete).toBe(false);
  });

  it("verändert Transaktionen, Kurse und übergebene Wechselkursobjekte nicht", () => {
    const security = instrument("USD", "USD");
    const transactions = [
      transaction(security, { id: "later", date: "2024-05-02", price: 110 }),
      transaction(security, { id: "earlier", price: 100 }),
    ];
    const currentQuote = quote(security, 120, 5);
    const quotes = { [security.id]: currentQuote };
    const rate = fxRate("USD", 0.9);
    const snapshot = structuredClone({ transactions, quotes, rate });
    Object.freeze(security);
    transactions.forEach(Object.freeze);
    Object.freeze(transactions);
    Object.freeze(currentQuote);
    Object.freeze(quotes);
    Object.freeze(rate);

    buildPortfolio(transactions, quotes, "EUR", () => rate);

    expect({ transactions, quotes, rate }).toEqual(snapshot);
  });
});
