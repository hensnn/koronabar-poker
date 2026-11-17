import { formatLocal, t } from '@kb/shared';
import type { ResolvedTokens } from '@kb/tokens';

/**
 * Summary pictures for Discord (end of a tournament, game evening). The picture is the same view the players see
 * in the app (the "tournament finished" window and the evening page), drawn as SVG from the theme's design tokens and
 * then rasterised to PNG: same columns, same numbers, same awards, same cards. It is as wide as its widest table needs.
 * Only data everybody in the app may see goes in (results, money movements of the game, cards shown at showdown).
 */

export interface PictureStyle {
  /** Smallest width in px; text and spacing scale with it. The picture grows when a table needs more room. */
  width: number;
  /** Most table rows; the rest collapses into one "and N more" line. */
  maxRows: number;
  /** Show money amounts (payouts, profit, pots); off = counts and places only. */
  amounts: boolean;
  tokens: ResolvedTokens;
  timeZone: string;
}

/** One line of the tournament result table (same fields as the summary the players get after the tournament). */
export interface TournamentRow {
  place: number;
  name: string;
  entries: number;
  entryAmount: number;
  rebuys: number;
  rebuyAmount: number;
  addons: number;
  addonAmount: number;
  spent: number;
  payout: number;
  bounty: number;
  headEarned?: number;
  headLost?: number;
  betNet?: number;
  profit: number;
}

export interface TournamentPictureData {
  name: string;
  summary: TournamentRow[];
}

export interface HandPicture {
  board: string[];
  players: { nickname: string; hole: [string, string] | null; role: 'loser' | 'winner' | 'best'; five: string[] | null; desc: { key: string; params?: Record<string, string> } | null }[];
}

export interface EveningPictureData {
  name: string;
  from: number;
  to: number;
  players: { nickname: string; net: number; cash: number; tournament: number; side: number; knockouts: number; parts: Record<string, number>; seated?: number }[];
  games: { kind: 'tournament' | 'live_cash' | 'cash'; name: string }[];
  mvp: { nickname: string; score: number } | null;
  hunter: { nickname: string; count: number } | null;
  banker: { nickname: string; game: string; bb: number; amount: number } | null;
  badBeat: { nickname: string; game: string; equity: number; hand: HandPicture | null } | null;
  bestHand: { nickname: string; game: string; hand: HandPicture } | null;
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
}

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
/** Text safe for SVG: no characters XML forbids, markup escaped. */
export const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (ch) => XML[ch]!);
const clip = (s: string, n: number) => {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
};
const pxOf = (v: string | undefined) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v ?? '');
  return m ? Number(m[1]) : 0;
};
/** Thousands separators as plain spaces: the server font need not have the narrow no-break space. */
const plain = (s: string) => s.replace(/[   ]/g, ' ');
const r1 = (n: number) => Math.round(n * 10) / 10;

type Tone = 'text' | 'textMuted' | 'primary' | 'secondary' | 'success' | 'danger' | 'warning';
type FontKind = 'body' | 'heading' | 'number';
interface TextOpts {
  size: number;
  tone?: Tone;
  font?: FontKind;
  bold?: boolean;
  anchor?: 'start' | 'end' | 'middle';
  fill?: string;
}

// ---------- text width ----------

/**
 * Width of a text in the layout, estimated per character class. The layout needs it before anything is drawn (column widths,
 * wrapping); the estimate is a little generous so text never runs into its neighbour, whichever font the server ends up with.
 */
