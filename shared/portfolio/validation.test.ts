import { describe, expect, it } from "vitest";
import type { Instrument, Transaction } from "../types";
import { compareTransactions } from "./common";
import { computeHoldings } from "./holdings";
import type { SequenceItem } from "./index";
import { validateTransactionInput, validateTransactionSequence } from "./validation";

const instrument: Instrument = {
  id: "SAP:XETR",
  symbol: "SAP",
  name: "SAP SE",
  exchange: "XETRA",
  mic: "XETR",
  currency: "EUR",
  country: "Deutschland",
  type: "Common Stock",
};
const today = "2024-05-10";

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument: { ...instrument },
    type: "BUY",
    date: "2024-05-03",
    quantity: 2.5,
    price: 100,
    fees: 1,
    currency: "EUR",
    ratio: null,
    ...overrides,
  };
}

function fieldError(value: unknown, field: string): string | undefined {
  const result = validateTransactionInput(value, today);
  expect(result.ok).toBe(false);
  return result.ok ? undefined : result.fields[field];
}

function transaction(
  id: string,
  type: SequenceItem["type"],
  date: string,
  quantity: number,
  createdAt = "2024-05-01T12:00:00.000Z",
  ratio: number | null = null,
): SequenceItem {
  return { id, type, date, quantity, createdAt, ratio };
}

function fullTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "buy",
    type: "BUY",
    date: "2024-05-01",
    quantity: 2,
    price: 100,
    fees: 0,
    currency: "EUR",
    instrumentId: instrument.id,
    instrument,
    ratio: null,
    note: null,
    createdAt: "2024-05-01T12:00:00.000Z",
    updatedAt: "2024-05-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("validateTransactionInput", () => {
  it("normalisiert fehlende Gebühren und leere Notizen, ohne die Eingabe zu ändern", () => {
    const value = input({ fees: undefined, note: "   ", clientRequestId: "request-1" });
    const before = structuredClone(value);
    const result = validateTransactionInput(value, today);

    expect(result).toEqual({
      ok: true,
      value: {
        ...value,
        fees: 0,
        note: null,
      },
    });
    expect(value).toEqual(before);
  });

  it("akzeptiert nullable Wertpapierfelder, null als Notiz und acht Nachkommastellen", () => {
    const value = input({
      instrument: { ...instrument, country: null, type: null },
      type: "SELL",
      date: today,
      quantity: 1.12345678,
      note: null,
    });
    expect(validateTransactionInput(value, today)).toEqual({ ok: true, value });
  });

  it("entfernt Leerzeichen um Wertpapierangaben und Notizen", () => {
    const result = validateTransactionInput(
      input({ instrument: { ...instrument, name: " SAP SE " }, note: " Meine Notiz " }),
      today,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.instrument.name).toBe("SAP SE");
      expect(result.value.note).toBe("Meine Notiz");
    }
  });

  it.each([null, undefined, [], "BUY", 42])("weist ungültige Eingabeobjekte zurück: %s", (value) => {
    expect(fieldError(value, "instrument")).toBeDefined();
  });

  it.each(["id", "symbol", "name", "exchange", "mic", "currency"] as const)(
    "verlangt die nicht leere Wertpapierangabe %s",
    (field) => {
      for (const value of [undefined, null, "", "   ", 1]) {
        expect(fieldError(input({ instrument: { ...instrument, [field]: value } }), "instrument")).toBeDefined();
      }
    },
  );

  it.each(["country", "type"] as const)("verlangt string oder null für instrument.%s", (field) => {
    for (const value of [undefined, 1, false, []]) {
      expect(fieldError(input({ instrument: { ...instrument, [field]: value } }), "instrument")).toBeDefined();
    }
  });

  it.each([0, -1, -0.1])("weist nicht positive Stückzahlen zurück: %s", (quantity) => {
    expect(fieldError(input({ quantity }), "quantity")).toBe("Die Stückzahl muss größer als 0 sein.");
  });

  it.each([NaN, Infinity, -Infinity, "2", null, undefined])("verlangt eine endliche Stückzahl: %s", (quantity) => {
    expect(fieldError(input({ quantity }), "quantity")).toBe("Die Stückzahl muss eine endliche Zahl sein.");
  });

  it.each([1.123456789, 1e-9, 1.234e-7])("weist mehr als acht Nachkommastellen zurück: %s", (quantity) => {
    expect(fieldError(input({ quantity }), "quantity")).toBe("Die Stückzahl darf höchstens 8 Nachkommastellen haben.");
  });

  it.each([1e-8, 1.2e-7, 12345678, 1000000000000000000000])(
    "akzeptiert bis zu acht Nachkommastellen auch bei Exponentialnotation: %s",
    (quantity) => {
      expect(validateTransactionInput(input({ quantity }), today).ok).toBe(true);
    },
  );

  it.each(["2024-02-30", "2023-02-29", "2024-13-01", "2024-00-03", "2024-5-3", "2024-05-03T00:00:00Z", "", null])(
    "weist ungültige Kalendertage zurück: %s",
    (date) => {
      expect(fieldError(input({ date }), "date")).toBe("Bitte geben Sie ein gültiges Datum im Format JJJJ-MM-TT an.");
    },
  );

  it("akzeptiert den Schalttag und die Untergrenze 1900", () => {
    expect(validateTransactionInput(input({ date: "2024-02-29" }), today).ok).toBe(true);
    expect(validateTransactionInput(input({ date: "1900-01-01" }), today).ok).toBe(true);
  });

  it("weist Zukunftstage und Daten vor 1900 zurück", () => {
    expect(fieldError(input({ date: "2024-05-11" }), "date")).toBe("Das Datum darf nicht in der Zukunft liegen.");
    expect(fieldError(input({ date: "1899-12-31" }), "date")).toBe("Das Datum darf nicht vor dem 01.01.1900 liegen.");
  });

  it.each(["buy", "HOLD", "", null, undefined])("erlaubt nur BUY, SELL, DIVIDEND und SPLIT: %s", (type) => {
    expect(fieldError(input({ type }), "type")).toBe("Die Transaktionsart muss Kauf, Verkauf, Dividende oder Split sein.");
  });

  it.each([0, -1, NaN, Infinity, "100", null])("weist ungültige Preise zurück: %s", (price) => {
    expect(fieldError(input({ price }), "price")).toBeDefined();
  });

  it.each([-1, NaN, Infinity, "1", null])("weist ungültige Gebühren zurück: %s", (fees) => {
    expect(fieldError(input({ fees }), "fees")).toBeDefined();
  });

  it.each(["eur", "EURO", "EU", " EUR", "12A", null])("verlangt drei Großbuchstaben als Währung: %s", (currency) => {
    expect(fieldError(input({ currency }), "currency")).toBe("Die Handelswährung muss aus drei Großbuchstaben bestehen.");
  });

  it("weist eine vom Wertpapier abweichende Handelswährung zurück", () => {
    expect(fieldError(input({ currency: "USD" }), "currency")).toBe(
      "Handelswährung muss der Währung des Wertpapiers entsprechen",
    );
  });

  it("beachtet die Grenzen von Notiz und Anfragekennung", () => {
    expect(validateTransactionInput(input({ note: "a".repeat(500), clientRequestId: "r".repeat(100) }), today).ok).toBe(true);
    expect(fieldError(input({ note: "a".repeat(501) }), "note")).toBeDefined();
    expect(fieldError(input({ note: 1 }), "note")).toBeDefined();
    expect(fieldError(input({ clientRequestId: "r".repeat(101) }), "clientRequestId")).toBeDefined();
    expect(fieldError(input({ clientRequestId: null }), "clientRequestId")).toBeDefined();
  });

  it("gibt alle Feldfehler in einer Prüfung zurück", () => {
    const result = validateTransactionInput(input({ quantity: 0, price: -1, fees: -1 }), today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fields).sort()).toEqual(["fees", "price", "quantity"]);
  });

  it("ignoriert zusätzliche Request-Felder im normalisierten Vertrag", () => {
    const result = validateTransactionInput(input({ unexpected: true }), today);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty("unexpected");
  });

  it.each(["BUY", "SELL", "DIVIDEND"])("normalisiert fehlendes Verhältnis bei %s auf null", (type) => {
    const result = validateTransactionInput(input({ type, ratio: undefined }), today);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ratio).toBeNull();
  });

  it.each(["BUY", "SELL", "DIVIDEND"])("erlaubt ein Verhältnis ausschließlich beim Split, nicht bei %s", (type) => {
    for (const ratio of [2, 1, 0, "2", NaN]) {
      expect(fieldError(input({ type, ratio }), "ratio")).toBe("Ein Split-Verhältnis ist nur bei einem Split erlaubt.");
    }
  });

  it("normalisiert beim Split auch ungültige eingegebene Stückzahlen, Preise und Gebühren auf 0", () => {
    const value = input({ type: "SPLIT", ratio: 4, quantity: "beliebig", price: NaN, fees: Infinity });
    const before = structuredClone(value);
    expect(validateTransactionInput(value, today)).toEqual({
      ok: true,
      value: { ...value, quantity: 0, price: 0, fees: 0, note: null },
    });
    expect(value).toEqual(before);
    expect(validateTransactionInput(input({ type: "SPLIT", ratio: 0.1, quantity: undefined, price: undefined, fees: undefined }), today).ok).toBe(true);
  });

  it.each([undefined, null, "4", NaN, Infinity, -Infinity])("verlangt ein endliches Pflichtverhältnis beim Split: %s", (ratio) => {
    expect(fieldError(input({ type: "SPLIT", ratio }), "ratio")).toBe("Das Split-Verhältnis muss eine endliche Zahl sein.");
  });

  it.each([0, -1, -0.1])("verlangt ein positives Split-Verhältnis: %s", (ratio) => {
    expect(fieldError(input({ type: "SPLIT", ratio }), "ratio")).toBe("Das Split-Verhältnis muss größer als 0 sein.");
  });

  it("weist ein unverändertes Verhältnis von 1 zurück", () => {
    expect(fieldError(input({ type: "SPLIT", ratio: 1 }), "ratio")).toBe("Das Split-Verhältnis darf nicht 1 sein.");
  });

  it.each([0.00009999, 10000.00000001, 1e-8, 10001])("weist Verhältnisse außerhalb von 0,0001 bis 10.000 zurück: %s", (ratio) => {
    expect(fieldError(input({ type: "SPLIT", ratio }), "ratio")).toBe("Das Split-Verhältnis muss zwischen 0,0001 und 10.000 liegen.");
  });

  it.each([0.0001, 10000, 0.1, 4, 1.12345678, 0.00012345])("akzeptiert die Verhältnisgrenzen und bis zu acht Nachkommastellen: %s", (ratio) => {
    expect(validateTransactionInput(input({ type: "SPLIT", ratio }), today).ok).toBe(true);
  });

  it.each([1.123456789, 0.000123456, 1.234567891e-4])("weist mehr als acht Verhältnis-Nachkommastellen zurück: %s", (ratio) => {
    expect(fieldError(input({ type: "SPLIT", ratio }), "ratio")).toBe("Das Split-Verhältnis darf höchstens 8 Nachkommastellen haben.");
  });

  it("wendet Datum, Währung und Notizregeln auch auf Splits an", () => {
    const result = validateTransactionInput(input({ type: "SPLIT", ratio: 2, date: "2024-05-11", currency: "USD", note: "x".repeat(501) }), today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fields).sort()).toEqual(["currency", "date", "note"]);
  });

  it("akzeptiert Dividenden mit acht Stückzahl-Nachkommastellen und Abzügen bis zur Brutto-Dividende", () => {
    expect(validateTransactionInput(input({ type: "DIVIDEND", quantity: 1.12345678, price: 3, fees: 0 }), today).ok).toBe(true);
    const value = input({ type: "DIVIDEND", quantity: 2, price: 3, fees: 6, note: null });
    expect(validateTransactionInput(value, today)).toEqual({ ok: true, value });
  });

  it("weist Dividendenabzüge über der Brutto-Dividende zurück", () => {
    expect(fieldError(input({ type: "DIVIDEND", quantity: 2, price: 3, fees: 6.01 }), "fees")).toBe("Die Abzüge dürfen die Brutto-Dividende nicht übersteigen.");
    expect(validateTransactionInput(input({ type: "BUY", quantity: 2, price: 3, fees: 6.01 }), today).ok).toBe(true);
    expect(validateTransactionInput(input({ type: "SELL", quantity: 2, price: 3, fees: 6.01 }), today).ok).toBe(true);
  });

  it("wendet Stückzahl-, Preis- und Gebührenregeln auch auf Dividenden an", () => {
    for (const quantity of [0, -1, NaN, Infinity, "2", 1.123456789, 1e-9]) {
      expect(fieldError(input({ type: "DIVIDEND", quantity }), "quantity")).toBeDefined();
    }
    for (const price of [0, -1, NaN, Infinity, "2"]) {
      expect(fieldError(input({ type: "DIVIDEND", price }), "price")).toBeDefined();
    }
    for (const fees of [-1, NaN, Infinity, "2"]) {
      expect(fieldError(input({ type: "DIVIDEND", fees }), "fees")).toBeDefined();
    }
    const result = validateTransactionInput(input({ type: "DIVIDEND", fees: undefined }), today);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fees).toBe(0);
  });
});

