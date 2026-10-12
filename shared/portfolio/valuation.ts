import type { Currency, FxRate, InstrumentId, Portfolio, Position, Quote, Transaction } from "../types";
import type { FxLookup } from "./index";
import { lookupConversion } from "./common";
import { computeHoldings } from "./holdings";
import { computeBaseLedger } from "./base-ledger";

/** Keine unbekannten Werte als Nullbetrag ausgeben; ein leeres Portfolio hat dagegen Wert 0. */
function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (values.length > 0 && known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function percent(value: number | null, basis: number | null): number | null {
  return value !== null && basis !== null && basis > 0 ? (value / basis) * 100 : null;
}

export function buildPortfolio(
  transactions: Transaction[],
  quotes: Record<InstrumentId, Quote | undefined>,
  baseCurrency: Currency,
  fx: FxLookup,
): Portfolio {
  const holdings = computeHoldings(transactions);
  const baseLedger = computeBaseLedger(transactions, baseCurrency, fx);
  const missingPrices = new Set<InstrumentId>();
  const missingFx = new Set<Currency>();
  const fxRates = new Map<Currency, FxRate>();
  const conversions = new Map<Currency, ReturnType<typeof lookupConversion>>();
  const soldInstruments = new Set(
    transactions.filter((transaction) => transaction.type === "SELL").map((transaction) => transaction.instrumentId),
  );

  const allPositions: Position[] = holdings.map((holding) => {
    const ledger = baseLedger.get(holding.instrumentId)!;
    let conversion = conversions.get(holding.currency);
    if (!conversion) {
      conversion = lookupConversion(holding.currency, baseCurrency, fx);
      conversions.set(holding.currency, conversion);
    }
    const { factor, rate } = conversion;
    if (factor === null || ledger.missingFx) missingFx.add(holding.currency);
    if (rate !== null) fxRates.set(holding.currency, rate);

    const quote = quotes[holding.instrumentId] ?? null;
    const matchingCurrency = quote?.currency === holding.currency;
    const lastPrice = matchingCurrency && finite(quote?.price) && quote.price >= 0 ? quote.price : null;
    const isOpen = holding.quantity > 0;
    if (isOpen && lastPrice === null) missingPrices.add(holding.instrumentId);

    // Ein geschlossener Bestand hat Wert 0 und benötigt dafür keinen Aktienkurs.
    const marketValue = !isOpen ? 0 : lastPrice === null ? null : holding.quantity * lastPrice;
    const unrealizedPnl = marketValue === null ? null : marketValue - holding.costBasis;
    const dayChange = !isOpen
      ? 0
      : matchingCurrency && finite(quote?.change)
        ? holding.quantity * quote.change
        : null;
    const inBase = (value: number | null): number | null =>
      factor === null || value === null ? null : value * factor;
    const marketValueBase = inBase(marketValue);
    const currentCostBasisBase = inBase(holding.costBasis);
    const { costBasisBase, realizedPnlBase, dividendsBase } = ledger;

    return {
      ...holding,
      quote,
      lastPrice,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent: percent(unrealizedPnl, holding.costBasis),
      dayChange,
      fxRate: rate,
      marketValueBase,
      costBasisBase,
      unrealizedPnlBase:
        marketValueBase === null || costBasisBase === null ? null : marketValueBase - costBasisBase,
      unrealizedFxEffectBase:
        currentCostBasisBase === null || costBasisBase === null ? null : currentCostBasisBase - costBasisBase,
      realizedPnlBase,
      dividendsBase,
      dayChangeBase: inBase(dayChange),
      weightPercent: null,
    };
  });

  const positions = allPositions.filter((position) => position.quantity > 0);
  const closedPositions = allPositions.filter(
    (position) => position.quantity === 0 && soldInstruments.has(position.instrumentId),
  );
  const valuedPositions = positions.filter((position) => position.marketValueBase !== null);
  const totalMarketValue = sumKnown(positions.map((position) => position.marketValueBase));
  const totalCostBasis = sumKnown(positions.map((position) => position.costBasisBase));
  const unrealizedPnl = sumKnown(positions.map((position) => position.unrealizedPnlBase));
  const valuedCostBasis = sumKnown(valuedPositions.map((position) => position.costBasisBase));
  const dayChange = sumKnown(
    positions.map((position) => (position.marketValueBase === null ? null : position.dayChangeBase)),
  );
  const previousMarketValue =
    totalMarketValue === null || dayChange === null ? null : totalMarketValue - dayChange;

  for (const position of positions) {
    position.weightPercent = percent(position.marketValueBase, totalMarketValue);
  }
  positions.sort((a, b) => {
    if (a.marketValueBase === null) return b.marketValueBase === null ? 0 : 1;
    if (b.marketValueBase === null) return -1;
    return b.marketValueBase - a.marketValueBase;
  });

  return {
    summary: {
      baseCurrency,
      totalMarketValue,
      totalCostBasis,
      unrealizedPnl,
      unrealizedPnlPercent: percent(unrealizedPnl, valuedCostBasis),
      unrealizedFxEffect: sumKnown(positions.map((position) => position.unrealizedFxEffectBase)),
      realizedPnl: sumKnown(allPositions.map((position) => position.realizedPnlBase)),
      dividends: sumKnown(allPositions.map((position) => position.dividendsBase)),
      dayChange,
      dayChangePercent: percent(dayChange, previousMarketValue),
      complete: missingPrices.size === 0 && missingFx.size === 0,
      missingPrices: [...missingPrices],
      missingFx: [...missingFx],
      fxRates: [...fxRates.values()],
      openPositionCount: positions.length,
    },
    positions,
    closedPositions,
  };
}
