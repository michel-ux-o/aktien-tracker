import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { requireAuth } from "./auth";
import type { Repositories } from "./db/types";
import { ApiError, errorHandler } from "./errors";
import type { Mailer } from "./mail";
import type { MarketDataProvider } from "./market";
import { csrfProtection } from "./middleware";
import { createAuthRouter } from "./routes/auth";
import { createAlertsRouter } from "./routes/alerts";
import { createMarketRouter } from "./routes/market";
import { createPortfolioRouter } from "./routes/portfolio";
import { createSettingsRouter } from "./routes/settings";
import { createStatusRouter } from "./routes/status";
import { createTransactionsRouter } from "./routes/transactions";
import { createWatchlistRouter } from "./routes/watchlist";

export interface AppDependencies {
  repos: Repositories;
  market: MarketDataProvider;
  mailer: Mailer;
  now?: () => Date;
  production?: boolean;
  trustProxy?: number;
  appUrl?: string;
  distDir?: string;
  rateLimits?: Parameters<typeof createAuthRouter>[0]["rateLimits"];
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  const { repos } = deps;
  const now = deps.now ?? (() => new Date());
  const production = deps.production ?? process.env.NODE_ENV === "production";
  const trustProxy = deps.trustProxy ?? (production ? 1 : undefined);
  if (trustProxy !== undefined) {
    if (!Number.isSafeInteger(trustProxy) || trustProxy < 0) throw new Error("trustProxy muss eine nichtnegative ganze Zahl sein.");
    app.set("trust proxy", trustProxy);
  }
  app.disable("x-powered-by");
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/api", csrfProtection);
  const json = express.json({ limit: "100kb" });
  const importJson = express.json({ limit: "2mb" });
  app.use((req, res, next) => {
    const isImport = req.method === "POST" && /^\/api\/transactions\/import\/?$/i.test(req.path);
    (isImport ? importJson : json)(req, res, next);
  });
  app.use(cookieParser());
  app.use("/api/status", createStatusRouter(deps.market, deps.mailer));
  app.use("/api/auth", createAuthRouter({
    repos, mailer: deps.mailer, now, production, appUrl: deps.appUrl ?? process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:5173", rateLimits: deps.rateLimits,
  }));
  app.use("/api", requireAuth({ repos, now }));
  app.use("/api/settings", createSettingsRouter(repos));
  app.use("/api/market", createMarketRouter(deps.market));
  app.use("/api/watchlist", createWatchlistRouter({ repos, market: deps.market, now }));
  app.use("/api/transactions", createTransactionsRouter({ repos, now }));
  app.use("/api/alerts", createAlertsRouter({ repos, market: deps.market, now }));
  app.use("/api/portfolio", createPortfolioRouter({ repos, market: deps.market, now }));
  app.use("/api", () => { throw new ApiError(404, "NOT_FOUND", "Der angeforderte API-Endpunkt wurde nicht gefunden."); });
  if (production) {
    const distDir = resolve(deps.distDir ?? "dist");
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method)) return next();
      res.sendFile(resolve(distDir, "index.html"), (error) => { if (error) next(new ApiError(404, "NOT_FOUND", "Die Anwendung wurde noch nicht gebaut.")); });
    });
  }
  app.use(() => { throw new ApiError(404, "NOT_FOUND", "Die angeforderte Seite wurde nicht gefunden."); });
  app.use(errorHandler);
  return app;
}