export function textWidth(s: string, size: number, font: FontKind = 'body', bold = false): number {
  let em = 0;
  for (const ch of s) {
    if (font === 'number') em += 0.62;
    else if (/[ .,:;'|!iIjl()[\]]/.test(ch)) em += ch === ' ' ? 0.3 : 0.32;
    else if (/[frt\-–−/\\×·]/.test(ch)) em += 0.45;
    else if (/[mwMW@%]/.test(ch)) em += 0.88;
    else if (/[0-9]/.test(ch)) em += 0.58;
    else if (/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(ch)) em += 0.68;
    else em += 0.57;
  }
  return em * size * (bold || font === 'heading' ? 1.08 : 1) * 1.04;
}

/** Breaks a text into lines no wider than `max`; a single word wider than that stays on its own line. */
function wrap(text: string, max: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size, 'body', bold) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------- a table ----------

interface Cell {
  text: string;
  tone?: Tone;
  bold?: boolean;
  /** Result column: raised background, bigger bold figure, aligned to the right (the profit of the evening). */
  result?: boolean;
  /** Small badge after the text ("at the table"). */
  badge?: string;
}
interface Col {
  label: string;
  mono?: boolean;
  /** Takes the room the picture has left over. */
  grow?: boolean;
  end?: boolean;
}

const BADGE_SIZE = 0.65;

/** Natural width of every column: the widest of its label and cells plus padding. */
function columnWidths(u: number, cols: Col[], rows: Cell[][]): number[] {
  return cols.map((c, i) => {
    let w = textWidth(c.label, u * 0.9);
    for (const row of rows) {
      const cell = row[i];
      if (!cell) continue;
      const size = u * (cell.result ? 1.15 : 0.9);
      let cw = textWidth(cell.text, size, c.mono ? 'number' : 'body', cell.bold || cell.result);
      if (cell.badge) cw += u * 0.4 + textWidth(cell.badge, u * BADGE_SIZE) + u * 0.8;
      w = Math.max(w, cw);
    }
    return w + u * 1.6;
  });
}

const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);

/** A sheet that grows downwards: parts are appended at the running `y`, the height is known at the end. */
class Sheet {
  /** Layout unit: every size and gap is a multiple of it, so the picture scales with the width setting. */
  readonly u: number;
  y = 0;
  private parts: string[] = [];

  constructor(readonly st: PictureStyle, readonly width: number) {
    this.u = st.width / 45;
  }

  color(key: string) {
    return esc(this.st.tokens[`color.${key}`] ?? '');
  }
  private radius(factor = 1) {
    return r1(((pxOf(this.st.tokens['shape.radiusMd']) * this.u) / (pxOf(this.st.tokens['size.textBase']) || 1)) * factor);
  }
  private family(font: FontKind) {
    return esc(this.st.tokens[`font.${font}`] ?? '');
  }

  text(x: number, y: number, value: string, o: TextOpts) {
    const tk = this.st.tokens;
    const font = o.font ?? 'body';
    const weight = o.bold || font === 'heading' ? tk['font.weightHeading'] : tk['font.weightBody'];
    this.parts.push(
      `<text x="${r1(x)}" y="${r1(y)}" font-family="${this.family(font)}" font-size="${r1(o.size)}" font-weight="${esc(String(weight ?? ''))}" fill="${o.fill ?? this.color(o.tone ?? 'text')}"${o.anchor === 'end' ? ' text-anchor="end"' : o.anchor === 'middle' ? ' text-anchor="middle"' : ''}>${esc(value)}</text>`,
    );
  }
  box(x: number, y: number, w: number, h: number, fill: string, border: string | false = false, radius = 1) {
    this.parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${this.radius(radius)}" fill="${this.color(fill)}"${border ? ` stroke="${this.color(border)}" stroke-width="1"` : ''}/>`);
  }
  hline(x: number, y: number, w: number) {
    this.parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="1" fill="${this.color('border')}"/>`);
  }
  /** Position in the drawing, to put a panel behind what is drawn after it. */
  markPosition(): number {
    return this.parts.length;
  }
  insertBehind(at: number, svg: string) {
    this.parts.splice(at, 0, svg);
  }
  radiusOf(factor = 1) {
    return this.radius(factor);
  }

  /** Data table as the app draws it: muted header with a line under it, one line under every row. Returns when finished at `y`. */
  table(x: number, w: number, cols: Col[], rows: Cell[][], natural: number[]) {
    const u = this.u;
    const extra = Math.max(0, w - sum(natural));
    const growers = cols.filter((c) => c.grow).length || 1;
    const widths = natural.map((n, i) => n + (cols[i]!.grow || (!cols.some((c) => c.grow) && i === 1) ? extra / growers : 0));
    const xs = widths.map((_, i) => x + sum(widths.slice(0, i)));
    const headH = u * 2.1;
    cols.forEach((c, i) => {
      const cx = c.end ? xs[i]! + widths[i]! - u * 0.8 : xs[i]! + u * 0.8;
      this.text(cx, this.y + u * 1.4, c.label, { size: u * 0.9, tone: 'textMuted', bold: true, anchor: c.end ? 'end' : 'start' });
    });
    this.y += headH;
    this.hline(x, this.y, w);
    const rowH = u * 2.4;
    for (const row of rows) {
      row.forEach((cell, i) => {
        const col = cols[i]!;
        const size = u * (cell.result ? 1.15 : 0.9);
        if (cell.result) this.box(xs[i]!, this.y + 1, widths[i]!, rowH - 1, 'surfaceRaised', false, 0);
        const end = col.end || cell.result;
        const cx = end ? xs[i]! + widths[i]! - u * 0.8 : xs[i]! + u * 0.8;
        this.text(cx, this.y + u * 1.55, cell.text, { size, tone: cell.tone, font: col.mono ? 'number' : 'body', bold: cell.bold || cell.result, anchor: end ? 'end' : 'start' });
        if (cell.badge) {
          const bs = u * BADGE_SIZE;
          const bw = textWidth(cell.badge, bs) + u * 0.8;
          const bx = cx + (end ? -textWidth(cell.text, size, col.mono ? 'number' : 'body', true) - u * 0.4 - bw : textWidth(cell.text, size, col.mono ? 'number' : 'body', cell.bold) + u * 0.4);
          this.box(bx, this.y + u * 0.55, bw, u * 1.3, 'warning', false, 0.5);
          this.text(bx + bw / 2, this.y + u * 1.45, cell.badge, { size: bs, fill: this.color('onPrimary'), anchor: 'middle' });
        }
      });
      this.y += rowH;
      this.hline(x, this.y, w);
    }
  }

  /** The "and N more" line under a cut table. */
  more(x: number, hidden: number) {
    if (hidden <= 0) return;
    this.y += this.u * 0.4;
    this.text(x + this.u * 0.8, this.y + this.u * 1.2, t('integration.picture.more', { n: hidden }), { size: this.u * 0.85, tone: 'textMuted' });
    this.y += this.u * 1.8;
  }

  /** A card (white panel of the page) with its title; `body` draws the content from the returned y. Height follows the content. */
  card(x: number, w: number, title: string, body: (innerX: number, innerW: number) => void) {
    const u = this.u;
    const top = this.y;
    const pad = u * 1.2;
    const at = this.parts.length;
    this.y += pad;
    this.text(x + pad, this.y + u * 1.1, title, { size: u * 1.25, font: 'heading' });
    this.y += u * 2.3;
    body(x + pad, w - pad * 2);
    this.y += pad;
    // the panel goes behind what was drawn into it
    this.parts.splice(at, 0, `<rect x="${r1(x)}" y="${r1(top)}" width="${r1(w)}" height="${r1(this.y - top)}" rx="${this.radius(1.5)}" fill="${this.color('surface')}" stroke="${this.color('border')}" stroke-width="1"/>`);
  }

  /** Playing card as in the app: face colour, rank on top and the suit under it in the colour of the suit. */
  card1(x: number, y: number, card: string, marked: boolean) {
    const u = this.u;
    const w = u * 2.1;
    const h = u * 2.9;
    const rank = card[0] === 'T' ? '10' : (card[0] ?? '?');
    const suit = card[1] ?? '?';
    const ink = this.color(suit === 'h' ? 'suitHeart' : suit === 'd' ? 'suitDiamond' : suit === 'c' ? 'suitClub' : 'suitSpade');
    this.parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(u * 0.25)}" fill="${this.color('cardFace')}" stroke="${marked ? this.color('primary') : this.color('border')}" stroke-width="${marked ? 2.5 : 1}"/>`);
    this.text(x + w / 2, y + h * 0.46, rank, { size: u * (rank.length > 1 ? 0.95 : 1.1), font: 'number', bold: true, fill: ink, anchor: 'middle' });
    this.parts.push(suitShape(suit, x + w / 2, y + h * 0.74, u * 0.95, ink));
  }

  /** Row of cards; returns the width it took. */
  cards(x: number, y: number, cards: string[], marked: string[] = []): number {
    const step = this.u * 2.4;
    cards.forEach((c, i) => this.card1(x + i * step, y, c, marked.includes(c)));
    return cards.length * step;
  }

  svg(background: boolean): string {
    const w = this.width;
    const h = Math.ceil(this.y);
    const stripe = r1(this.u * 0.3);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${this.color('bg')}"/>${background ? `<rect width="${w}" height="${stripe}" fill="${this.color('primary')}"/>` : ''}${this.parts.join('')}</svg>`;
  }
}

