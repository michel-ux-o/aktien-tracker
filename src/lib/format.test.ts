import { describe, expect, it } from 'vitest';
import { formatSplitRatio, formatTransactionType } from './format';

describe('Transaktionsbezeichnungen', () => {
  it('benennt alle vier Arten auf Deutsch', () => {
    expect(['BUY', 'SELL', 'DIVIDEND', 'SPLIT'].map((type) => formatTransactionType(type as Parameters<typeof formatTransactionType>[0])))
      .toEqual(['Kauf', 'Verkauf', 'Dividende', 'Split']);
  });
});

describe('Split-Verhältnis', () => {
  it('zeigt Splits und einfache Zusammenlegungen', () => {
    expect(formatSplitRatio(4)).toBe('4 : 1');
    expect(formatSplitRatio(0.1)).toBe('1 : 10');
    expect(formatSplitRatio(0.0001)).toBe('1 : 10.000');
  });

  it('behält die Genauigkeit bei nicht ganzzahligen Verhältnissen', () => {
    expect(formatSplitRatio(0.3)).toBe('0,3 : 1');
    expect(formatSplitRatio(0.00012345)).toBe('0,00012345 : 1');
    expect(formatSplitRatio(1.23456789)).toBe('1,23456789 : 1');
  });

  it('kennzeichnet fehlende oder ungültige Verhältnisse', () => {
    for (const ratio of [null, undefined, NaN, Infinity, 0, -1]) {
      expect(formatSplitRatio(ratio)).toBe('Nicht verfügbar');
    }
  });
});
