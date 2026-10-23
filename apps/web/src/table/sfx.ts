import { useEffect, useRef } from 'react';
import type { TableView } from '@kb/game-core';
import { resolveFor, useSettings } from '../settings';

/**
 * Zvuky hry u stolu (rozdání, žetony, tah, upozornění na čas, výhra). Jsou syntetizované v prohlížeči, takže
 * nepotřebují žádné soubory, a každý jde zvlášť vypnout v osobním nastavení.
 */
export type Sfx = 'newHand' | 'dealCard' | 'flip' | 'chip' | 'check' | 'fold' | 'allIn' | 'turn' | 'timeBank' | 'win' | 'winMe' | 'rebuy' | 'addon' | 'knockout' | 'level' | 'bubble';

/** Které zvuky vzniknou přechodem mezi dvěma pohledy na stůl (čistá funkce, jde testovat). */
export function detectSfx(prev: TableView | null, next: TableView): Sfx[] {
  if (!prev) return [];
  const out: Sfx[] = [];
  const add = (s: Sfx) => {
    if (!out.includes(s)) out.push(s);
  };
  const sameHand = prev.handId === next.handId;
  if (next.handId && !sameHand) add('newHand');
  if (sameHand && next.board.length > prev.board.length) add('flip');
  for (const seat of next.seats) {
    const before = prev.seats.find((s) => s.seat === seat.seat);
    if (!before || !sameHand) continue;
    if (seat.status === 'allIn' && before.status !== 'allIn') add('allIn');
    else if (seat.bet > before.bet) add('chip');
    if (seat.status === 'folded' && before.status !== 'folded') add('fold');
    if (prev.actingSeat === seat.seat && next.actingSeat !== seat.seat && next.street === prev.street && seat.bet === before.bet && seat.status === before.status && seat.status !== 'folded') add('check');
  }
  if (!prev.winners && next.winners && next.winners.length > 0) add(next.viewerSeat !== null && next.winners.some((w) => w.seat === next.viewerSeat) ? 'winMe' : 'win');
  if (next.viewerSeat !== null && next.actingSeat === next.viewerSeat && prev.actingSeat !== next.actingSeat) add('turn');
  if (next.viewerSeat !== null && next.actingSeat === next.viewerSeat && next.bankActive && !prev.bankActive) add('timeBank');
  return out;
}

/** Sekundy do konce tahu, při kterých zazní upozornění: zadaná hranice a její polovina. */
export function warningMarks(warnSeconds: number): number[] {
  return [...new Set([Math.max(1, Math.round(warnSeconds)), Math.max(1, Math.round(warnSeconds / 2))])].sort((a, b) => b - a);
}

type Tone = { f: number; to?: number; at: number; len: number; gain: number; type?: OscillatorType };

/** Popis zvuků: tóny (frekvence, začátek a délka v sekundách) a šum (kliknutí, šustění). */
type Noise = { at: number; len: number; gain: number; freq: number };
const DEF: Record<Sfx | 'warning', { tones?: Tone[]; noise?: Noise; noises?: Noise[] }> = {
  // Zamíchání balíčku: rychlé šustění, které se zvedá (riffle), před rozdáním.
  newHand: { noises: Array.from({ length: 9 }, (_, i) => ({ at: i * 0.06, len: 0.07, gain: 0.22 + i * 0.01, freq: 1500 + i * 220 })) },
  // Jedna rozdaná karta: krátké sklouznutí po plátně.
  dealCard: { noise: { at: 0, len: 0.09, gain: 0.3, freq: 2200 } },
  flip: { noise: { at: 0, len: 0.07, gain: 0.3, freq: 2600 } },
  chip: { tones: [{ f: 2400, at: 0, len: 0.05, gain: 0.25, type: 'triangle' }, { f: 3100, at: 0.045, len: 0.05, gain: 0.2, type: 'triangle' }], noise: { at: 0, len: 0.03, gain: 0.2, freq: 4000 } },
  check: { tones: [{ f: 180, to: 110, at: 0, len: 0.09, gain: 0.5, type: 'sine' }] },
  fold: { noise: { at: 0, len: 0.16, gain: 0.25, freq: 900 } },
  allIn: { tones: [{ f: 392, at: 0, len: 0.14, gain: 0.3, type: 'triangle' }, { f: 523, at: 0.1, len: 0.14, gain: 0.3, type: 'triangle' }, { f: 659, at: 0.2, len: 0.3, gain: 0.3, type: 'triangle' }] },
  turn: { tones: [{ f: 880, at: 0, len: 0.12, gain: 0.35, type: 'sine' }, { f: 1319, at: 0.11, len: 0.25, gain: 0.35, type: 'sine' }] },
  timeBank: { tones: [{ f: 330, at: 0, len: 0.12, gain: 0.35, type: 'square' }, { f: 262, at: 0.14, len: 0.2, gain: 0.35, type: 'square' }] },
  win: { tones: [{ f: 523, at: 0, len: 0.12, gain: 0.3, type: 'triangle' }, { f: 659, at: 0.1, len: 0.12, gain: 0.3, type: 'triangle' }, { f: 784, at: 0.2, len: 0.2, gain: 0.3, type: 'triangle' }] },
  winMe: { tones: [{ f: 523, at: 0, len: 0.12, gain: 0.35, type: 'triangle' }, { f: 659, at: 0.1, len: 0.12, gain: 0.35, type: 'triangle' }, { f: 784, at: 0.2, len: 0.12, gain: 0.35, type: 'triangle' }, { f: 1047, at: 0.3, len: 0.4, gain: 0.35, type: 'triangle' }] },
  warning: { tones: [{ f: 1000, at: 0, len: 0.06, gain: 0.4, type: 'square' }] },
  // Události turnaje: rebuy cinknutí mincí, add-on vyšší trojtón, vyřazení hluboký úder, level zvonek, bublina gong.
  rebuy: { tones: [{ f: 1568, at: 0, len: 0.08, gain: 0.3, type: 'triangle' }, { f: 2093, at: 0.07, len: 0.22, gain: 0.3, type: 'triangle' }] },
  addon: { tones: [{ f: 1319, at: 0, len: 0.1, gain: 0.3, type: 'triangle' }, { f: 1760, at: 0.09, len: 0.1, gain: 0.3, type: 'triangle' }, { f: 2349, at: 0.18, len: 0.3, gain: 0.3, type: 'triangle' }] },
  knockout: { tones: [{ f: 160, to: 70, at: 0, len: 0.35, gain: 0.5, type: 'sine' }], noise: { at: 0, len: 0.12, gain: 0.25, freq: 600 } },
  level: { tones: [{ f: 988, at: 0, len: 0.4, gain: 0.3, type: 'sine' }, { f: 1319, at: 0.12, len: 0.5, gain: 0.25, type: 'sine' }] },
  bubble: { tones: [{ f: 196, at: 0, len: 0.9, gain: 0.45, type: 'sine' }, { f: 392, at: 0, len: 0.7, gain: 0.2, type: 'sine' }] },
};

