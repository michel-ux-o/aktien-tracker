import { Router } from "express";
import { z } from "zod";
import type { MarketDataProvider } from "../market";
import { instrumentIdSchema, parse, rangeSchema } from "../validation";

export function createMarketRouter(market: MarketDataProvider): Router {
  const router = Router();
  router.get("/search", async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1, "Bitte gib einen Suchbegriff ein.").max(200, "Der Suchbegriff ist zu lang.") }), req.query);
    res.json(await market.search(q));
  });
  router.get("/quote", async (req, res) => {
    const { id } = parse(z.object({ id: instrumentIdSchema }), req.query);
    res.json(await market.getQuote(id));
  });
  router.get("/quotes", async (req, res) => {
    const { ids } = parse(z.object({ ids: z.string().min(1, "Bitte gib mindestens eine Wertpapierkennung an.").max(10000, "Die Anfrage enthält zu viele Wertpapiere.") }), req.query);
    const list = parse(z.array(instrumentIdSchema).min(1).max(50, "Pro Anfrage sind höchstens 50 Wertpapiere erlaubt."), ids.split(","));
    res.json({ quotes: await market.getQuotes([...new Set(list)]) });
  });
  router.get("/history", async (req, res) => {
    const { id, range } = parse(z.object({ id: instrumentIdSchema, range: rangeSchema }), req.query);
    res.json(await market.getHistory(id, range));
  });
  router.get("/profile", async (req, res) => {
    const { id } = parse(z.object({ id: instrumentIdSchema }), req.query);
    res.json(await market.getProfile(id));
  });
  return router;
}