/** Suit symbol drawn as a shape (no font needed): `size` is its height, centred on (cx, cy). */
function suitShape(suit: string, cx: number, cy: number, size: number, fill: string): string {
  const x0 = cx - size / 2;
  const y0 = cy - size / 2;
  const p = (v: number, off: number) => r1(off + v * size);
  const path = (pts: string) => pts.replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_m, a, b) => `${p(Number(a), x0)} ${p(Number(b), y0)}`);
  if (suit === 'h') return `<path d="${path('M0.5 0.95 C0.1 0.65 0 0.45 0 0.28 C0 0.1 0.12 0 0.27 0 C0.4 0 0.47 0.08 0.5 0.18 C0.53 0.08 0.6 0 0.73 0 C0.88 0 1 0.1 1 0.28 C1 0.45 0.9 0.65 0.5 0.95Z')}" fill="${fill}"/>`;
  if (suit === 'd') return `<path d="${path('M0.5 0 L0.9 0.5 L0.5 1 L0.1 0.5Z')}" fill="${fill}"/>`;
  if (suit === 'c') return `<g fill="${fill}"><circle cx="${p(0.5, x0)}" cy="${p(0.28, y0)}" r="${r1(size * 0.24)}"/><circle cx="${p(0.26, x0)}" cy="${p(0.6, y0)}" r="${r1(size * 0.24)}"/><circle cx="${p(0.74, x0)}" cy="${p(0.6, y0)}" r="${r1(size * 0.24)}"/><path d="${path('M0.5 0.5 L0.38 1 L0.62 1Z')}"/></g>`;
  return `<path d="${path('M0.5 0 C0.5 0 0 0.45 0 0.66 C0 0.84 0.15 0.92 0.3 0.9 C0.4 0.88 0.45 0.83 0.47 0.8 C0.46 0.9 0.42 0.97 0.35 1 L0.65 1 C0.58 0.97 0.54 0.9 0.53 0.8 C0.55 0.83 0.6 0.88 0.7 0.9 C0.85 0.92 1 0.84 1 0.66 C1 0.45 0.5 0 0.5 0Z')}" fill="${fill}"/>`;
}

