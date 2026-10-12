import { Router } from "express";
import type { StatusResponse } from "../../shared/api";
import type { Mailer } from "../mail";
import type { MarketDataProvider } from "../market";

export function createStatusRouter(market: MarketDataProvider, mailer: Mailer): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    const status: StatusResponse = {
      marketData: { mode: market.mode, source: market.source, delayNote: market.delayNote },
      email: { mode: mailer.mode },
    };
    res.json(status);
  });
  return router;
}
