import type { RequestHandler } from "express";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../shared/api";
import { ApiError } from "./errors";

export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return next(new ApiError(403, "FORBIDDEN", "Der erforderliche Sicherheitsheader fehlt oder ist ungültig."));
  }
  next();
};

export function today(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}
