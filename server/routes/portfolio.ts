import { Router } from "express";
import { z } from "zod";
import { buildPortfolio, computeHoldings, computePortfolioHistory, createFxLookup, rangeStartDate } from "../../shared/portfolio";
import { HISTORY_RANGES, type Currency, type FxPoint, type FxRate, type HistoryRange, type PricePoint, type Quote, type Transaction } from "../../shared/types";
import type { Repositories } from "../db";
import type { MarketDataProvider } from "../market";
import { today } from "../middleware";
import { parse, rangeSchema } from "../validation";
import { isMissingMarketData } from "./watchlist";

export function createPortfolioRouter({ repos, market, now }: { repos: Repositories; market: MarketDataProvider; now: () => Date }): Router {
  const router = Router();
  async function fxFor(transactions: Transaction[], baseCurrency: Currency, date: string, chartRange?: HistoryRange) {
    const currencies = [...new Set(transactions.map((transaction) => transaction.currency))].filter((currency) => currency !== baseCurrency);
    const rates: Record<Currency, FxRate | null> = {};
    const histories: Record<Currency, FxPoint[]> = {};
    const chartStart = chartRange ? rangeStartDate(chartRange, date) : undefined;
    const firstTransactionDate = transactions.reduce((first, transaction) => transaction.date < first ? transaction.date : first, date);
    // Eine Woche Puffer, damit auch für Transaktionen an Wochenend- und Feiertagen ein Kurs „am oder vor“ dem Tag vorliegt.
    const buffered = new Date(`${firstTransactionDate}T00:00:00.000Z`);
    buffered.setUTCDate(buffered.getUTCDate() - 7);
    const firstFxDate = buffered.toISOString().slice(0, 10);
    const firstDate = chartStart && chartStart < firstFxDate ? chartStart : firstFxDate;
    const range = chartStart === null ? "MAX" : HISTORY_RANGES.find((candidate) => {
      const start = rangeStartDate(candidate, date);
      return start === null || start <= firstDate;
    })!;
    await Promise.all(currencies.map(async (currency) => {
      // Missing current and historical rates are independent: either can still value its part of the portfolio.
      await Promise.all([
        (async () => {
          try { rates[currency] = await market.getFxRate(currency, baseCurrency); }
          catch (error) { if (!isMissingMarketData(error)) throw error; rates[currency] = null; }
        })(),
        (async () => {
          try { histories[currency] = (await market.getFxHistory(currency, baseCurrency, range)).points; }
          catch (error) { if (!isMissingMarketData(error)) throw error; histories[currency] = []; }
        })(),
      ]);
    }));
    return createFxLookup({ baseCurrency, current: rates, histories, source: market.source });
  }
  router.get("/", async (_req, res) => {
    const userId = res.locals.userId as string;
    const [transactions, { baseCurrency }] = await Promise.all([
      repos.transactions.list(userId), repos.settings.get(userId),
    ]);
    const holdings = computeHoldings(transactions).filter((holding) => holding.quantity > 0);
    const quotes: Record<string, Quote | undefined> = {};
    const [fx] = await Promise.all([
      fxFor(transactions, baseCurrency, today(now)),
      Promise.all(holdings.map(async (holding) => {
        try { quotes[holding.instrumentId] = await market.getQuote(holding.instrumentId); }
        catch (error) { if (!isMissingMarketData(error)) throw error; }
      })),
    ]);
    res.json(buildPortfolio(transactions, quotes, baseCurrency, fx));
  });
  router.get("/history", async (req, res) => {
    const { range } = parse(z.object({ range: rangeSchema }), req.query);
    const userId = res.locals.userId as string;
    const [transactions, { baseCurrency }] = await Promise.all([
      repos.transactions.list(userId), repos.settings.get(userId),
    ]);
    const date = today(now);
    const startDate = rangeStartDate(range, date);
    const histories: Record<string, PricePoint[]> = {};
    const [fx] = await Promise.all([
      fxFor(transactions, baseCurrency, date, range),
      Promise.all([...new Set(transactions.map((transaction) => transaction.instrumentId))].map(async (id) => {
        try {
          const history = await market.getHistory(id, range);
          histories[id] = history.points.filter((point) => point.date <= date && (startDate === null || point.date >= startDate));
        } catch (error) { if (!isMissingMarketData(error)) throw error; histories[id] = []; }
      })),
    ]);
    res.json(computePortfolioHistory({ transactions, histories, baseCurrency, fx, range, today: date, meta: market.meta() }));
  });
  return router;
}
