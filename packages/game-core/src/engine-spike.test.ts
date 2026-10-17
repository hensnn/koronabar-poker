import { describe, it, expect } from 'vitest';
import { PokerEngine, ActionType } from '@pokertools/engine';

function table(stacks: number[]) {
  const e = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 9 });
  stacks.forEach((s, i) => e.sit(i, `p${i}`, `P${i}`, s));
  e.deal();
  return e;
}
function total(e: PokerEngine) {
  const s: any = e.state;
  return s.players.reduce((a: number, p: any) => a + (p ? p.stack + (p.betThisRound ?? 0) : 0), 0)
    + s.pots.reduce((a: number, p: any) => a + p.amount, 0);
}

describe('spike: @pokertools/engine', () => {
  it('maskuje cizí karty a deck není ve view', () => {
    const e = table([1000, 1000, 1000]);
    const v: any = e.view('p0');
    const json = JSON.stringify(v);
    const own = (e.state as any).players.find((p: any) => p?.id === 'p0').hand;
    const other = (e.state as any).players.find((p: any) => p?.id === 'p1').hand;
    for (const c of own) expect(json).toContain(`"${c}"`);
    for (const c of other) expect(json).not.toContain(`"${c}"`);
    expect(v.deck === undefined || v.deck.length === 0).toBe(true);
    const spec = JSON.stringify(e.view());
    for (const c of own) expect(spec).not.toContain(`"${c}"`);
  });

  it('side poty při třech all-inech s různými stacky', () => {
    const e = table([100, 300, 600]);
    const s: any = e.state;
    let guard = 0;
    while (s && (e.state as any).street !== 'SHOWDOWN' && !(e.state as any).winners && guard++ < 30) {
      const st: any = e.state;
      if (st.actionTo === null || st.actionTo === undefined) break;
      const pid = st.players[st.actionTo].id;
      try { e.act({ type: ActionType.RAISE, playerId: pid, amount: 10000 } as any); }
      catch { e.act({ type: ActionType.CALL, playerId: pid } as any); }
    }
    const st: any = e.state;
    const winners = st.winners ?? [];
    const paid = winners.reduce((a: number, w: any) => a + w.amount, 0);
    // 100*3 + 200*2 = 700 do potů, nevyrovnaných 300 se vrací největšímu stacku
    expect(paid).toBe(700);
    const stacks = st.players.reduce((a: number, p: any) => a + (p ? p.stack : 0), 0);
    expect(stacks).toBe(1000);
  });

  it('snapshot a restore zachová stav', () => {
    const e = table([500, 500]);
    const snap = JSON.parse(JSON.stringify(e.snapshot));
    const r = PokerEngine.restore(snap);
    expect((r.state as any).actionTo).toBe((e.state as any).actionTo);
    expect((r.state as any).street).toBe('PREFLOP');
  });

  it('lze dodat vlastní RNG', () => {
    let calls = 0;
    const e = new PokerEngine({ smallBlind: 5, bigBlind: 10, randomProvider: () => { calls++; return 0.5; } } as any);
    e.sit(0, 'a', 'A', 100); e.sit(1, 'b', 'B', 100);
    e.deal();
    expect(calls).toBeGreaterThan(0);
  });
});
