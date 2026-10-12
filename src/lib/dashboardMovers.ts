import type { Position } from '@shared/types';

type MoverPosition = Pick<Position, 'lastPrice' | 'unrealizedPnlPercent'>;
type MoverDirection = 'winners' | 'losers';

export function dashboardMovers<T extends MoverPosition>(positions: T[], direction: MoverDirection) {
  const winners = direction === 'winners';
  const ranked = positions.filter((position) => {
    const change = position.unrealizedPnlPercent;
    return change !== null && Number.isFinite(change) && (winners ? change > 0 : change < 0);
  }).sort((a, b) => winners
    ? (b.unrealizedPnlPercent ?? 0) - (a.unrealizedPnlPercent ?? 0)
    : (a.unrealizedPnlPercent ?? 0) - (b.unrealizedPnlPercent ?? 0));

  let emptyMessage = winners
    ? 'Aktuell liegt keine Position im Gewinn.'
    : 'Aktuell liegt keine Position im Verlust.';
  if (positions.some((position) => position.lastPrice === null || !Number.isFinite(position.lastPrice))) {
    emptyMessage = 'Eine vollständige Auswertung ist aktuell nicht möglich, da Kursdaten fehlen.';
  } else if (positions.some((position) => position.unrealizedPnlPercent === null || !Number.isFinite(position.unrealizedPnlPercent))) {
    emptyMessage = 'Für mindestens eine Position ist der prozentuale Gewinn/Verlust nicht berechenbar.';
  }

  return { positions: ranked.slice(0, 3), emptyMessage };
}