// ---------- shared formats (the same as in the app) ----------

const money = (n: number) => plain(n.toLocaleString('cs-CZ'));
const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const part = (count: number, amount: number, amounts: boolean) => (count > 0 ? (amounts ? `${count}× ${money(amount)}` : `${count}×`) : '–');
const toneOf = (v: number): Tone => (v > 0 ? 'success' : v < 0 ? 'danger' : 'text');
const sizeBase = (st: PictureStyle) => st.width / 45;

// ---------- tournament: the "tournament finished" window ----------

/** Result of the tournament: title, the table of players with costs and profit, and the note under it. */
export function tournamentSvg(d: TournamentPictureData, st: PictureStyle): string {
  const u = sizeBase(st);
  const rows = [...d.summary].sort((a, b) => a.place - b.place);
  const shown = rows.slice(0, st.maxRows);
  const money_ = st.amounts;
  const hasHead = money_ && rows.some((x) => (x.headEarned ?? 0) > 0 || (x.headLost ?? 0) > 0);
  const hasBets = money_ && rows.some((x) => (x.betNet ?? 0) !== 0);
  const cols: Col[] = [
    { label: t('tournament.placeShort'), mono: true },
    { label: t('tournament.player'), grow: true },
    { label: t('tournament.resultEntries'), mono: true },
    { label: t('tournament.resultRebuys'), mono: true },
    { label: t('tournament.resultAddons'), mono: true },
    ...(money_
      ? [
          { label: t('tournament.resultSpent'), mono: true },
          { label: t('tournament.won'), mono: true },
          { label: t('tournament.resultBounty'), mono: true },
          ...(hasHead ? [{ label: t('tournament.resultHead'), mono: true }] : []),
          ...(hasBets ? [{ label: t('tournament.resultBets'), mono: true }] : []),
          { label: t('tournament.resultProfit'), mono: true },
        ]
      : []),
  ];
  const cells: Cell[][] = shown.map((x) => {
    const head = (x.headEarned ?? 0) > 0 || (x.headLost ?? 0) > 0;
    return [
      { text: `${x.place}.` },
      { text: clip(x.name, 40) },
      { text: part(x.entries, x.entryAmount, money_) },
      { text: part(x.rebuys, x.rebuyAmount, money_) },
      { text: part(x.addons, x.addonAmount, money_) },
      ...(money_
        ? [
            { text: `-${money(x.spent)}` },
            { text: money(x.payout) },
            { text: x.bounty > 0 ? money(x.bounty) : '–' },
            ...(hasHead ? [{ text: head ? [(x.headEarned ?? 0) > 0 ? `+${money(x.headEarned!)}` : '', (x.headLost ?? 0) > 0 ? `-${money(x.headLost!)}` : ''].filter(Boolean).join(' ') : '–', tone: (x.headLost ?? 0) > 0 && !(x.headEarned ?? 0) ? ('danger' as const) : (x.headEarned ?? 0) > 0 ? ('success' as const) : undefined }] : []),
            ...(hasBets ? [{ text: (x.betNet ?? 0) !== 0 ? signed(x.betNet!) : '–', tone: toneOf(x.betNet ?? 0) }] : []),
            { text: signed(x.profit), tone: toneOf(x.profit) },
          ]
        : []),
    ];
  });
  const natural = columnWidths(u, cols, cells);
  const gap = u * 1.2; // outer margin around the window
  const pad = u * 1.6; // inside the window
  const title = t('tournament.finishedTitle', { name: clip(d.name, 60) });
  const needed = Math.max(sum(natural), textWidth(title, u * 1.7, 'heading')) + 2 * (gap + pad);
  const width = Math.ceil(Math.max(st.width, needed));
  const s = new Sheet(st, width);
  const inner = width - 2 * (gap + pad);

  s.y = gap;
  const top = s.y;
  s.y += pad;
  s.text(gap + pad, s.y + u * 1.5, title, { size: u * 1.7, font: 'heading' });
  s.y += u * 3;
  s.table(gap + pad, inner, cols, cells, natural);
  s.more(gap + pad, rows.length - shown.length);
  const note = money_ ? t('tournament.resultNote') : '';
  if (note) {
    s.y += u * 1;
    for (const line of wrap(note, inner, u * 0.8)) {
      s.text(gap + pad, s.y + u * 0.9, line, { size: u * 0.8, tone: 'textMuted' });
      s.y += u * 1.2;
    }
  }
  s.y += pad;
  // the window (modal of the app) goes behind everything that was drawn
  s.insertBehind(0, `<rect x="${r1(gap)}" y="${r1(top)}" width="${r1(width - 2 * gap)}" height="${r1(s.y - top)}" rx="${s.radiusOf(1.5)}" fill="${s.color('surface')}" stroke="${s.color('border')}" stroke-width="1"/>`);
  s.y += gap;
  return s.svg(true);
}

