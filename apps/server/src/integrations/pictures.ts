import { formatCurrency, formatLocal, t, type CurrencyForms } from '@kb/shared';
import type { ResolvedTokens } from '@kb/tokens';

/**
 * Summary pictures for Discord (tournament results, evening summary). The picture is drawn as SVG from the
 * theme's design tokens and then rasterised to PNG. Only data everybody may see goes in: places, payouts,
 * knockouts, evening profit. Never cards or other hidden game data.
 */

export interface PictureStyle {
  /** Width in px; text and spacing scale with it. */
  width: number;
  /** Most table rows; the rest collapses into one "and N more" line. */
  maxRows: number;
  /** Show currency amounts (payouts, prize pool, profit). */
  amounts: boolean;
  tokens: ResolvedTokens;
  currency: CurrencyForms;
  timeZone: string;
}

export interface TournamentPictureData {
  name: string;
  finishedAt: number;
  results: { place: number; name: string; payout: number; bounty: number }[];
}

export interface EveningPictureData {
  name: string;
  from: number;
  to: number;
  games: number;
  players: { nickname: string; net: number; knockouts: number; score: number }[];
  mvp: { nickname: string; score: number } | null;
  hunter: { nickname: string; count: number } | null;
  banker: { nickname: string; bb: number } | null;
  badBeat: { nickname: string; equity: number } | null;
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
const plain = (s: string) => s.replace(/[   ]/g, ' ');
const r1 = (n: number) => Math.round(n * 10) / 10;

type Tone = 'text' | 'textMuted' | 'primary' | 'secondary' | 'success' | 'danger';
interface TextOpts {
  size: number;
  tone?: Tone;
  font?: 'body' | 'heading' | 'number';
  bold?: boolean;
  anchor?: 'start' | 'end';
  spaced?: boolean;
}

/** A sheet that grows downwards: parts are appended at the running `y`, the height is known at the end. */
class Sheet {
  /** Layout unit: every size and gap is a multiple of it, so the picture scales with the width setting. */
  readonly u: number;
  readonly pad: number;
  y: number;
  private parts: string[] = [];

  constructor(readonly st: PictureStyle) {
    this.u = st.width / 45;
    this.pad = this.u * 1.5;
    this.y = this.pad;
  }

  get right() {
    return this.st.width - this.pad;
  }
  get inner() {
    return this.st.width - this.pad * 2;
  }
  color(key: string) {
    return esc(this.st.tokens[`color.${key}`] ?? '');
  }
  private radius() {
    return r1((pxOf(this.st.tokens['shape.radiusMd']) * this.u) / (pxOf(this.st.tokens['size.textBase']) || 1));
  }

  text(x: number, y: number, value: string, o: TextOpts) {
    const tk = this.st.tokens;
    const family = tk[`font.${o.font ?? 'body'}`] ?? '';
    const weight = o.bold || o.font === 'heading' ? tk['font.weightHeading'] : tk['font.weightBody'];
    const spacing = o.spaced ? ` letter-spacing="${r1(o.size * 0.08)}"` : '';
    this.parts.push(
      `<text x="${r1(x)}" y="${r1(y)}" font-family="${esc(family)}" font-size="${r1(o.size)}" font-weight="${esc(String(weight ?? ''))}" fill="${this.color(o.tone ?? 'text')}"${o.anchor === 'end' ? ' text-anchor="end"' : ''}${spacing}>${esc(value)}</text>`,
    );
  }
  box(x: number, y: number, w: number, h: number, fill: string, border = false) {
    this.parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${this.radius()}" fill="${this.color(fill)}"${border ? ` stroke="${this.color('border')}" stroke-width="1"` : ''}/>`);
  }
  line(y: number) {
    this.parts.push(`<rect x="${r1(this.pad)}" y="${r1(y)}" width="${r1(this.inner)}" height="1" fill="${this.color('border')}"/>`);
  }

  /** Kicker with the app name on the right, title and one line of facts. */
  header(kicker: string, title: string, meta: string) {
    const u = this.u;
    this.text(this.pad, this.y + u * 0.7, kicker.toLocaleUpperCase('cs-CZ'), { size: u * 0.7, tone: 'primary', bold: true, spaced: true });
    this.text(this.right, this.y + u * 0.7, t('app.name'), { size: u * 0.7, tone: 'textMuted', anchor: 'end' });
    this.y += u * 2.7;
    this.text(this.pad, this.y, clip(title, 36), { size: u * 1.7, font: 'heading' });
    this.y += u * 1.4;
    this.text(this.pad, this.y, meta, { size: u * 0.8, tone: 'textMuted' });
    this.y += u * 1.3;
  }