let ctx: AudioContext | null = null;
let unlockHooked = false;

function context(): AudioContext | null {
  const Ctor = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (!unlockHooked) {
    unlockHooked = true;
    const resume = () => void ctx?.resume().catch(() => undefined);
    window.addEventListener('pointerdown', resume, { passive: true });
    window.addEventListener('keydown', resume, { passive: true });
  }
  return ctx;
}

/** Přehraje jeden zvuk s danou hlasitostí (0 až 1). */
/** Sady zvuků u stolu: klasická, jemná (sinusové tóny), retro (čtvercová vlna), kasino (jiskřivé žetony a výhry), dřevo (tupé klepání). */
export const SFX_THEMES = ['classic', 'soft', 'retro', 'casino', 'wood'] as const;
export type SfxTheme = (typeof SFX_THEMES)[number];

type Def = { tones?: Tone[]; noise?: Noise; noises?: Noise[] };
const scale = (d: Def, o: { type?: OscillatorType; tone: number; noise: number; freq?: number }): Def => ({
  tones: d.tones?.map((x) => ({ ...x, type: o.type ?? x.type, gain: x.gain * o.tone })),
  noise: d.noise && { ...d.noise, gain: d.noise.gain * o.noise, freq: d.noise.freq * (o.freq ?? 1) },
  noises: d.noises?.map((x) => ({ ...x, gain: x.gain * o.noise, freq: x.freq * (o.freq ?? 1) })),
});
const CASINO: Partial<Record<Sfx | 'warning', Def>> = {
  chip: { tones: [2637, 3136, 3951, 3136, 4186].map((f, i) => ({ f, at: i * 0.035, len: 0.06, gain: 0.2, type: 'triangle' as const })), noise: { at: 0, len: 0.03, gain: 0.15, freq: 5000 } },
  win: { tones: [784, 988, 1175, 1568, 1976].map((f, i) => ({ f, at: i * 0.07, len: 0.18, gain: 0.25, type: 'triangle' as const })) },
  winMe: { tones: [784, 988, 1175, 1568, 1976, 2349].map((f, i) => ({ f, at: i * 0.08, len: i === 5 ? 0.5 : 0.2, gain: 0.3, type: 'triangle' as const })) },
  check: { tones: [{ f: 1200, at: 0, len: 0.04, gain: 0.3, type: 'square' }] },
};
const WOOD: Partial<Record<Sfx | 'warning', Def>> = {
  check: { tones: [{ f: 240, to: 150, at: 0, len: 0.06, gain: 0.5, type: 'triangle' }], noise: { at: 0, len: 0.025, gain: 0.3, freq: 700 } },
  chip: { tones: [{ f: 900, to: 700, at: 0, len: 0.03, gain: 0.3, type: 'sine' }, { f: 1100, to: 800, at: 0.05, len: 0.03, gain: 0.25, type: 'sine' }], noise: { at: 0, len: 0.02, gain: 0.25, freq: 1500 } },
  fold: { noise: { at: 0, len: 0.12, gain: 0.2, freq: 500 } },
  dealCard: { noise: { at: 0, len: 0.06, gain: 0.3, freq: 1200 } },
};