// ---------- evening: the page "Game evening" ----------

const PARTS = ['cashBuyIn', 'cashOut', 'buyIn', 'rebuy', 'addon', 'payout', 'bounty', 'headBounty', 'bets', 'refund', 'other'] as const;
const signedN = (v: number): string => (v > 0 ? `+${v}` : String(v));

/** Evening page as one picture: ranking, awards (with the hands), statistics and the games of the evening. */
export function eveningSvg(d: EveningPictureData, st: PictureStyle): string {
  const u = sizeBase(st);
  const players = [...d.players].sort((a, b) => b.net - a.net || a.nickname.localeCompare(b.nickname, 'cs'));
  const shown = players.slice(0, st.maxRows);
  const hasParts = players.some((p) => Object.keys(p.parts ?? {}).length > 0);
  const playedCash = (p: (typeof players)[number]) => p.seated !== undefined || (p.parts?.cashBuyIn ?? 0) !== 0 || (p.parts?.cashOut ?? 0) !== 0;
  const used = hasParts ? PARTS.filter((k) => players.some((p) => (p.parts?.[k] ?? 0) !== 0 || (k === 'cashOut' && playedCash(p)))) : [];
  const hasKo = players.some((p) => p.knockouts > 0);
  const amounts = st.amounts;
  const cols: Col[] = [
    { label: '#', mono: true },
    { label: t('evening.colPlayer'), grow: true },
    ...(amounts ? (hasParts ? used.map((k) => ({ label: t(`settlement.part.${k}`), mono: true })) : [{ label: t('evening.colCash'), mono: true }, { label: t('evening.colTournament'), mono: true }, { label: t('evening.colSide'), mono: true }]) : []),
    ...(hasKo ? [{ label: t('evening.colKnockouts'), mono: true }] : []),
    ...(amounts ? [{ label: t('evening.colNet'), mono: true, end: true }] : []),
  ];
  const cells: Cell[][] = shown.map((p, i) => [
    { text: `${i + 1}.` },
    { text: clip(p.nickname, 40) },
    ...(amounts
      ? hasParts
        ? used.map((k): Cell => {
            const v = p.parts?.[k] ?? 0;
            if (k === 'cashOut' && playedCash(p)) return { text: v !== 0 || p.seated === undefined ? signedN(v) : '', tone: v !== 0 ? toneOf(v) : undefined, ...(p.seated !== undefined ? { badge: t('evening.seated') } : {}) };
            return { text: v !== 0 ? signedN(v) : '', tone: toneOf(v) };
          })
        : [{ text: String(p.cash) }, { text: String(p.tournament) }, { text: p.side ? String(p.side) : '' }]
      : []),
    ...(hasKo ? [{ text: p.knockouts ? String(p.knockouts) : '' }] : []),
    ...(amounts ? [{ text: signedN(p.net), tone: toneOf(p.net), result: true }] : []),
  ]);
  const natural = columnWidths(u, cols, cells);
  const gap = u * 1.2;
  const cardPad = u * 1.2;
  const handNeeds = (h: HandPicture | null) => (h ? u * 11 + Math.max(h.board.length, ...h.players.map((p) => p.hole?.length ?? 0), 5) * u * 2.4 + u * 12 : 0);
  const title = d.name;
  const needed = Math.max(sum(natural) + 2 * (gap + cardPad), textWidth(title, u * 1.7, 'heading') + 2 * gap + u * 14, handNeeds(d.badBeat?.hand ?? null) + 2 * (gap + cardPad), handNeeds(d.bestHand?.hand ?? null) + 2 * (gap + cardPad));
  const width = Math.ceil(Math.max(st.width, needed));
  const s = new Sheet(st, width);
  const x = gap;
  const w = width - 2 * gap;
  const inner = w - 2 * cardPad;

  s.y = gap + u * 0.4;
  // heading: name, status badge and the time span
  s.text(x, s.y + u * 1.7, clip(title, 50), { size: u * 1.7, font: 'heading' });
  const tx = x + textWidth(clip(title, 50), u * 1.7, 'heading') + u * 1;
  const status = t('evening.status.closed');
  const bw = textWidth(status, u * 0.75) + u * 1.2;
  s.box(tx, s.y + u * 0.4, bw, u * 1.5, 'surfaceRaised', false, 0.5);
  s.text(tx + bw / 2, s.y + u * 1.4, status, { size: u * 0.75, tone: 'textMuted', anchor: 'middle' });
  s.y += u * 2.9;
  s.text(x, s.y + u * 0.8, `${t('evening.from', { time: formatLocal(d.from, st.timeZone) })} ${t('evening.to', { time: formatLocal(d.to, st.timeZone) })}`, { size: u * 0.85, tone: 'textMuted' });
  s.y += u * 2;

  // players who still sat at a cash table: their chips are not in the result
  const seated = players.filter((p) => p.seated !== undefined);
  if (seated.length > 0) {
    const text = t('evening.seatedNotice', { players: seated.map((p) => (amounts ? t('evening.seatedOne', { nick: p.nickname, amount: p.seated ?? 0 }) : p.nickname)).join(', ') });
    const lines = wrap(text, inner - u * 0.6, u * 0.85);
    const h = lines.length * u * 1.3 + u * 1.6;
    s.box(x, s.y, w, h, 'surfaceRaised', 'warning');
    lines.forEach((l, i) => s.text(x + cardPad, s.y + u * 1.5 + i * u * 1.3, l, { size: u * 0.85 }));
    s.y += h + u * 1;
  }

  s.card(x, w, t('evening.ranking'), (ix, iw) => {
    if (players.length === 0) s.text(ix, s.y + u * 1, t('tournament.noPlayers'), { size: u * 0.9, tone: 'textMuted' });
    else {
      s.table(ix, iw, cols, cells, natural);
      s.more(ix, players.length - shown.length);
    }
  });
  s.y += u * 1;

  s.card(x, w, t('evening.awards'), (ix, iw) => {
    const award = (label: string, value: string | null) => {
      s.text(ix, s.y + u * 0.9, label, { size: u * 0.85, tone: 'textMuted' });
      s.y += u * 1.4;
      const lines = wrap(value ?? t('evening.award.none'), iw, u * 1.1);
      for (const line of lines) {
        s.text(ix, s.y + u * 1.1, line, { size: u * 1.1 });
        s.y += u * 1.6;
      }
      s.y += u * 0.5;
    };
    award(t('evening.mvp'), d.mvp ? `${d.mvp.nickname} (${d.mvp.score})` : null);
    award(t('evening.award.hunter'), d.hunter ? t('evening.award.hunterText', { nick: d.hunter.nickname, count: d.hunter.count }) : null);
    award(
      t('evening.award.banker'),
      d.banker ? (amounts ? t('evening.award.bankerText', { nick: d.banker.nickname, amount: d.banker.amount, bb: d.banker.bb, game: d.banker.game }) : t('integration.picture.bankerText', { nick: d.banker.nickname, bb: d.banker.bb, game: d.banker.game })) : null,
    );
    award(t('evening.award.badBeat'), d.badBeat ? t('evening.award.badBeatText', { nick: d.badBeat.nickname, equity: d.badBeat.equity, game: d.badBeat.game }) : null);
    if (d.badBeat?.hand) drawHand(s, ix, iw, t('evening.badBeatTitle', { equity: d.badBeat.equity }), d.badBeat.hand, 'badBeat');
    // best hand of the evening
    s.y += u * 0.6;
    s.hline(ix, s.y, iw);
    s.y += u * 1.2;
    s.text(ix, s.y + u * 1.1, t('evening.bestHandTitle'), { size: u * 1.1, font: 'heading' });
    s.y += u * 2;
    if (d.bestHand) drawBest(s, ix, iw, d.bestHand);
    else {
      s.text(ix, s.y + u * 0.9, t('evening.bestHandNone'), { size: u * 0.9, tone: 'textMuted' });
      s.y += u * 1.5;
    }
  });
  s.y += u * 1;

  s.card(x, w, t('evening.stats'), (ix) => {
    const rows: [string, string][] = [
      [t('evening.statGames'), String(d.stats.games)],
      [t('evening.statPlayers'), String(d.stats.players)],
      ...(amounts ? ([[t('evening.turnover'), String(d.stats.turnover)]] as [string, string][]) : []),
      [t('evening.biggestPot'), d.stats.biggestPotBb !== null ? t('evening.biggestPotBb', { bb: d.stats.biggestPotBb }) : '–'],
    ];
    const labelW = Math.max(...rows.map(([l]) => textWidth(l, u * 0.95))) + u * 3;
    for (const [label, value] of rows) {
      s.text(ix, s.y + u * 1, label, { size: u * 0.95, tone: 'textMuted' });
      s.text(ix + labelW, s.y + u * 1, plain(value), { size: u * 0.95, font: 'number' });
      s.y += u * 1.6;
    }
  });
  s.y += u * 1;

  s.card(x, w, t('evening.gamesTitle'), (ix) => {
    for (const g of d.games) {
      const kind = t(`evening.gameKind.${g.kind}`);
      const kw = textWidth(kind, u * 0.75) + u * 1.2;
      s.box(ix, s.y + u * 0.1, kw, u * 1.5, 'surfaceRaised', false, 0.5);
      s.text(ix + kw / 2, s.y + u * 1.1, kind, { size: u * 0.75, tone: 'textMuted', anchor: 'middle' });
      s.text(ix + kw + u * 1, s.y + u * 1.2, clip(g.name, 60), { size: u * 0.95 });
      s.y += u * 2;
    }
  });
  s.y += gap;
  return s.svg(true);
}

