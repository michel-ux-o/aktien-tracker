import { z } from "zod";
import { HISTORY_RANGES, SUPPORTED_BASE_CURRENCIES } from "../shared/types";
import { ApiError } from "./errors";

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value, { error: () => "Dieses Feld enthält einen ungültigen Wert." });
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "body";
    fields[key] ??= issue.message;
  }
  throw new ApiError(400, "VALIDATION_ERROR", "Bitte prüfe deine Eingaben.", fields);
}

const text = z.string({ error: "Bitte gib einen Text an." }).trim().min(1, "Dieses Feld darf nicht leer sein.").max(200, "Dieses Feld ist zu lang.");
export const instrumentSchema = z.object({
  id: text,
  symbol: text,
  name: text,
  exchange: text,
  mic: text,
  currency: z.string().regex(/^[A-Z]{3}$/, "Bitte gib eine gültige Währung an."),
  country: text.nullable(),
  type: text.nullable(),
}).refine((instrument) => instrument.id === `${instrument.symbol}:${instrument.mic}`, {
  message: "Die Wertpapierkennung muss zu Symbol und Börsenplatz passen.", path: ["id"],
});

export const instrumentIdSchema = z.string().trim().min(3, "Bitte gib eine Wertpapierkennung an.").max(200, "Die Wertpapierkennung ist zu lang.")
  .regex(/^[^:\s,]+:[A-Za-z0-9]+$/, "Die Wertpapierkennung muss Symbol und Börsenplatz enthalten.");
export const rangeSchema = z.enum(HISTORY_RANGES, { error: "Bitte wähle einen gültigen Zeitraum." });
export const settingsSchema = z.object({
  baseCurrency: z.string().refine((value) => SUPPORTED_BASE_CURRENCIES.includes(value), "Diese Basiswährung wird nicht unterstützt.").optional(),
  theme: z.enum(["system", "light", "dark"], { error: "Bitte wähle ein gültiges Farbschema." }).optional(),
});
