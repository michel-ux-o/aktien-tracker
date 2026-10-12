import { Router } from "express";
import { z } from "zod";
import { MAX_PRICE_ALERTS, type AlertsResponse } from "../../shared/api";
import type { PriceAlert, Quote } from "../../shared/types";
import type { Repositories, StoredPriceAlert } from "../db";
import { ApiError } from "../errors";
import type { MarketDataProvider } from "../market";
import { instrumentIdSchema, instrumentSchema, parse } from "../validation";

const alertSchema = z.object({
  instrument: instrumentSchema,
  condition: z.enum(["ABOVE", "BELOW"], { error: "Bitte wähle eine gültige Alarmbedingung." }),
  targetPrice: z.number({ error: "Der Zielkurs muss eine endliche Zahl sein." })
    .positive("Der Zielkurs muss größer als 0 sein."),
  note: z.string({ error: "Die Notiz muss ein Text sein." })
    .max(200, "Die Notiz darf höchstens 200 Zeichen enthalten.").nullable().optional(),
});

function missingAlert(): never {
  throw new ApiError(404, "NOT_FOUND", "Der Kursalarm wurde nicht gefunden.");
}

export function createAlertsRouter({ repos, market, now }: {
  repos: Repositories;
  market: MarketDataProvider;
  now: () => Date;
}): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const userId = res.locals.userId as string;
    const instrumentId = req.query.instrumentId === undefined ? undefined : parse(instrumentIdSchema, req.query.instrumentId);
    // A filtered view still checks every active alert belonging to this user.
    const alerts = await repos.alerts.list(userId);
    const ids = [...new Set(alerts.map((alert) => alert.instrumentId))];
    const quotes: Record<string, Quote> = {};
    for (let start = 0; start < ids.length; start += 50) {
      try {
        Object.assign(quotes, await market.getQuotes(ids.slice(start, start + 50)));
      } catch {
        // Alerts remain available even when a provider or one quote batch fails.
      }
    }

    function quoteFor(alert: StoredPriceAlert): Quote | null {
      const quote = quotes[alert.instrumentId];
      return quote && quote.currency === alert.currency && quote.price !== null && Number.isFinite(quote.price) ? quote : null;
    }

    const triggeredAt = now().toISOString();
    const persisted = await repos.atomic(async (tx) => {
      // Quotes were fetched before acquiring the user lock; check the current persisted state.
      for (const alert of await tx.alerts.list(userId)) {
        if (alert.triggeredAt !== null) continue;
        const quote = quoteFor(alert);
        if (quote === null || quote.price === null) continue;
        const triggered = alert.condition === "ABOVE" ? quote.price >= alert.targetPrice : quote.price <= alert.targetPrice;
        if (triggered) await tx.alerts.markTriggered(userId, alert.id, triggeredAt, quote.price);
      }
      return tx.alerts.list(userId, instrumentId);
    }, { lockKey: userId });

    // Read the persisted order again after newly triggered alerts have moved to the top.
    const result: PriceAlert[] = persisted.map((alert) => ({ ...alert, quote: quoteFor(alert) }));
    const response: AlertsResponse = { alerts: result, triggeredCount: result.filter((alert) => alert.triggeredAt !== null).length };
    res.json(response);
  });

  router.post("/", async (req, res) => {
    const userId = res.locals.userId as string;
    const input = parse(alertSchema, req.body);
    const alert = await repos.atomic(async (tx) => {
      if (await tx.alerts.count(userId) >= MAX_PRICE_ALERTS) {
        throw new ApiError(409, "CONFLICT", `Du kannst höchstens ${MAX_PRICE_ALERTS} Kursalarme anlegen.`);
      }
      return tx.alerts.create(userId, input, now().toISOString());
    }, { lockKey: userId });
    res.status(201).json({ ...alert, quote: null } satisfies PriceAlert);
  });

  router.post("/:id/reactivate", async (req, res) => {
    const userId = res.locals.userId as string;
    const alert = await repos.atomic(async (tx) =>
      await tx.alerts.reactivate(userId, req.params.id as string) ?? missingAlert(), { lockKey: userId });
    res.json({ ...alert, quote: null } satisfies PriceAlert);
  });

  router.delete("/:id", async (req, res) => {
    const userId = res.locals.userId as string;
    await repos.atomic(async (tx) => {
      if (!await tx.alerts.delete(userId, req.params.id as string)) missingAlert();
    }, { lockKey: userId });
    res.sendStatus(204);
  });

  return router;
}
