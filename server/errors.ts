import type { ErrorRequestHandler } from "express";
import type { ApiErrorBody, ApiErrorCode } from "../shared/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof SyntaxError && "type" in error && error.type === "entity.parse.failed") {
    apiError = new ApiError(400, "VALIDATION_ERROR", "Die Anfrage enthält kein gültiges JSON.");
  } else if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    apiError = new ApiError(400, "VALIDATION_ERROR", "Die Anfrage ist zu groß.");
  } else {
    // Anbieterfehler können Zugangsdaten in URLs enthalten. Keine ungefilterten Fehler loggen.
    console.error("Interner Serverfehler bei einer API-Anfrage.");
    apiError = new ApiError(500, "INTERNAL_ERROR", "Ein interner Fehler ist aufgetreten. Bitte versuche es später erneut.");
  }
  const body: ApiErrorBody = {
    error: { code: apiError.code, message: apiError.message, ...(apiError.fields ? { fields: apiError.fields } : {}) },
  };
  res.status(apiError.status).json(body);
};
