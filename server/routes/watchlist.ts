import { Router } from "express";
import { z } from "zod";
import type { WatchlistItem } from "../../shared/types";
import type { Repositories, StoredWatchlistItem } from "../db";
import { ApiError } from "../errors";
import type { MarketDataProvider } from "../market";
import { instrumentIdSchema, instrumentSchema, parse } from "../validation";

export function isMissingMarketData(error: unknown): boolean {
  return error instanceof ApiError && ["MARKET_DATA_UNAVAILABLE", "NOT_FOUND"].includes(error.code);
}

export function createWatchlistRouter({ repos, market, now }: { repos: Repositories; market: MarketDataProvider; now: () => Date }): Router {
  const router = Router();
  async function withQuote(item: StoredWatchlistItem): Promise<WatchlistItem> {
    let quote = null;
    try { quote = await market.getQuote(item.instrument.id); }
    catch (error) { if (!isMissingMarketData(error)) throw error; }
    return { ...item, quote };
  }
  router.get("/", async (_req, res) => {
    const items = await repos.watchlist.list(res.locals.userId as string);
    res.json({ items: await Promise.all(items.map(withQuote)) });
  });
  router.post("/", async (req, res) => {
    const { instrument } = parse(z.object({ instrument: instrumentSchema }), req.body);
    const { item, created } = await repos.watchlist.add(res.locals.userId as string, instrument, now().toISOString());
    res.status(created ? 201 : 200).json(await withQuote(item));
  });
  router.delete("/:instrumentId", async (req, res) => {
    const id = parse(instrumentIdSchema, req.params.instrumentId);
    if (!await repos.watchlist.delete(res.locals.userId as string, id)) throw new ApiError(404, "NOT_FOUND", "Das Wertpapier wurde in deiner Watchlist nicht gefunden.");
    res.sendStatus(204);
  });
  return router;
}
