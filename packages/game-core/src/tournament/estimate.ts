import { CashService, Ledger, TournamentMoney } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from '../bot.js';
import { FakeClock } from '../clock.js';
import { TableActor } from '../table-actor.js';
import { Tournament } from './tournament.js';

export interface Estimate {
  /** Medián délky v minutách (virtuální čas), null = turnaj se v limitu nedohrál. */
  minutes: number | null;
  /** Nejkratší a nejdelší z běhů. */
  range: [number, number] | null;
  /** Kolik levelů se v mediánu odehrálo. */
  levels: number | null;
  runs: number;
  finished: number;
}

export interface EstimateOptions {
  players: number;
  runs?: number;
  /** Kolik sekund trvá hráči jeden tah (lidé jsou pomalejší než boti). */
  thinkSeconds?: number;
  /** Strop virtuálního času jednoho běhu v hodinách. */
  maxHours?: number;
  seed?: number;
}

/**
 * Orientační odhad délky turnaje simulací s boty ve virtuálním čase. Boti hrají náhodně legální tahy
 * (agresivněji než většina domácích hráčů), takže skutečný turnaj obvykle trvá o něco déle.
 * Výplatní a poplatkové nastavení se zjednodušuje (rebuy, add-on ani re-entry se nesimulují).
 */
export function estimateTournament(settings: SettingValues, opt: EstimateOptions): Estimate {
  const runs = opt.runs ?? 3;
  const think = (opt.thinkSeconds ?? 6) * 1000;
  const maxMs = (opt.maxHours ?? 12) * 3600_000;
  const results: { minutes: number; levels: number }[] = [];
  const base: SettingValues = {
    ...settings,
    'time.betweenHandsMs': 1500,
    'time.showdownMs': 2000,
    'time.potToWinnerMs': 1000,
    'odds.enabled': false,
    'tournament.rebuyEnabled': false,
    'tournament.addonEnabled': false,
    'tournament.reentryEnabled': false,
    'tournament.guarantee': 0,
    'tournament.houseCutPercent': 0,
    'tournament.fundPercent': 0,
    'tournament.fee': 0,
    'tournament.buyIn': 0,
    'tournament.autoStartWhenFull': false,
  };
  for (let r = 0; r < runs; r++) {
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const money = new TournamentMoney(ledger);
    const rnd = seededRandom((opt.seed ?? 7) + r * 101);
    const tour = new Tournament({ id: 'est', settings: () => ({ ...base, 'tournament.minPlayers': Math.min(opt.players, Number(base['tournament.minPlayers'])) }), clock, money });
    const table = new TableActor({
      tableId: 'est',
      tournament: true,
      settings: () => tour.tableSettings(),
      clock,
      cash,
      randomProvider: seededRandom((opt.seed ?? 7) + r * 977 + 1),
      onEvent: (e) => tour.onTableEvent(e),
    });
    tour.attachTable(table);
    for (let i = 0; i < opt.players; i++) tour.register(`p${i}`, `P${i}`);
    const t0 = clock.now();
    tour.start();
    let steps = 0;
    while (tour.state().status === 'running' && clock.now() - t0 < maxMs && steps++ < 400_000) {
      const v = table.viewFor(null);
      if (table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat);
        const legal = p ? table.viewFor(p.playerId).legal : null;
        if (p && legal) table.act(p.playerId, randomLegalAction(legal, rnd));
        clock.advance(think);
      } else {
        clock.advance(500);
      }
    }
    if (tour.state().status === 'finished') results.push({ minutes: (clock.now() - t0) / 60_000, levels: tour.levelNumber() });
    tour.stop();
  }
  if (results.length === 0) return { minutes: null, range: null, levels: null, runs, finished: 0 };
  const sorted = [...results].sort((a, b) => a.minutes - b.minutes);
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  return { minutes: Math.round(mid.minutes), range: [Math.round(sorted[0]!.minutes), Math.round(sorted[sorted.length - 1]!.minutes)], levels: mid.levels, runs, finished: results.length };
}
