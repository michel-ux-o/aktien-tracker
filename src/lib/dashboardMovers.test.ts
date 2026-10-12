import { describe, expect, it } from 'vitest';
import { dashboardMovers } from './dashboardMovers';

const position = (id: string, change: number | null, lastPrice: number | null = 100) => ({
  id,
  lastPrice,
  unrealizedPnlPercent: change,
});

describe('dashboardMovers', () => {
  it('ranks strictly positive and negative returns independently and excludes neutral or unavailable returns', () => {
    const positions = [
      position('gain', 10), position('loss', -10), position('flat', 0),
      position('missing', null, null), position('invalid', Number.NaN),
      position('infinite', Number.POSITIVE_INFINITY), position('big-gain', 30),
      position('big-loss', -30), position('small-gain', 5), position('tiny-gain', 1),
    ];
    const original = [...positions];

    const winners = dashboardMovers(positions, 'winners').positions;
    const losers = dashboardMovers(positions, 'losers').positions;

    expect(winners.map(({ id }) => id)).toEqual(['big-gain', 'gain', 'small-gain']);
    expect(losers.map(({ id }) => id)).toEqual(['big-loss', 'loss']);
    expect(winners.some((winner) => losers.includes(winner))).toBe(false);
    expect(positions).toEqual(original);
  });

  it('explains absent gains or losses without claiming complete prices are missing', () => {
    expect(dashboardMovers([position('gain', 10), position('flat', 0)], 'losers')).toEqual({
      positions: [], emptyMessage: 'Aktuell liegt keine Position im Verlust.',
    });
    expect(dashboardMovers([position('loss', -10), position('flat', 0)], 'winners')).toEqual({
      positions: [], emptyMessage: 'Aktuell liegt keine Position im Gewinn.',
    });
    expect(dashboardMovers([], 'losers').emptyMessage).toBe('Aktuell liegt keine Position im Verlust.');
  });

  it('reports missing prices when an unknown return prevents a complete assessment', () => {
    expect(dashboardMovers([position('gain', 10), position('missing', null, null)], 'losers')).toEqual({
      positions: [],
      emptyMessage: 'Eine vollständige Auswertung ist aktuell nicht möglich, da Kursdaten fehlen.',
    });
  });

  it('distinguishes unavailable percentages with known prices from missing prices', () => {
    expect(dashboardMovers([position('zero-basis', null)], 'winners')).toEqual({
      positions: [],
      emptyMessage: 'Für mindestens eine Position ist der prozentuale Gewinn/Verlust nicht berechenbar.',
    });
  });
});