/** The hand of the bad beat: board, then every player with the cards that were shown and the name of the combination. */
function drawHand(s: Sheet, x: number, w: number, title: string, hand: HandPicture, kind: 'badBeat'): void {
  void kind;
  const u = s.u;
  const top = s.y + u * 0.4;
  const at = s.markPosition();
  s.y = top + u * 1.1;
  s.text(x + u * 1, s.y + u * 0.9, title, { size: u * 1, font: 'heading' });
  s.y += u * 2;
  const labels = [t('evening.board'), ...hand.players.map((p) => `${t(p.role === 'loser' ? 'evening.faced' : 'evening.beatBy')} ${p.nickname}`)];
  const labelW = Math.max(...labels.map((l) => textWidth(l, u * 0.9))) + u * 1.4;
  const rowH = u * 3.5;
  s.text(x + u * 1, s.y + u * 2, t('evening.board'), { size: u * 0.9, tone: 'textMuted' });
  s.cards(x + u * 1 + labelW, s.y, hand.board);
  s.y += rowH;
  for (const p of [...hand.players].sort((a, b) => (a.role === 'loser' ? -1 : 0) - (b.role === 'loser' ? -1 : 0))) {
    const who = `${t(p.role === 'loser' ? 'evening.faced' : 'evening.beatBy')} `;
    s.text(x + u * 1, s.y + u * 2, who, { size: u * 0.9, tone: 'textMuted' });
    s.text(x + u * 1 + textWidth(who, u * 0.9), s.y + u * 2, p.nickname, { size: u * 0.9 });
    let cx = x + u * 1 + labelW;
    if (p.hole) cx += s.cards(cx, s.y, p.hole, p.role === 'winner' ? p.hole : []) + u * 0.6;
    if (p.desc) s.text(cx, s.y + u * 2, t(p.desc.key, p.desc.params), { size: u * 0.9 });
    s.y += rowH;
  }
  s.y += u * 0.2;
  s.insertBehind(at, `<rect x="${r1(x)}" y="${r1(top)}" width="${r1(w)}" height="${r1(s.y - top)}" rx="${s.radiusOf(1)}" fill="${s.color('surfaceRaised')}" stroke="${s.color('border')}" stroke-width="1"/>`);
  s.y += u * 0.6;
}

