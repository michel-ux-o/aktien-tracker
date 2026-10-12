import { describe, expect, it, vi } from "vitest";
import type { DataMeta, FxRate, HistoryRange, Instrument, Transaction } from "../types";
import { computePortfolioHistory, rangeStartDate } from "./history";
import type { FxLookup } from "./index";

const eurInstrument: Instrument = {
  id: "EUR:XETR", symbol: "EUR", name: "Euro-Aktie", exchange: "XETRA", mic: "XETR",
  currency: "EUR", country: "DE", type: "Common Stock",
};
const usdInstrument: Instrument = {
  ...eurInstrument, id: "USD:XNAS", symbol: "USD", name: "US-Aktie", exchange: "NASDAQ",
  mic: "XNAS", currency: "USD", country: "US",
};
const meta: DataMeta = {
  source: "Testdaten", mode: "demo", fetchedAt: "2024-01-10T12:00:00.000Z",
  delayMinutes: null, delayNote: null,
};
const usdRate: FxRate = {
  from: "USD", to: "EUR", rate: 0.5, asOf: "2024-01-10T12:00:00.000Z", source: "Testdaten",
};

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  const instrument = overrides.instrument ?? eurInstrument;
  return {
    id: "buy", instrumentId: instrument.id, instrument, currency: instrument.currency,
    type: "BUY", date: "2024-01-01", quantity: 1, price: 10, fees: 0, ratio: null, note: null,
    createdAt: "2024-01-01T12:00:00.000Z", updatedAt: "2024-01-01T12:00:00.000Z",
    ...overrides,
  };
}

function compute(overrides: Partial<Parameters<typeof computePortfolioHistory>[0]> = {}) {
  return computePortfolioHistory({
    transactions: [transaction()], histories: {}, baseCurrency: "EUR", fx: () => null,
    range: "MAX", today: "2024-01-10", meta, ...overrides,
  });
}

describe("rangeStartDate", () => {
  it.each<[HistoryRange, string, string | null]>([
    ["1W", "2024-01-04", "2023-12-28"],
    ["1W", "2024-04-01", "2024-03-25"],
    ["1M", "2024-03-31", "2024-02-29"],
    ["1M", "2023-03-31", "2023-02-28"],
    ["3M", "2024-05-31", "2024-02-29"],
    ["6M", "2024-08-31", "2024-02-29"],
    ["1Y", "2024-02-29", "2023-02-28"],
    ["5Y", "2024-02-29", "2019-02-28"],
    ["MAX", "2024-01-10", null],
  ])("%s relativ zu %s ergibt %s", (range, today, expected) => {
    expect(rangeStartDate(range, today)).toBe(expected);
  });
});