describe("validateTransactionSequence", () => {
  it("akzeptiert eine leere Folge sowie Teil- und Komplettverkäufe", () => {
    expect(validateTransactionSequence([])).toEqual({ ok: true });
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2.5),
      transaction("partial", "SELL", "2024-05-02", 1),
      transaction("remaining", "SELL", "2024-05-03", 1.5),
    ])).toEqual({ ok: true });
  });

  it("meldet Überverkäufe mit deutschem Datum und Bruchstückbestand", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2.5),
      transaction("sell", "SELL", "2024-05-03", 3),
    ])).toEqual({
      ok: false,
      transactionId: "sell",
      message: "Verkauf am 03.05.2024 übersteigt den Bestand (verfügbar: 2,5 Stück).",
    });
  });

  it("prüft chronologisch und lässt spätere Käufe frühere Verkäufe nicht decken", () => {
    expect(validateTransactionSequence([
      transaction("late-buy", "BUY", "2024-05-04", 5),
      transaction("early-sell", "SELL", "2024-05-03", 1),
    ])).toMatchObject({ ok: false, transactionId: "early-sell" });
  });

  it("ordnet am selben Tag alle Käufe vor Verkäufen, auch bei späterer Erfassung", () => {
    expect(validateTransactionSequence([
      transaction("sell", "SELL", "2024-05-03", 2.5, "2024-05-03T08:00:00.000Z"),
      transaction("buy", "BUY", "2024-05-03", 2.5, "2024-05-03T15:00:00.000Z"),
    ])).toEqual({ ok: true });
  });

  it("ordnet gleichartige Transaktionen zuerst nach createdAt und danach nach id", () => {
    const buy = transaction("buy", "BUY", "2024-05-01", 2);
    expect(validateTransactionSequence([
      transaction("a", "SELL", "2024-05-03", 1.5, "2024-05-03T09:00:00.000Z"),
      transaction("z", "SELL", "2024-05-03", 1.5, "2024-05-03T08:00:00.000Z"),
      buy,
    ])).toMatchObject({ ok: false, transactionId: "a" });
    expect(validateTransactionSequence([
      transaction("z", "SELL", "2024-05-03", 1.5),
      transaction("a", "SELL", "2024-05-03", 1.5),
      buy,
    ])).toMatchObject({ ok: false, transactionId: "z" });
  });

  it("erkennt, wenn das Entfernen eines Kaufs einen späteren Verkauf ungültig macht", () => {
    const items = [
      transaction("buy-one", "BUY", "2024-05-01", 2),
      transaction("buy-two", "BUY", "2024-05-02", 1),
      transaction("sell", "SELL", "2024-05-03", 3),
    ];
    expect(validateTransactionSequence(items)).toEqual({ ok: true });
    expect(validateTransactionSequence(items.filter((item) => item.id !== "buy-two")))
      .toMatchObject({ ok: false, transactionId: "sell" });
  });

  it("vergleicht Bestände mit Toleranz und ohne Zwischenrundung", () => {
    expect(validateTransactionSequence([
      transaction("buy-one", "BUY", "2024-05-01", 0.1),
      transaction("buy-two", "BUY", "2024-05-02", 0.2),
      transaction("sell", "SELL", "2024-05-03", 0.3),
    ])).toEqual({ ok: true });
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 1),
      transaction("sell", "SELL", "2024-05-03", 1 + 5e-10),
    ])).toEqual({ ok: true });
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 1),
      transaction("sell", "SELL", "2024-05-03", 1 + 2e-9),
    ])).toMatchObject({ ok: false, transactionId: "sell" });
  });

  it("formatiert Bestände mit bis zu acht Nachkommastellen", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 0.12345678),
      transaction("sell", "SELL", "2024-05-03", 1),
    ])).toMatchObject({
      ok: false,
      message: "Verkauf am 03.05.2024 übersteigt den Bestand (verfügbar: 0,12345678 Stück).",
    });
  });

  it("weist einen Fehlbestand exakt an der Toleranzgrenze zurück", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 1e-9),
      transaction("sell", "SELL", "2024-05-03", 2e-9),
    ])).toMatchObject({ ok: false, transactionId: "sell" });
  });

  it("verändert weder Reihenfolge noch Inhalte der Eingabe", () => {
    const items = [transaction("sell", "SELL", "2024-05-03", 1), transaction("buy", "BUY", "2024-05-01", 1)];
    const before = structuredClone(items);
    validateTransactionSequence(items);
    expect(items).toEqual(before);
  });

  it("erlaubt Splits und Zusammenlegungen mit Verkäufen des resultierenden Bestands", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2),
      transaction("split", "SPLIT", "2024-05-02", 0, undefined, 4),
      transaction("partial", "SELL", "2024-05-03", 3),
      transaction("consolidation", "SPLIT", "2024-05-04", 0, undefined, 0.1),
      transaction("remaining", "SELL", "2024-05-05", 0.5),
    ])).toEqual({ ok: true });
  });

  it("prüft Überverkäufe anhand des nach einem Split geänderten Bestands", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 20),
      transaction("split", "SPLIT", "2024-05-02", 0, undefined, 0.1),
      transaction("sell", "SELL", "2024-05-03", 3),
    ])).toEqual({
      ok: false,
      transactionId: "sell",
      message: "Verkauf am 03.05.2024 übersteigt den Bestand (verfügbar: 2 Stück).",
    });
  });

  it("verlangt beim Split offenen Bestand und lässt einen Kauf am Split-Tag nicht genügen", () => {
    const split = transaction("split", "SPLIT", "2024-05-03", 0, undefined, 4);
    const expected = { ok: false, transactionId: "split", message: "Split am 03.05.2024 ist ohne Bestand nicht möglich." };
    expect(validateTransactionSequence([split])).toEqual(expected);
    expect(validateTransactionSequence([transaction("buy", "BUY", "2024-05-03", 2), split])).toEqual(expected);
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2),
      transaction("sell", "SELL", "2024-05-02", 2),
      split,
    ])).toEqual(expected);
  });

  it("ordnet Splits vor Käufen desselben Tages und multipliziert nur den vorherigen Bestand", () => {
    expect(validateTransactionSequence([
      transaction("buy-before", "BUY", "2024-05-01", 2),
      transaction("buy-today", "BUY", "2024-05-03", 1, "2024-05-03T08:00:00.000Z"),
      transaction("split", "SPLIT", "2024-05-03", 0, "2024-05-03T15:00:00.000Z", 2),
      transaction("sell", "SELL", "2024-05-03", 6),
    ])).toEqual({
      ok: false,
      transactionId: "sell",
      message: "Verkauf am 03.05.2024 übersteigt den Bestand (verfügbar: 5 Stück).",
    });
  });

  it("erlaubt Dividenden nach einem Kauf, auch am Kauftag oder nach dem Komplettverkauf", () => {
    const dividend = transaction("dividend", "DIVIDEND", "2024-05-03", 100, "2024-05-03T08:00:00.000Z");
    expect(validateTransactionSequence([
      dividend,
      transaction("buy", "BUY", "2024-05-03", 2, "2024-05-03T15:00:00.000Z"),
      transaction("sell", "SELL", "2024-05-03", 2),
    ])).toEqual({ ok: true });
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2),
      transaction("sell", "SELL", "2024-05-02", 2),
      dividend,
    ])).toEqual({ ok: true });
  });

  it("weist Dividenden vor dem ersten Kauf zurück und nennt das deutsche Datum", () => {
    const dividend = transaction("dividend", "DIVIDEND", "2024-05-03", 2);
    const expected = { ok: false, transactionId: "dividend", message: "Dividende am 03.05.2024 ohne vorherigen Kauf." };
    expect(validateTransactionSequence([dividend])).toEqual(expected);
    expect(validateTransactionSequence([transaction("late-buy", "BUY", "2024-05-04", 2), dividend])).toEqual(expected);
  });

  it("ändert den Bestand durch Dividenden nicht", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 2),
      transaction("dividend", "DIVIDEND", "2024-05-02", 100),
      transaction("sell", "SELL", "2024-05-03", 3),
    ])).toMatchObject({ ok: false, transactionId: "sell" });
  });

  it("behält sehr kleine positive Bestände nach einer Zusammenlegung für weitere Splits bei", () => {
    expect(validateTransactionSequence([
      transaction("buy", "BUY", "2024-05-01", 1e-8),
      transaction("consolidation", "SPLIT", "2024-05-02", 0, undefined, 0.0001),
      transaction("split", "SPLIT", "2024-05-03", 0, undefined, 10000),
      transaction("sell", "SELL", "2024-05-04", 1e-8),
    ])).toEqual({ ok: true });
  });
});