/** Zvuk podle zvolené sady. */
function defFor(name: Sfx | 'warning'): Def {
  const theme = String((resolveFor().values as Record<string, unknown>)['ui.sfxTheme'] ?? 'classic');
  const base = DEF[name];
  if (theme === 'soft') return scale(base, { type: 'sine', tone: 0.7, noise: 0.8, freq: 0.6 });
  if (theme === 'retro') return scale(base, { type: 'square', tone: 0.55, noise: 0.7 });
  if (theme === 'casino') return CASINO[name] ?? base;
  if (theme === 'wood') return WOOD[name] ?? scale(base, { type: 'sine', tone: 0.7, noise: 0.8, freq: 0.6 });
  return base;
}

export function playSfx(name: Sfx | 'warning', volume: number): void {
  const c = context();
  if (!c || volume <= 0) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const def = defFor(name);
  const t0 = c.currentTime + 0.01;
  for (const tone of def.tones ?? []) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = tone.type ?? 'sine';
    osc.frequency.setValueAtTime(tone.f, t0 + tone.at);
    if (tone.to) osc.frequency.exponentialRampToValueAtTime(tone.to, t0 + tone.at + tone.len);
    g.gain.setValueAtTime(0.0001, t0 + tone.at);
    g.gain.exponentialRampToValueAtTime(tone.gain * volume, t0 + tone.at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.at + tone.len);
    osc.connect(g).connect(c.destination);
    osc.start(t0 + tone.at);
    osc.stop(t0 + tone.at + tone.len + 0.02);
  }
  for (const n of def.noises ?? (def.noise ? [def.noise] : [])) {
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * n.len)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = n.freq;
    const g = c.createGain();
    g.gain.setValueAtTime(n.gain * volume, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t0 + n.at);
  }
}

const SETTING: Record<Sfx | 'warning', string> = {
  newHand: 'ui.sfxDeal',
  dealCard: 'ui.sfxDeal',
  flip: 'ui.sfxDeal',
  chip: 'ui.sfxChip',
  check: 'ui.sfxAction',
  fold: 'ui.sfxAction',
  allIn: 'ui.sfxAllIn',
  turn: 'ui.sfxTurn',
  timeBank: 'ui.sfxWarning',
  warning: 'ui.sfxWarning',
  win: 'ui.sfxWin',
  winMe: 'ui.sfxWin',
  rebuy: 'ui.sfxEvents',
  addon: 'ui.sfxEvents',
  knockout: 'ui.sfxEvents',
  level: 'ui.sfxEvents',
  bubble: 'ui.sfxEvents',
};

const VIBRATE: Partial<Record<Sfx | 'warning', number[]>> = { turn: [120], warning: [80], timeBank: [80, 60, 80] };

/** Zvuky a vibrace u stolu podle změn pohledu a podle času zbývajícího na tahu. */
export function useTableSfx(view: TableView | undefined, clockOffset: number): void {
  const settings = useSettings();
  const values = settings.values;
  const prev = useRef<TableView | null>(null);
  const warned = useRef<{ deadline: number | null; marks: Set<number> }>({ deadline: null, marks: new Set() });
  const cfg = useRef(values);
  cfg.current = values;

  const fire = (name: Sfx | 'warning') => {
    const v = cfg.current;
    if (v['ui.sfxEnabled'] === false || v[SETTING[name]] === false) return;
    playSfx(name, Number(v['ui.sfxVolumePercent'] ?? 60) / 100);
    const pattern = VIBRATE[name];
    if (pattern && v['ui.vibrate'] !== false && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
  };

  useEffect(() => {
    if (!view) return;
    for (const s of detectSfx(prev.current, view)) fire(s);
    prev.current = view;
  }, [view]);

  const deadline = view?.deadline ?? null;
  const myTurn = !!view && view.viewerSeat !== null && view.actingSeat === view.viewerSeat;
  useEffect(() => {
    if (!myTurn || deadline === null) return;
    if (warned.current.deadline !== deadline) warned.current = { deadline, marks: new Set() };
    const id = window.setInterval(() => {
      const left = Math.ceil((deadline - (Date.now() + clockOffset)) / 1000);
      for (const mark of warningMarks(Number(cfg.current['ui.warnSeconds'] ?? 10))) {
        if (left <= mark && left > 0 && !warned.current.marks.has(mark)) {
          warned.current.marks.add(mark);
          fire('warning');
        }
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [myTurn, deadline, clockOffset]);
}

/** Zvuk události mimo hook stolu (např. rebuy): respektuje zapnutí zvuků, hlasitost a zvuky událostí. */
export function fireSfx(name: Sfx): void {
  const v = resolveFor().values as Record<string, unknown>;
  if (v['ui.sfxEnabled'] === false || v[SETTING[name]] === false) return;
  playSfx(name, Number(v['ui.sfxVolumePercent'] ?? 60) / 100);
}
