import { describe, expect, it } from "vitest";
import type { FxPoint, FxRate } from "../types";
import { createFxLookup } from "./index";
import { lookupConversion } from "./common";

const current: FxRate = {
  from: "USD",
  to: "EUR",
  rate: 0.95,
  asOf: "2024-05-10T18:00:00.000Z",
  source: "Aktuelle Testkurse",
};
const points: FxPoint[] = [
  { date: "2024-05-01", rate: 0.8 },
  { date: "2024-05-03", rate: 0.85 },
  { date: "2024-05-07", rate: 0.9 },
];

function lookup(histories: Record<string, FxPoint[]> = { USD: points }) {
  return createFxLookup({ baseCurrency: "EUR", current: { USD: current }, histories, source: "Historische Testkurse" });
}

describe("createFxLookup", () => {
  it("liefert den aktuellen Kurs ausschließlich bei date=null mit dessen Metadaten", () => {
    expect(lookup()("USD", "EUR", null)).toEqual(current);
    expect(lookup()("USD", "EUR", "2024-05-10")).toEqual({
      from: "USD", to: "EUR", rate: 0.9, asOf: "2024-05-07", source: "Historische Testkurse",
    });
  });

  it.each([
    ["2024-05-01", "2024-05-01", 0.8],
    ["2024-05-02", "2024-05-01", 0.8],
    ["2024-05-03", "2024-05-03", 0.85],
    ["2024-05-06", "2024-05-03", 0.85],
    ["2024-05-07", "2024-05-07", 0.9],
    ["2025-01-01", "2024-05-07", 0.9],
  ])("wählt am oder vor %s den Punkt %s", (date, asOf, rate) => {
    expect(lookup()("USD", "EUR", date)).toEqual({ from: "USD", to: "EUR", rate, asOf, source: "Historische Testkurse" });
  });

  it("weicht vor dem ersten historischen Punkt oder bei leerer Historie niemals auf den aktuellen Kurs aus", () => {
    expect(lookup()("USD", "EUR", "2024-04-30")).toBeNull();
    expect(lookup({ USD: [] })("USD", "EUR", "2024-05-10")).toBeNull();
    expect(lookup({})("USD", "EUR", "2024-05-10")).toBeNull();
    expect(lookup({})("USD", "EUR", null)).toEqual(current);
  });

  it("liefert historische Kurse auch bei fehlendem aktuellem Kurs", () => {
    const fx = createFxLookup({ baseCurrency: "EUR", current: { USD: null }, histories: { USD: points }, source: "Historie" });
    expect(fx("USD", "EUR", null)).toBeNull();
    expect(fx("USD", "EUR", "2024-05-03")?.rate).toBe(0.85);
  });

  it("unterstützt nur Paare zur Basiswährung und gibt für unbekannte Währungen null zurück", () => {
    const fx = lookup();
    for (const date of [null, "2024-05-03"]) {
      expect(fx("USD", "CHF", date)).toBeNull();
      expect(fx("EUR", "USD", date)).toBeNull();
      expect(fx("CHF", "EUR", date)).toBeNull();
    }
  });

  it("verwechselt die historischen Kurse verschiedener Handelswährungen nicht", () => {
    const fx = lookup({ USD: points, CHF: [{ date: "2024-05-02", rate: 1.05 }] });
    expect(fx("CHF", "EUR", "2024-05-03")).toEqual({
      from: "CHF", to: "EUR", rate: 1.05, asOf: "2024-05-02", source: "Historische Testkurse",
    });
    expect(fx("USD", "EUR", "2024-05-03")?.rate).toBe(0.85);
  });

  it("sortiert ohne Veränderung der Eingaben und arbeitet mit eingefrorenen Daten", () => {
    const histories = { USD: [...points].reverse() };
    const args = { baseCurrency: "EUR", current: { USD: { ...current } }, histories, source: "Historie" };
    const snapshot = structuredClone(args);
    histories.USD.forEach(Object.freeze);
    Object.freeze(histories.USD);
    Object.freeze(histories);
    Object.freeze(args.current.USD);
    Object.freeze(args.current);
    Object.freeze(args);
    const fx = createFxLookup(args);
    expect(fx("USD", "EUR", "2024-05-02")?.rate).toBe(0.8);
    expect(fx("USD", "EUR", null)).toEqual(current);
    expect(args).toEqual(snapshot);
  });

  it.each([0, -1, NaN, Infinity])("weist ungültige aktuelle und historische Kursfaktoren zurück: %s", (rate) => {
    const fx = createFxLookup({
      baseCurrency: "EUR", current: { USD: { ...current, rate } },
      histories: { USD: [{ date: "2024-05-01", rate }] }, source: "Historie",
    });
    expect(fx("USD", "EUR", null)).toBeNull();
    expect(fx("USD", "EUR", "2024-05-01")).toBeNull();
  });

  it.each([{ from: "CHF" }, { to: "CHF" }])("weist einen aktuellen Kurs mit abweichendem Währungspaar zurück: %s", (overrides) => {
    const fx = createFxLookup({ baseCurrency: "EUR", current: { USD: { ...current, ...overrides } }, histories: {}, source: "Test" });
    expect(fx("USD", "EUR", null)).toBeNull();
  });
});

describe("lookupConversion", () => {
  it("verwendet auch historisch Faktor 1 ohne externe Abfrage in der Basiswährung", () => {
    const fx = () => { throw new Error("Basiswährung braucht keine FX-Abfrage"); };
    expect(lookupConversion("EUR", "EUR", fx, null)).toEqual({ factor: 1, rate: null });
    expect(lookupConversion("EUR", "EUR", fx, "2024-05-01")).toEqual({ factor: 1, rate: null });
  });

  it("übergibt aktuelle und historische Daten getrennt an den Lookup", () => {
    const calls: (string | null)[][] = [];
    const fx = (from: string, to: string, date: string | null) => {
      calls.push([from, to, date]);
      return lookup()(from, to, date);
    };
    expect(lookupConversion("USD", "EUR", fx).factor).toBe(0.95);
    expect(lookupConversion("USD", "EUR", fx, "2024-05-02").factor).toBe(0.8);
    expect(calls).toEqual([["USD", "EUR", null], ["USD", "EUR", "2024-05-02"]]);
  });
});
