import { describe, expect, it } from 'vitest';
import { dialogTop } from './dialog-place';

const base = { roomHeight: 400, boardTop: 150, boardBottom: 250, dialogHeight: 100, spaceBelow: 0, spaceAbove: 0, gap: 6 };

describe('umístění rozhodovacího okna u stolu', () => {
  it('když se vejde nad karty, leží těsně nad nimi', () => {
    expect(dialogTop(base)).toBe(44);
  });

  it('když se nad karty nevejde, ale vejde se pod ně, leží těsně pod nimi', () => {
    expect(dialogTop({ ...base, boardTop: 60, boardBottom: 160 })).toBe(166);
  });

  it('na malém stole, kde nad ani pod kartami není místo, vyčnívá pod stůl, je-li v okně prohlížeče místo', () => {
    expect(dialogTop({ ...base, roomHeight: 220, boardTop: 70, boardBottom: 150, spaceBelow: 300 })).toBe(226);
  });

  it('bez místa pod stolem vyčnívá nad stůl', () => {
    expect(dialogTop({ ...base, roomHeight: 220, boardTop: 70, boardBottom: 150, spaceBelow: 20, spaceAbove: 200 })).toBe(-106);
  });

  it('když se nevejde nikam, zakryje co nejméně karet', () => {
    // nahoře by přesah byl 100 − 70 = 30, dole 150 − (220 − 100) = 30: remíza se řeší nahoru
    expect(dialogTop({ ...base, roomHeight: 220, boardTop: 70, boardBottom: 150 })).toBe(0);
    // karty u horního okraje: lépe dole
    expect(dialogTop({ ...base, roomHeight: 160, boardTop: 20, boardBottom: 100 })).toBe(60);
  });

  it('okno nikdy nezakryje karty, když existuje volba, která je nezakrývá', () => {
    for (const boardTop of [10, 60, 120, 200]) {
      const input = { ...base, roomHeight: 400, boardTop, boardBottom: boardTop + 100, spaceBelow: 500, spaceAbove: 500 };
      const top = dialogTop(input);
      const bottom = top + input.dialogHeight;
      expect(bottom <= boardTop || top >= boardTop + 100).toBe(true);
    }
  });
});