/** Best hand of the evening: who and where, the five cards (hole cards marked), the combination and the legend. */
function drawBest(s: Sheet, x: number, w: number, best: { nickname: string; game: string; hand: HandPicture }): void {
  const u = s.u;
  const mine = best.hand.players.find((p) => p.role === 'best');
  if (!mine) return;
  const top = s.y;
  const at = s.markPosition();
  s.y += u * 1.1;
  s.text(x + u * 1, s.y + u * 0.9, t('evening.bestHandText', { nick: best.nickname, game: best.game }), { size: u * 0.9 });
  s.y += u * 1.6;
  s.cards(x + u * 1, s.y, mine.five ?? [...(mine.hole ?? []), ...best.hand.board], mine.hole ?? []);
  s.y += u * 3.6;
  if (mine.desc) {
    s.text(x + u * 1, s.y + u * 0.9, t(mine.desc.key, mine.desc.params), { size: u * 1.2, bold: true });
    s.y += u * 1.9;
  }
  s.text(x + u * 1, s.y + u * 0.8, t('evening.bestHandLegend'), { size: u * 0.8, tone: 'textMuted' });
  s.y += u * 1.7;
  s.insertBehind(at, `<rect x="${r1(x)}" y="${r1(top)}" width="${r1(w)}" height="${r1(s.y - top)}" rx="${s.radiusOf(1)}" fill="${s.color('surfaceRaised')}" stroke="${s.color('border')}" stroke-width="1"/>`);
}

/**
 * SVG to PNG. Fonts come from the system: the family named in the theme when the server has it, otherwise
 * `fallbackFont` (installed in the Docker image). The renderer is loaded on first use, so a server without it
 * still runs and the caller falls back to a text message.
 */
export async function svgToPng(svg: string, fallbackFont: string): Promise<Uint8Array> {
  const { renderAsync } = await import('@resvg/resvg-js');
  const image = await renderAsync(svg, { font: { loadSystemFonts: true, defaultFontFamily: fallbackFont, sansSerifFamily: fallbackFont, serifFamily: fallbackFont, monospaceFamily: `${fallbackFont} Mono` }, logLevel: 'off' });
  return image.asPng();
}