describe("computePortfolioHistory", () => {
  it("liefert ohne Transaktionen keine Punkte oder Einschränkungen", () => {
    const fx = vi.fn(() => null);
    expect(compute({ transactions: [], histories: { other: [{ date: "2024-01-01", close: 50 }] }, fx }))
      .toEqual({ range: "MAX", baseCurrency: "EUR", points: [], complete: true, notes: [], meta });
    expect(fx).not.toHaveBeenCalled();
  });

  it("vereinigt alle Kurstage im Zeitraum, begrenzt auf Transaktionsbeginn und heute", () => {
    const transactions = [transaction({ date: "2024-01-02", quantity: 2 })];
    const histories = {
      [eurInstrument.id]: [
        { date: "2024-01-01", close: 9 }, { date: "2024-01-03", close: 11 },
        { date: "2024-01-05", close: 12 },
      ],
      other: [
        { date: "2024-01-02", close: 100 }, { date: "2024-01-04", close: 100 },
        { date: "2024-01-11", close: 100 },
      ],
    };
    const originalTransactions = structuredClone(transactions);
    const originalHistories = structuredClone(histories);
    const result = compute({ transactions, histories, range: "1W" });
    expect(result.points).toEqual([
      { date: "2024-01-03", marketValue: 22, investedCapital: 20 },
      { date: "2024-01-04", marketValue: 22, investedCapital: 20 },
      { date: "2024-01-05", marketValue: 24, investedCapital: 20 },
    ]);
    expect(result.complete).toBe(true);
    expect(transactions).toEqual(originalTransactions);
    expect(histories).toEqual(originalHistories);
  });

  it("wendet Käufe, Gebühren sowie Teil- und Komplettverkäufe bis zum jeweiligen Tag an", () => {
    const result = compute({
      transactions: [
        transaction({ id: "close", type: "SELL", date: "2024-01-06", quantity: 2, price: 15, fees: 1 }),
        transaction({ id: "second", date: "2024-01-04", quantity: 1, price: 20, fees: 1 }),
        transaction({ id: "first", date: "2024-01-02", quantity: 2, price: 10, fees: 2 }),
        transaction({ id: "partial", type: "SELL", date: "2024-01-05", quantity: 1, price: 30, fees: 3 }),
      ],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-02", close: 10 }, { date: "2024-01-03", close: 15 },
        { date: "2024-01-04", close: 20 }, { date: "2024-01-05", close: 25 },
        { date: "2024-01-06", close: 100 },
      ] },
    });
    expect(result.points.map((point) => point.marketValue)).toEqual([20, 30, 60, 50, 0]);
    expect(result.points.slice(0, 3).map((point) => point.investedCapital)).toEqual([22, 22, 43]);
    expect(result.points[3]!.investedCapital).toBeCloseTo(86 / 3, 12);
    expect(result.points[4]!.investedCapital).toBe(0);
    expect(result.complete).toBe(true);
  });

  it("verarbeitet am gleichen Tag Käufe vor Verkäufen", () => {
    const result = compute({
      transactions: [
        transaction({ id: "sell", type: "SELL", date: "2024-01-02", quantity: 1, price: 15 }),
        transaction({ id: "buy", date: "2024-01-02", quantity: 2, price: 10 }),
      ],
      histories: { [eurInstrument.id]: [{ date: "2024-01-02", close: 11 }] },
    });
    expect(result.points).toEqual([{ date: "2024-01-02", marketValue: 11, investedCapital: 10 }]);
  });

  it("überbrückt Kurslücken mit dem letzten bekannten Schlusskurs, auch vor dem Zeitraum", () => {
    const result = compute({
      range: "1W",
      histories: {
        [eurInstrument.id]: [{ date: "2024-01-02", close: 11 }, { date: "2024-01-09", close: 14 }],
        other: [{ date: "2024-01-05", close: 50 }],
      },
    });
    expect(result.points).toEqual([
      { date: "2024-01-05", marketValue: 11, investedCapital: 10 },
      { date: "2024-01-09", marketValue: 14, investedCapital: 10 },
    ]);
    expect(result.complete).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("erfindet vor dem ersten Schlusskurs keinen Marktwert und dedupliziert den Hinweis", () => {
    const result = compute({
      transactions: [transaction({ quantity: 2 })],
      histories: {
        [eurInstrument.id]: [{ date: "2024-01-03", close: 15 }],
        other: [
          { date: "2024-01-01", close: 1 }, { date: "2024-01-02", close: 1 },
          { date: "2024-01-04", close: 1 },
        ],
      },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: null, investedCapital: 20 },
      { date: "2024-01-02", marketValue: null, investedCapital: 20 },
      { date: "2024-01-03", marketValue: 30, investedCapital: 20 },
      { date: "2024-01-04", marketValue: 30, investedCapital: 20 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("vor dem ersten verfügbaren Schlusskurs");
  });

  it("liefert null statt einer Teilsumme, wenn historische Kurse einer offenen Position fehlen", () => {
    const result = compute({
      transactions: [transaction({ quantity: 2 }), transaction({ id: "usd", instrument: usdInstrument })],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-01", close: 20 }, { date: "2024-01-02", close: 30 },
      ] },
      fx: () => usdRate,
    });
    expect(result.points.map((point) => point.marketValue)).toEqual([null, null]);
    expect(result.points.map((point) => point.investedCapital)).toEqual([25, 25]);
    expect(result.complete).toBe(false);
    expect(result.notes).toEqual(["Für USD liegen keine historischen Kurse vor."]);
  });

  it("summiert bei fehlendem FX nur bewertbaren Einstand und setzt den Marktwert auf null", () => {
    const result = compute({
      transactions: [transaction({ quantity: 2 }), transaction({ id: "usd", instrument: usdInstrument, price: 100 })],
      histories: {
        [eurInstrument.id]: [{ date: "2024-01-01", close: 11 }, { date: "2024-01-02", close: 12 }],
        [usdInstrument.id]: [{ date: "2024-01-01", close: 110 }],
      },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: null, investedCapital: 20 },
      { date: "2024-01-02", marketValue: null, investedCapital: 20 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("Für USD fehlt der Wechselkurs nach EUR");
  });

  it("bewertet mit dem FX des jeweiligen Tages und behält den historischen Kauf-Einstand", () => {
    const fx = vi.fn<FxLookup>((from, to, date) =>
      from === "USD" && to === "EUR" && date !== null
        ? { ...usdRate, rate: date === "2024-01-01" ? 0.5 : 0.75, asOf: date }
        : null);
    const result = compute({
      transactions: [
        transaction(), transaction({ id: "usd", instrument: usdInstrument, quantity: 2, price: 100, fees: 2 }),
      ],
      histories: {
        [eurInstrument.id]: [{ date: "2024-01-01", close: 11 }, { date: "2024-01-02", close: 12 }],
        [usdInstrument.id]: [{ date: "2024-01-01", close: 110 }, { date: "2024-01-02", close: 120 }],
      },
      fx,
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 121, investedCapital: 111 },
      { date: "2024-01-02", marketValue: 192, investedCapital: 111 },
    ]);
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-01-01");
    expect(fx).toHaveBeenCalledWith("USD", "EUR", "2024-01-02");
    expect(fx.mock.calls.every(([, , date]) => date !== null)).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("führt den historischen Basis-Einstand bei mehreren Käufen und einem Teilverkauf fort", () => {
    const rates: Record<string, number> = {
      "2024-01-01": 0.5, "2024-01-02": 0.75, "2024-01-03": 0.9, "2024-01-04": 1,
    };
    const fx = vi.fn<FxLookup>((from, to, date) => date !== null && rates[date] !== undefined
      ? { ...usdRate, from, to, rate: rates[date]!, asOf: date }
      : null);
    const result = compute({
      transactions: [
        transaction({ instrument: usdInstrument, quantity: 2, price: 100, fees: 2 }),
        transaction({ id: "second", instrument: usdInstrument, date: "2024-01-02", quantity: 2, price: 120, fees: 4 }),
        transaction({ id: "sell", instrument: usdInstrument, type: "SELL", date: "2024-01-03", quantity: 1, price: 150, fees: 3 }),
      ],
      histories: { [usdInstrument.id]: [
        { date: "2024-01-01", close: 110 }, { date: "2024-01-02", close: 120 },
        { date: "2024-01-03", close: 130 }, { date: "2024-01-04", close: 140 },
      ] },
      fx,
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 110, investedCapital: 101 },
      { date: "2024-01-02", marketValue: 360, investedCapital: 284 },
      { date: "2024-01-03", marketValue: 351, investedCapital: 213 },
      { date: "2024-01-04", marketValue: 420, investedCapital: 213 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("verändert bei Dividenden weder Stückzahl noch investiertes Kapital", () => {
    const result = compute({
      transactions: [
        transaction({ quantity: 2, fees: 2 }),
        transaction({ id: "dividend", type: "DIVIDEND", date: "2024-01-02", quantity: 20, price: 3, fees: 4 }),
      ],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-01", close: 11 }, { date: "2024-01-02", close: 12 },
      ] },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 22, investedCapital: 22 },
      { date: "2024-01-02", marketValue: 24, investedCapital: 22 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("bewertet vor und nach einem Split auf split-bereinigter Stückbasis und bucht Verkäufe anteilig aus", () => {
    const result = compute({
      transactions: [
        transaction({ quantity: 3, price: 120, fees: 6 }),
        transaction({ id: "split", type: "SPLIT", date: "2024-01-03", quantity: 0, price: 0, ratio: 4 }),
        transaction({ id: "sell", type: "SELL", date: "2024-01-04", quantity: 6, price: 33 }),
      ],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-01", close: 30 }, { date: "2024-01-02", close: 31 },
        { date: "2024-01-03", close: 32 }, { date: "2024-01-04", close: 33 },
      ] },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 360, investedCapital: 366 },
      { date: "2024-01-02", marketValue: 372, investedCapital: 366 },
      { date: "2024-01-03", marketValue: 384, investedCapital: 366 },
      { date: "2024-01-04", marketValue: 198, investedCapital: 183 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("berücksichtigt Zusammenlegungen vor und nach deren Tag sowie einen anschließenden Verkauf", () => {
    const result = compute({
      transactions: [
        transaction({ quantity: 20 }),
        transaction({ id: "split", type: "SPLIT", date: "2024-01-03", quantity: 0, price: 0, ratio: 0.1 }),
        transaction({ id: "sell", type: "SELL", date: "2024-01-04", quantity: 1, price: 120 }),
      ],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-01", close: 100 }, { date: "2024-01-03", close: 110 },
        { date: "2024-01-04", close: 120 },
      ] },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 200, investedCapital: 200 },
      { date: "2024-01-03", marketValue: 220, investedCapital: 200 },
      { date: "2024-01-04", marketValue: 120, investedCapital: 100 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("multipliziert spätere Split-Verhältnisse auch außerhalb des sichtbaren Zeitraums", () => {
    const transactions = [
      transaction({ quantity: 10, price: 20 }),
      transaction({ id: "split", type: "SPLIT", date: "2024-01-04", quantity: 0, price: 0, ratio: 4 }),
      transaction({ id: "consolidation", type: "SPLIT", date: "2024-01-12", quantity: 0, price: 0, ratio: 0.5 }),
    ];
    const histories = { [eurInstrument.id]: [
      { date: "2024-01-03", close: 10 }, { date: "2024-01-04", close: 11 },
      { date: "2024-01-10", close: 12 },
    ] };
    const originals = structuredClone({ transactions, histories });
    const result = compute({ transactions, histories, range: "1W" });
    expect(result.points).toEqual([
      { date: "2024-01-03", marketValue: 200, investedCapital: 200 },
      { date: "2024-01-04", marketValue: 220, investedCapital: 200 },
      { date: "2024-01-10", marketValue: 240, investedCapital: 200 },
    ]);
    expect({ transactions, histories }).toEqual(originals);
  });

  it("verarbeitet am selben Tag Split, Kauf, Dividende und Verkauf trotz umgekehrter Zeitpunkte", () => {
    const result = compute({
      transactions: [
        transaction({ quantity: 4, price: 20 }),
        transaction({ id: "sell", type: "SELL", date: "2024-01-02", quantity: 5, price: 15, createdAt: "2024-01-02T08:00:00.000Z" }),
        transaction({ id: "dividend", type: "DIVIDEND", date: "2024-01-02", quantity: 10, price: 1, fees: 1, createdAt: "2024-01-02T09:00:00.000Z" }),
        transaction({ id: "buy", date: "2024-01-02", quantity: 2, price: 15, createdAt: "2024-01-02T10:00:00.000Z" }),
        transaction({ id: "split", type: "SPLIT", date: "2024-01-02", quantity: 0, price: 0, ratio: 2, createdAt: "2024-01-02T11:00:00.000Z" }),
      ],
      histories: { [eurInstrument.id]: [
        { date: "2024-01-01", close: 10 }, { date: "2024-01-02", close: 15 },
      ] },
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 80, investedCapital: 80 },
      { date: "2024-01-02", marketValue: 75, investedCapital: 55 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("erfindet bei fehlendem Tages-FX keinen Marktwert, behält aber den bekannten Kauf-Einstand", () => {
    const fx = vi.fn<FxLookup>((from, to, date) => date === "2024-01-01"
      ? { ...usdRate, from, to, asOf: date }
      : null);
    const result = compute({
      transactions: [transaction({ instrument: usdInstrument, quantity: 2, price: 100 })],
      histories: { [usdInstrument.id]: [
        { date: "2024-01-01", close: 110 }, { date: "2024-01-02", close: 120 },
        { date: "2024-01-03", close: 130 },
      ] },
      fx,
    });
    expect(result.points).toEqual([
      { date: "2024-01-01", marketValue: 110, investedCapital: 100 },
      { date: "2024-01-02", marketValue: null, investedCapital: 100 },
      { date: "2024-01-03", marketValue: null, investedCapital: 100 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(fx.mock.calls.every(([, , date]) => date !== null)).toBe(true);
  });

  it.each(["BUY", "SELL", "DIVIDEND"] as const)(
    "kennzeichnet fehlendes Transaktions-FX für %s trotz vorhandenem Bewertungs-FX",
    (type) => {
      const transactions = [transaction({ instrument: usdInstrument, quantity: 2, price: 100 })];
      if (type !== "BUY") {
        transactions.push(transaction({ id: type, instrument: usdInstrument, type, date: "2024-01-02", quantity: 1, price: 10 }));
      }
      const missingDate = type === "BUY" ? "2024-01-01" : "2024-01-02";
      const fx = vi.fn<FxLookup>((from, to, date) => date === null || date === missingDate
        ? null
        : { ...usdRate, from, to, asOf: date });
      const result = compute({
        transactions,
        histories: { [usdInstrument.id]: [
          { date: "2024-01-03", close: 110 }, { date: "2024-01-04", close: 120 },
        ] },
        fx,
      });
      expect(result.points).toEqual([
        { date: "2024-01-03", marketValue: null, investedCapital: 0 },
        { date: "2024-01-04", marketValue: null, investedCapital: 0 },
      ]);
      expect(result.complete).toBe(false);
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toContain("Für USD fehlt der Wechselkurs nach EUR");
    },
  );

  it("ignoriert fehlende Kurse und FX vollständig vor dem Zeitraum geschlossener Positionen", () => {
    const fx = vi.fn(() => null);
    const result = compute({
      range: "1W",
      transactions: [
        transaction({ id: "buy", instrument: usdInstrument }),
        transaction({ id: "sell", instrument: usdInstrument, type: "SELL", date: "2024-01-02", price: 20 }),
      ],
      histories: { other: [{ date: "2024-01-04", close: 50 }, { date: "2024-01-06", close: 50 }] },
      fx,
    });
    expect(result.points).toEqual([
      { date: "2024-01-04", marketValue: 0, investedCapital: 0 },
      { date: "2024-01-06", marketValue: 0, investedCapital: 0 },
    ]);
    expect(result.complete).toBe(true);
    expect(result.notes).toEqual([]);
    expect(fx).not.toHaveBeenCalled();
  });

  it("meldet vollständig fehlende Historien, ohne Handelstage zu erfinden", () => {
    const result = compute();
    expect(result.points).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.notes).toEqual(["Für EUR liegen keine historischen Kurse vor."]);
  });

  it("meldet fehlende Historien auch für im sichtbaren Zeitraum geschlossene Positionen", () => {
    const result = compute({ transactions: [
      transaction(), transaction({ id: "sell", type: "SELL", date: "2024-01-02", price: 20 }),
    ] });
    expect(result.points).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.notes).toEqual(["Für EUR liegen keine historischen Kurse vor."]);
  });

  it("meldet bei leerer Datumsachse keine Einschränkung für vorher geschlossene Positionen", () => {
    const fx = vi.fn(() => null);
    const result = compute({
      range: "1W", fx,
      transactions: [
        transaction({ instrument: usdInstrument }),
        transaction({ id: "sell", instrument: usdInstrument, type: "SELL", date: "2024-01-02", price: 20 }),
      ],
    });
    expect(result.points).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.notes).toEqual([]);
    expect(fx).not.toHaveBeenCalled();
  });
});