describe("compareTransactions", () => {
  it("ordnet denselben Tag nach SPLIT, BUY, DIVIDEND, SELL, danach createdAt und id", () => {
    const items = [
      transaction("sell", "SELL", "2024-05-03", 1, "2024-05-03T07:00:00.000Z"),
      transaction("dividend", "DIVIDEND", "2024-05-03", 1, "2024-05-03T08:00:00.000Z"),
      transaction("buy", "BUY", "2024-05-03", 1, "2024-05-03T09:00:00.000Z"),
      transaction("split-z", "SPLIT", "2024-05-03", 0, "2024-05-03T10:00:00.000Z", 2),
      transaction("split-a", "SPLIT", "2024-05-03", 0, "2024-05-03T10:00:00.000Z", 3),
      transaction("split-later", "SPLIT", "2024-05-03", 0, "2024-05-03T11:00:00.000Z", 4),
      transaction("previous", "SELL", "2024-05-02", 1),
    ];
    expect([...items].sort(compareTransactions).map((item) => item.id)).toEqual([
      "previous", "split-a", "split-z", "split-later", "buy", "dividend", "sell",
    ]);
  });
});

describe("computeHoldings mit Dividenden und Splits", () => {
  it("führt Netto-Dividenden getrennt von Einstand, Ergebnis und Kauf-/Verkaufsgebühren", () => {
    const [holding] = computeHoldings([
      fullTransaction({ fees: 2 }),
      fullTransaction({ id: "dividend", type: "DIVIDEND", date: "2024-05-02", price: 3, fees: 1 }),
    ]);
    expect(holding).toMatchObject({ quantity: 2, costBasis: 202, averageCost: 101, realizedPnl: 0, dividends: 5, totalFees: 2, transactionCount: 2 });
  });

  it("erhält Dividenden beim Komplettverkauf und erfasst spätere Gutschriften", () => {
    const [holding] = computeHoldings([
      fullTransaction(),
      fullTransaction({ id: "dividend", type: "DIVIDEND", date: "2024-05-02", price: 3, fees: 1 }),
      fullTransaction({ id: "sell", type: "SELL", date: "2024-05-03", price: 120, fees: 2 }),
      fullTransaction({ id: "later-dividend", type: "DIVIDEND", date: "2024-05-04", price: 1, fees: 0.5 }),
    ]);
    expect(holding).toMatchObject({ quantity: 0, costBasis: 0, averageCost: null, realizedPnl: 38, dividends: 6.5, totalFees: 2, transactionCount: 4 });
  });

  it("multipliziert beim Split nur den Bestand und berechnet den Durchschnittseinstand neu", () => {
    const [holding] = computeHoldings([
      fullTransaction({ fees: 2 }),
      fullTransaction({ id: "split", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 4 }),
    ]);
    expect(holding).toMatchObject({ quantity: 8, costBasis: 202, averageCost: 25.25, realizedPnl: 0, dividends: 0, totalFees: 2, transactionCount: 2 });
  });

  it("bucht nach einem Split den anteiligen Einstand aus und lässt Dividenden den Bestand unverändert", () => {
    const [holding] = computeHoldings([
      fullTransaction({ fees: 2 }),
      fullTransaction({ id: "dividend-before", type: "DIVIDEND", date: "2024-05-02", price: 3, fees: 1 }),
      fullTransaction({ id: "split", type: "SPLIT", date: "2024-05-03", quantity: 0, price: 0, ratio: 4 }),
      fullTransaction({ id: "sell", type: "SELL", date: "2024-05-04", quantity: 3, price: 40, fees: 2 }),
      fullTransaction({ id: "dividend-after", type: "DIVIDEND", date: "2024-05-05", quantity: 5, price: 1, fees: 0.5 }),
    ]);
    expect(holding).toMatchObject({ quantity: 5, costBasis: 126.25, averageCost: 25.25, realizedPnl: 42.25, dividends: 9.5, totalFees: 4, transactionCount: 5 });
  });

  it("berechnet eine Zusammenlegung und einen anschließenden Komplettverkauf", () => {
    const transactions = [
      fullTransaction({ quantity: 20, price: 10, fees: 2 }),
      fullTransaction({ id: "consolidation", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 0.1 }),
    ];
    expect(computeHoldings(transactions)[0]).toMatchObject({ quantity: 2, costBasis: 202, averageCost: 101, totalFees: 2, transactionCount: 2 });
    expect(computeHoldings([
      ...transactions,
      fullTransaction({ id: "sell", type: "SELL", date: "2024-05-03", price: 130, fees: 2 }),
    ])[0]).toMatchObject({ quantity: 0, costBasis: 0, averageCost: null, realizedPnl: 56, totalFees: 4, transactionCount: 3 });
  });

  it("verarbeitet alle vier Arten am selben Tag in der vereinbarten Reihenfolge", () => {
    const transactions = [
      fullTransaction(),
      fullTransaction({ id: "sell", type: "SELL", date: "2024-05-03", quantity: 5, price: 40, fees: 2, createdAt: "2024-05-03T07:00:00.000Z" }),
      fullTransaction({ id: "dividend", type: "DIVIDEND", date: "2024-05-03", quantity: 10, price: 2, fees: 1, createdAt: "2024-05-03T08:00:00.000Z" }),
      fullTransaction({ id: "buy-today", date: "2024-05-03", price: 30, createdAt: "2024-05-03T09:00:00.000Z" }),
      fullTransaction({ id: "split", type: "SPLIT", date: "2024-05-03", quantity: 0, price: 0, ratio: 4, createdAt: "2024-05-03T10:00:00.000Z" }),
    ];
    const before = structuredClone(transactions);
    const [holding] = computeHoldings(transactions);
    expect(holding).toMatchObject({ quantity: 5, costBasis: 130, averageCost: 26, realizedPnl: 68, dividends: 19, totalFees: 2, transactionCount: 5 });
    expect(computeHoldings([...transactions].reverse())).toEqual([holding]);
    expect(transactions).toEqual(before);
  });

  it("erhält beim Split auch einen positiven Bestand unter der Verkaufstoleranz und seinen Einstand", () => {
    const [holding] = computeHoldings([
      fullTransaction({ quantity: 1e-8, price: 1e8 }),
      fullTransaction({ id: "consolidation", type: "SPLIT", date: "2024-05-02", quantity: 0, price: 0, ratio: 0.0001 }),
    ]);
    expect(holding!.quantity).toBe(1e-12);
    expect(holding!.costBasis).toBe(1);
    expect(holding!.averageCost).toBe(1e12);
  });
});