  /** Table: header row, zebra rows, optional "and N more" line. `cols[].x` is the anchor point of the column. */
  table(cols: { label: string; x: number; end?: boolean }[], rows: { value: string; tone?: Tone; number?: boolean; bold?: boolean }[][], hidden: number) {
    const u = this.u;
    for (const c of cols) this.text(c.x, this.y + u * 0.7, c.label.toLocaleUpperCase('cs-CZ'), { size: u * 0.62, tone: 'textMuted', anchor: c.end ? 'end' : 'start', spaced: true });
    this.y += u * 1.1;
    this.line(this.y);
    this.y += u * 0.2;
    const rowH = u * 1.9;
    rows.forEach((row, i) => {
      if (i % 2 === 1) this.box(this.pad, this.y, this.inner, rowH, 'surface');
      row.forEach((cell, c) => {
        const col = cols[c]!;
        this.text(col.x, this.y + u * 1.25, cell.value, { size: u * 0.9, tone: cell.tone, font: cell.number ? 'number' : 'body', bold: cell.bold, anchor: col.end ? 'end' : 'start' });
      });
      this.y += rowH;
    });
    if (hidden > 0) {
      this.text(this.pad + u * 0.6, this.y + u * 1.2, t('integration.picture.more', { n: hidden }), { size: u * 0.8, tone: 'textMuted' });
      this.y += u * 1.7;
    }
  }

