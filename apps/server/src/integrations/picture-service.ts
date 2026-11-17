import { eq } from 'drizzle-orm';
import { t, type IntegrationPayload, type PermissionChecker, type SettingValues } from '@kb/shared';
import { BUILTIN_THEMES, resolveTokens, type Theme } from '@kb/tokens';
import { schema, type Db } from '../db/index.js';
import { IntegrationError } from './service.js';
import { eveningSvg, svgToPng, tournamentSvg, type EveningPictureData, type HandPicture, type PictureStyle, type TournamentPictureData } from './pictures.js';

export type PictureKind = 'tournament' | 'evening';
export interface Picture {
  png: Uint8Array;
  filename: string;
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  settings: () => SettingValues;
  now: () => number;
  /** Result table of a finished tournament, exactly as the players get it (costs, payouts, bounties, profit); null when there is none. */
  tournament: (id: string) => Promise<TournamentPictureData | null>;
  /** SVG to PNG; replaceable in tests. */
  render?: (svg: string, fallbackFont: string) => Promise<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hand of a stored evening summary: board and the players with the cards shown at showdown. */
interface StoredHand extends HandPicture {
  game?: string;
}

/** The slice of a stored evening summary the picture needs; summaries of older evenings may lack the newer parts. */
interface StoredSummary {
  from: number;
  to: number;
  games?: { kind: 'tournament' | 'live_cash' | 'cash'; name: string }[];
  players: { nickname: string; net: number; cash?: number; tournament?: number; side?: number; parts?: Record<string, number>; knockouts: number; seated?: number }[];
  mvp: { nickname: string; score: number } | null;
  awards: {
    hunter: { nickname: string; count: number } | null;
    banker: { nickname: string; game: string; bb: number; amount: number } | null;
    badBeat: { nickname: string; game: string; equity: number; hand?: StoredHand | null } | null;
  };
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
  bestHand?: (StoredHand & { nickname: string }) | null;
}

const handOf = (h: StoredHand | null | undefined): HandPicture | null => (h ? { board: h.board, players: h.players.map((p) => ({ nickname: p.nickname, hole: p.hole, role: p.role, five: p.five, desc: p.desc })) } : null);

/**
 * Summary pictures for Discord: gathers the data of a finished tournament or a closed evening, takes the look
 * from the default theme and the picture settings, and renders a PNG. The picture shows what the app shows on the
 * "tournament finished" window and the evening page. Also serves the admin preview.
 */
export class PictureService {
  constructor(private deps: Deps) {}

  /** Look of the picture: default theme of the site in the chosen mode, sizes and options from settings. */
  async style(): Promise<PictureStyle> {
    const s = this.deps.settings();
    const id = String(s['theme.defaultId'] ?? '');
    let theme: Theme | undefined = BUILTIN_THEMES.find((x) => x.id === id);
    if (!theme && UUID.test(id)) {
      const [row] = await this.deps.db.select().from(schema.themes).where(eq(schema.themes.id, id));
      if (row) theme = { ...(row.data as unknown as Theme), id: row.id, name: row.name, builtin: false };
    }
    return {
      width: Number(s['integrations.pictureWidth']),
      maxRows: Number(s['integrations.pictureMaxRows']),
      amounts: !!s['integrations.pictureAmounts'],
      tokens: resolveTokens(theme ?? BUILTIN_THEMES[0]!, s['integrations.pictureMode'] === 'light' ? 'light' : 'dark'),
      timeZone: String(s['system.timezone']),
    };
  }

  private async png(svg: string): Promise<Uint8Array> {
    return (this.deps.render ?? svgToPng)(svg, String(this.deps.settings()['integrations.pictureFont']));
  }

  private async eveningData(id: string): Promise<EveningPictureData | null> {
    if (!UUID.test(id)) return null;
    const [ev] = await this.deps.db.select().from(schema.evenings).where(eq(schema.evenings.id, id));
    const sum = ev?.summary as StoredSummary | null | undefined;
    if (!ev || !sum) return null;
    return {
      name: ev.name,
      from: sum.from,
      to: sum.to,
      players: sum.players.map((p) => ({ nickname: p.nickname, net: p.net, cash: p.cash ?? 0, tournament: p.tournament ?? 0, side: p.side ?? 0, knockouts: p.knockouts, parts: p.parts ?? {}, ...(p.seated !== undefined ? { seated: p.seated } : {}) })),
      games: (sum.games ?? []).map((g) => ({ kind: g.kind, name: g.name })),
      mvp: sum.mvp ? { nickname: sum.mvp.nickname, score: sum.mvp.score } : null,
      hunter: sum.awards.hunter ? { nickname: sum.awards.hunter.nickname, count: sum.awards.hunter.count } : null,
      banker: sum.awards.banker ? { nickname: sum.awards.banker.nickname, game: sum.awards.banker.game, bb: sum.awards.banker.bb, amount: sum.awards.banker.amount } : null,
      badBeat: sum.awards.badBeat ? { nickname: sum.awards.badBeat.nickname, game: sum.awards.badBeat.game, equity: sum.awards.badBeat.equity, hand: handOf(sum.awards.badBeat.hand) } : null,
      bestHand: sum.bestHand && handOf(sum.bestHand) ? { nickname: sum.bestHand.nickname, game: sum.bestHand.game ?? '', hand: handOf(sum.bestHand)! } : null,
      stats: sum.stats,
    };
  }

