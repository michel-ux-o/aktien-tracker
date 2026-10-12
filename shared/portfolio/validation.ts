import type { Instrument, TransactionInput } from "../types";
import { compareTransactions, EPSILON } from "./common";
import type { InputValidationResult, SequenceItem, SequenceValidationResult } from "./index";

const quantityFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 8 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Zählt auch bei kleinen Zahlen wie 1e-8 die Stellen nach dem Dezimalkomma. */
function decimalPlaces(value: number): number {
  const [coefficient = "", exponent = "0"] = value.toString().toLowerCase().split("e");
  const fraction = coefficient.split(".")[1] ?? "";
  return Math.max(0, fraction.length - Number(exponent));
}

function validateInstrument(value: unknown): Instrument | null {
  if (!isRecord(value)) return null;
  const requiredStrings = ["id", "symbol", "name", "exchange", "mic", "currency"] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) return null;
  }
  if (value.country !== null && typeof value.country !== "string") return null;
  if (value.type !== null && typeof value.type !== "string") return null;

  return {
    id: (value.id as string).trim(),
    symbol: (value.symbol as string).trim(),
    name: (value.name as string).trim(),
    exchange: (value.exchange as string).trim(),
    mic: (value.mic as string).trim(),
    currency: (value.currency as string).trim(),
    country: value.country,
    type: value.type,
  };
}

export function validateTransactionInput(input: unknown, today: string): InputValidationResult {
  if (!isRecord(input)) {
    return { ok: false, fields: { instrument: "Bitte geben Sie eine gültige Transaktion ein." } };
  }

  const fields: Record<string, string> = {};
  const instrument = validateInstrument(input.instrument);
  if (!instrument) fields.instrument = "Bitte wählen Sie ein gültiges Wertpapier aus.";
  if (input.type !== "BUY" && input.type !== "SELL" && input.type !== "DIVIDEND" && input.type !== "SPLIT") {
    fields.type = "Die Transaktionsart muss Kauf, Verkauf, Dividende oder Split sein.";
  }

  if (!isCalendarDate(input.date)) {
    fields.date = "Bitte geben Sie ein gültiges Datum im Format JJJJ-MM-TT an.";
  } else if (input.date < "1900-01-01") {
    fields.date = "Das Datum darf nicht vor dem 01.01.1900 liegen.";
  } else if (input.date > today) {
    fields.date = "Das Datum darf nicht in der Zukunft liegen.";
  }

  const isSplit = input.type === "SPLIT";
  const fees = isSplit || input.fees === undefined ? 0 : input.fees;
  if (isSplit) {
    if (typeof input.ratio !== "number" || !Number.isFinite(input.ratio)) {
      fields.ratio = "Das Split-Verhältnis muss eine endliche Zahl sein.";
    } else if (input.ratio <= 0) {
      fields.ratio = "Das Split-Verhältnis muss größer als 0 sein.";
    } else if (input.ratio === 1) {
      fields.ratio = "Das Split-Verhältnis darf nicht 1 sein.";
    } else if (input.ratio < 0.0001 || input.ratio > 10000) {
      fields.ratio = "Das Split-Verhältnis muss zwischen 0,0001 und 10.000 liegen.";
    } else if (decimalPlaces(input.ratio) > 8) {
      fields.ratio = "Das Split-Verhältnis darf höchstens 8 Nachkommastellen haben.";
    }
  } else {
    if (input.ratio !== undefined && input.ratio !== null) {
      fields.ratio = "Ein Split-Verhältnis ist nur bei einem Split erlaubt.";
    }

    if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity)) {
      fields.quantity = "Die Stückzahl muss eine endliche Zahl sein.";
    } else if (input.quantity <= 0) {
      fields.quantity = "Die Stückzahl muss größer als 0 sein.";
    } else if (decimalPlaces(input.quantity) > 8) {
      fields.quantity = "Die Stückzahl darf höchstens 8 Nachkommastellen haben.";
    }

    if (typeof input.price !== "number" || !Number.isFinite(input.price)) {
      fields.price = "Der Preis muss eine endliche Zahl sein.";
    } else if (input.price <= 0) {
      fields.price = "Der Preis muss größer als 0 sein.";
    }

    if (typeof fees !== "number" || !Number.isFinite(fees)) {
      fields.fees = "Die Gebühren müssen eine endliche Zahl sein.";
    } else if (fees < 0) {
      fields.fees = "Die Gebühren dürfen nicht negativ sein.";
    } else if (
      input.type === "DIVIDEND" &&
      typeof input.quantity === "number" && Number.isFinite(input.quantity) && input.quantity > 0 &&
      typeof input.price === "number" && Number.isFinite(input.price) && input.price > 0 &&
      fees > input.quantity * input.price
    ) {
      fields.fees = "Die Abzüge dürfen die Brutto-Dividende nicht übersteigen.";
    }
  }

  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
    fields.currency = "Die Handelswährung muss aus drei Großbuchstaben bestehen.";
  } else if (instrument && input.currency !== instrument.currency) {
    fields.currency = "Handelswährung muss der Währung des Wertpapiers entsprechen";
  }

  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") {
      fields.note = "Die Notiz muss ein Text sein.";
    } else if (input.note.length > 500) {
      fields.note = "Die Notiz darf höchstens 500 Zeichen enthalten.";
    } else {
      note = input.note.trim() || null;
    }
  }

  if (input.clientRequestId !== undefined) {
    if (typeof input.clientRequestId !== "string") {
      fields.clientRequestId = "Die Anfragekennung muss ein Text sein.";
    } else if (input.clientRequestId.length > 100) {
      fields.clientRequestId = "Die Anfragekennung darf höchstens 100 Zeichen enthalten.";
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  // Nach der vollständigen Feldprüfung sind diese Werte auf TransactionInput eingegrenzt.
  const value: TransactionInput = {
    instrument: instrument!,
    type: input.type as TransactionInput["type"],
    date: input.date as string,
    quantity: isSplit ? 0 : input.quantity as number,
    price: isSplit ? 0 : input.price as number,
    fees: fees as number,
    currency: input.currency as string,
    ratio: isSplit ? input.ratio as number : null,
    note,
  };
  if (typeof input.clientRequestId === "string") value.clientRequestId = input.clientRequestId;
  return { ok: true, value };
}

export function validateTransactionSequence(items: SequenceItem[]): SequenceValidationResult {
  let quantity = 0;
  let hasBought = false;
  for (const item of [...items].sort(compareTransactions)) {
    const date = `${item.date.slice(8, 10)}.${item.date.slice(5, 7)}.${item.date.slice(0, 4)}`;
    if (item.type === "BUY") {
      quantity += item.quantity;
      hasBought = true;
    } else if (item.type === "SPLIT") {
      if (quantity <= 0) {
        return {
          ok: false,
          transactionId: item.id,
          message: `Split am ${date} ist ohne Bestand nicht möglich.`,
        };
      }
      quantity *= item.ratio!;
    } else if (item.type === "DIVIDEND") {
      if (quantity <= 0 && !hasBought) {
        return {
          ok: false,
          transactionId: item.id,
          message: `Dividende am ${date} ohne vorherigen Kauf.`,
        };
      }
    } else if (item.type === "SELL") {
      if (item.quantity - quantity >= EPSILON) {
        return {
          ok: false,
          transactionId: item.id,
          message: `Verkauf am ${date} übersteigt den Bestand (verfügbar: ${quantityFormatter.format(quantity)} Stück).`,
        };
      }
      quantity -= item.quantity;
      if (Math.abs(quantity) < EPSILON) quantity = 0;
    }
  }
  return { ok: true };
}