  svg(): string {
    const w = this.st.width;
    const h = Math.ceil(this.y + this.pad);
    const stripe = r1(this.u * 0.3);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${this.color('bg')}"/><rect width="${w}" height="${stripe}" fill="${this.color('primary')}"/>${this.parts.join('')}</svg>`;
  }
}

/** „+1 250 Koron“, „−300 Koron“, „0 Koron“. */
const signed = (n: number, forms: CurrencyForms) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${plain(formatCurrency(Math.abs(n), forms))}`;
const money = (n: number, forms: CurrencyForms) => plain(formatCurrency(n, forms));
const numberText = (n: number) => plain(n.toLocaleString('cs-CZ'));

/** Tournament results: winner box and the table of places (payout and bounty only when amounts are shown). */
export function tournamentSvg(d: TournamentPictureData, st: PictureStyle): string {
  const s = new Sheet(st);
  const u = s.u;
  const results = [...d.results].sort((a, b) => a.place - b.place);
  const pool = results.reduce((n, r) => n + r.payout, 0);
  const date = formatLocal(d.finishedAt, st.timeZone);
  s.header(
    t('integration.picture.tournamentKicker'),
    d.name,
    st.amounts && pool > 0 ? t('integration.picture.tournamentMetaPool', { date, players: results.length, pool: money(pool, st.currency) }) : t('integration.picture.tournamentMeta', { date, players: results.length }),
  );

  const winners = results.filter((r) => r.place === 1);
  if (winners.length > 0) {
    const h = u * 3.6;
    s.box(s.pad, s.y, s.inner, h, 'surfaceRaised', true);
    s.text(s.pad + u, s.y + u * 1.2, t('integration.picture.winner').toLocaleUpperCase('cs-CZ'), { size: u * 0.62, tone: 'textMuted', spaced: true });
    s.text(s.pad + u, s.y + u * 2.8, clip(winners.map((w) => w.name).join(', '), 30), { size: u * 1.4, tone: 'secondary', font: 'heading' });
    const won = winners.reduce((n, w) => n + w.payout, 0);
    if (st.amounts && won > 0) s.text(s.right - u, s.y + u * 2.4, money(won, st.currency), { size: u * 1.1, tone: 'success', font: 'number', anchor: 'end', bold: true });
    s.y += h + u;
  }

  const bounties = st.amounts && results.some((r) => r.bounty > 0);
  const cols = [
    { label: t('integration.picture.colPlace'), x: s.pad + u * 0.6 },
    { label: t('integration.picture.colPlayer'), x: s.pad + u * 3 },
    ...(bounties ? [{ label: t('integration.picture.colBounty'), x: s.right - u * 11, end: true }] : []),
    ...(st.amounts ? [{ label: t('integration.picture.colPayout'), x: s.right - u * 0.6, end: true }] : []),
  ];
  const shown = results.slice(0, st.maxRows);
  s.table(
    cols,
    shown.map((r) => [
      { value: `${r.place}.`, tone: 'textMuted' as const, number: true },
      { value: clip(r.name, bounties ? 22 : 30), bold: r.place === 1 },
      ...(bounties ? [{ value: r.bounty > 0 ? money(r.bounty, st.currency) : '–', tone: r.bounty > 0 ? ('text' as const) : ('textMuted' as const), number: true }] : []),
      ...(st.amounts ? [{ value: r.payout > 0 ? money(r.payout, st.currency) : '–', tone: r.payout > 0 ? ('success' as const) : ('textMuted' as const), number: true }] : []),
    ]),
    results.length - shown.length,
  );
  return s.svg();
}

/** Evening summary: MVP and awards in boxes, then the ranking (profit only when amounts are shown). */
export function eveningSvg(d: EveningPictureData, st: PictureStyle): string {
  const s = new Sheet(st);
  const u = s.u;
  s.header(t('integration.picture.eveningKicker'), d.name, t('integration.picture.eveningMeta', { from: formatLocal(d.from, st.timeZone), to: formatLocal(d.to, st.timeZone), games: d.games, players: d.players.length }));

  const cells: { label: string; nick: string; detail: string; tone: Tone }[] = [];
  if (d.mvp) cells.push({ label: t('evening.mvp'), nick: d.mvp.nickname, detail: t('integration.picture.mvpScore', { score: numberText(d.mvp.score) }), tone: 'secondary' });
  if (d.hunter) cells.push({ label: t('evening.award.hunter'), nick: d.hunter.nickname, detail: t('integration.picture.hunterText', { count: d.hunter.count }), tone: 'text' });
  if (d.banker) cells.push({ label: t('evening.award.banker'), nick: d.banker.nickname, detail: t('integration.picture.bankerText', { bb: numberText(d.banker.bb) }), tone: 'text' });
  if (d.badBeat) cells.push({ label: t('evening.award.badBeat'), nick: d.badBeat.nickname, detail: t('integration.picture.badBeatText', { equity: numberText(d.badBeat.equity) }), tone: 'text' });
  const gap = u * 0.6;
  const cellW = (s.inner - gap) / 2;
  const cellH = u * 3.9;
  cells.forEach((c, i) => {
    const x = s.pad + (i % 2) * (cellW + gap);
    const y = s.y + Math.floor(i / 2) * (cellH + gap);
    s.box(x, y, cellW, cellH, 'surfaceRaised', true);
    s.text(x + u * 0.8, y + u * 1.1, c.label.toLocaleUpperCase('cs-CZ'), { size: u * 0.62, tone: 'textMuted', spaced: true });
    s.text(x + u * 0.8, y + u * 2.4, clip(c.nick, 18), { size: u * 1.1, tone: c.tone, font: 'heading' });
    s.text(x + u * 0.8, y + u * 3.4, c.detail, { size: u * 0.75, tone: 'textMuted' });
  });
  if (cells.length > 0) s.y += Math.ceil(cells.length / 2) * (cellH + gap) - gap + u;

  const scoreX = st.amounts ? s.right - u * 11.5 : s.right - u * 0.6;
  const cols = [
    { label: t('integration.picture.colPlace'), x: s.pad + u * 0.6 },
    { label: t('integration.picture.colPlayer'), x: s.pad + u * 3 },
    { label: t('integration.picture.colKnockouts'), x: scoreX - u * 5.5, end: true },
    { label: t('integration.picture.colScore'), x: scoreX, end: true },
    ...(st.amounts ? [{ label: t('integration.picture.colNet'), x: s.right - u * 0.6, end: true }] : []),
  ];
  const shown = d.players.slice(0, st.maxRows);
  s.table(
    cols,
    shown.map((p, i) => [
      { value: `${i + 1}.`, tone: 'textMuted' as const, number: true },
      { value: clip(p.nickname, 20), bold: i === 0 },
      { value: p.knockouts > 0 ? String(p.knockouts) : '–', tone: p.knockouts > 0 ? ('text' as const) : ('textMuted' as const), number: true },
      { value: numberText(p.score), number: true },
      ...(st.amounts ? [{ value: signed(p.net, st.currency), tone: p.net > 0 ? ('success' as const) : p.net < 0 ? ('danger' as const) : ('textMuted' as const), number: true }] : []),
    ]),
    d.players.length - shown.length,
  );
  return s.svg();
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