  /** Made-up data for the preview and the test message. */
  sample(kind: 'tournament'): TournamentPictureData;
  sample(kind: 'evening'): EveningPictureData;
  sample(kind: PictureKind): TournamentPictureData | EveningPictureData {
    const nick = (n: number) => t('integration.picture.samplePlayer', { n });
    if (kind === 'tournament') {
      const payouts = [2500, 1500, 1000];
      const bounties = [300, 0, 200, 100];
      return {
        name: t('integration.picture.sampleTournament'),
        summary: Array.from({ length: 8 }, (_, i) => {
          const rebuys = i % 3 === 1 ? 1 : 0;
          const spent = 500 + rebuys * 500;
          const payout = payouts[i] ?? 0;
          const bounty = bounties[i] ?? 0;
          return { place: i + 1, name: nick(i + 1), entries: 1, entryAmount: 500, rebuys, rebuyAmount: rebuys * 500, addons: i === 0 ? 1 : 0, addonAmount: i === 0 ? 500 : 0, spent: spent + (i === 0 ? 500 : 0), payout, bounty, profit: payout + bounty - spent - (i === 0 ? 500 : 0) };
        }),
      };
    }
    const nets = [1850, 620, 140, 0, -310, -900, -1400];
    const hand: HandPicture = {
      board: ['Ks', '7d', '2h', 'Qc', '2s'],
      players: [
        { nickname: nick(6), hole: ['Ah', 'Ad'], role: 'loser', five: null, desc: { key: 'hand.twoPair', params: { a: 'A', b: '2' } } },
        { nickname: nick(1), hole: ['2d', '2c'], role: 'winner', five: null, desc: { key: 'hand.trips', params: { rank: '2' } } },
      ],
    };
    return {
      name: t('integration.picture.sampleEvening'),
      from: this.deps.now() - 4 * 3600_000,
      to: this.deps.now(),
      players: nets.map((net, i) => ({
        nickname: nick(i + 1),
        net,
        cash: i < 3 ? net : 0,
        tournament: i >= 3 ? net : 0,
        side: 0,
        knockouts: Math.max(0, 3 - i),
        parts: (i < 3 ? { cashBuyIn: -1000, cashOut: 1000 + net } : { buyIn: -500, payout: Math.max(0, net + 500) }) as Record<string, number>,
      })),
      games: [
        { kind: 'cash', name: t('integration.picture.sampleCash') },
        { kind: 'tournament', name: t('integration.picture.sampleTournament') },
      ],
      mvp: { nickname: nick(1), score: 101.5 },
      hunter: { nickname: nick(1), count: 3 },
      banker: { nickname: nick(2), game: t('integration.picture.sampleTournament'), bb: 184, amount: 3680 },
      badBeat: { nickname: nick(6), game: t('integration.picture.sampleCash'), equity: 91.3, hand },
      bestHand: { nickname: nick(1), game: t('integration.picture.sampleTournament'), hand: { board: hand.board, players: [{ nickname: nick(1), hole: ['2d', '2c'], role: 'best', five: ['2d', '2c', '2h', 'Ks', 'Qc'], desc: { key: 'hand.trips', params: { rank: '2' } } }] } },
      stats: { games: 2, players: nets.length, turnover: 6500, biggestPotBb: 184 },
    };
  }

  /** Picture for an outgoing event, or null when the event has none or its data is gone (the caller then sends text). */
  async forEvent(p: IntegrationPayload): Promise<Picture | null> {
    const id = typeof p.data.id === 'string' ? p.data.id : '';
    const test = p.data.test === true;
    if (p.event === 'tournament.finished') {
      const data = test ? this.sample('tournament') : id ? await this.deps.tournament(id) : null;
      return data ? { png: await this.png(tournamentSvg(data, await this.style())), filename: 'turnaj.png' } : null;
    }
    if (p.event === 'evening.closed') {
      const data = test ? this.sample('evening') : await this.eveningData(id);
      return data ? { png: await this.png(eveningSvg(data, await this.style())), filename: 'vecer.png' } : null;
    }
    return null;
  }

  /** Preview with made-up data for the admin page. */
  async preview(actorId: string, kind: PictureKind): Promise<Uint8Array> {
    if (!this.deps.perms.can(actorId, 'integrace.spravovat').allowed) throw new IntegrationError('FORBIDDEN');
    const style = await this.style();
    return this.png(kind === 'evening' ? eveningSvg(this.sample('evening'), style) : tournamentSvg(this.sample('tournament'), style));
  }
}
