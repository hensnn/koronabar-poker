import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8');

describe('třídy vzhledu', () => {
  it('obecné prvky (karta, tlačítko, tabulka, okno) nepoužívají třídy herního stolu, které by změnily jejich rozměry', () => {
    // Třída .tk-card je herní karta; obecná karta rozhraní má vlastní třídu (kd-card).
    expect(ui).not.toMatch(/["'`\s]tk-(card|seat|act|slot)\b/);
  });
  it('třídy hustoty zobrazení jsou v CSS definované právě jednou a používané v prvcích rozhraní', () => {
    for (const cls of ['kd-card', 'kd-modal', 'kd-cell', 'kd-btn', 'kd-row', 'kd-page']) {
      const defs = css.match(new RegExp('\\.' + cls + '\\s*\\{', 'g')) ?? [];
      expect(defs.length, cls).toBe(1);
    }
    for (const cls of ['kd-card', 'kd-btn', 'kd-cell', 'kd-modal']) expect(ui, cls).toContain(cls);
  });
});
