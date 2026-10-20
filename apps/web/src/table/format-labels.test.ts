import { describe, expect, it } from 'vitest';
import type { TableInfo } from '@kb/game-core';
import { formatAmount, setTableFormat } from './format';

const info = { tournament: false, bigBlind: 20, chipsPerCurrencyUnit: 1, currencyDecimals: 0, chipLabel: '$', currencyForms: ['Korona', 'Korony', 'Koron'] } as unknown as TableInfo;

describe('částky u stolu: název měny a označení žetonů', () => {
  it('každé se vypíná zvlášť a obojí pryč nechá jen číslo', () => {
    setTableFormat({ symbol: true, chipLabel: true });
    expect(formatAmount(500, info, false)).toBe('500 Koron $');
    setTableFormat({ symbol: false, chipLabel: true });
    expect(formatAmount(500, info, false)).toBe('500 $');
    setTableFormat({ symbol: true, chipLabel: false });
    expect(formatAmount(500, info, false)).toBe('500 Koron');
    setTableFormat({ symbol: false, chipLabel: false });
    expect(formatAmount(500, info, false)).toBe('500');
    expect(formatAmount(500, { ...info, tournament: true } as TableInfo, false)).toBe('500');
  });
});
