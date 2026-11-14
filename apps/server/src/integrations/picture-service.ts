import { and, eq, inArray } from 'drizzle-orm';
import { currencyFormsOf, t, type IntegrationPayload, type PermissionChecker, type SettingValues } from '@kb/shared';
import { BUILTIN_THEMES, resolveTokens, type Theme } from '@kb/tokens';
import { schema, type Db } from '../db/index.js';
import { IntegrationError } from './service.js';
import { eveningSvg, svgToPng, tournamentSvg, type EveningPictureData, type PictureStyle, type TournamentPictureData } from './pictures.js';

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
  /** Results of a tournament still held in memory (right after it finished); otherwise they are read from the database. */
  tournament: (id: string) => TournamentPictureData | null;
  /** SVG to PNG; replaceable in tests. */
  render?: (svg: string, fallbackFont: string) => Promise<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of a stored evening summary the picture needs. */
interface StoredSummary {
  from: number;
  to: number;
  players: { nickname: string; net: number; knockouts: number; score: number }[];
  mvp: { nickname: string; score: number } | null;
  awards: { hunter: { nickname: string; count: number } | null; banker: { nickname: string; bb: number } | null; badBeat: { nickname: string; equity: number } | null };
  stats: { games: number };
}

/**
 * Summary pictures for Discord: gathers the data of a finished tournament or a closed evening, takes the look
 * from the default theme and the picture settings, and renders a PNG. Also serves the admin preview.
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
      currency: currencyFormsOf(s),
      timeZone: String(s['system.timezone']),
    };
  }

  private async png(svg: string): Promise<Uint8Array> {
    return (this.deps.render ?? svgToPng)(svg, String(this.deps.settings()['integrations.pictureFont']));
  }

  private async tournamentData(id: string): Promise<TournamentPictureData | null> {
    const live = this.deps.tournament(id);
    if (live) return live;
    if (!id) return null;
    const db = this.deps.db;
    const [row] = await db.select({ name: schema.tournaments.name }).from(schema.tournaments).where(eq(schema.tournaments.id, id));
    const results = await db.select().from(schema.gameResults).where(and(eq(schema.gameResults.kind, 'tournament'), eq(schema.gameResults.ref, id)));
    if (!row || results.length === 0) return null;
    const users = await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, results.map((r) => r.userId)));
    const names = new Map(users.map((u) => [u.id, u.nickname]));
    return { name: row.name, finishedAt: results[0]!.finishedAt.getTime(), results: results.map((r) => ({ place: r.place, name: names.get(r.userId) ?? '?', payout: r.payout, bounty: r.bounty })) };
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
      games: sum.stats.games,
      players: sum.players.map((p) => ({ nickname: p.nickname, net: p.net, knockouts: p.knockouts, score: p.score })),
      mvp: sum.mvp ? { nickname: sum.mvp.nickname, score: sum.mvp.score } : null,
      hunter: sum.awards.hunter ? { nickname: sum.awards.hunter.nickname, count: sum.awards.hunter.count } : null,
      banker: sum.awards.banker ? { nickname: sum.awards.banker.nickname, bb: sum.awards.banker.bb } : null,
      badBeat: sum.awards.badBeat ? { nickname: sum.awards.badBeat.nickname, equity: sum.awards.badBeat.equity } : null,
    };
  }

  /** Made-up data for the preview and the test message. */
  sample(kind: 'tournament', now?: number): TournamentPictureData;
  sample(kind: 'evening', now?: number): EveningPictureData;
  sample(kind: PictureKind, now = this.deps.now()): TournamentPictureData | EveningPictureData {
    const nick = (n: number) => t('integration.picture.samplePlayer', { n });
    if (kind === 'tournament') {
      const payouts = [2500, 1500, 1000];
      const bounties = [300, 0, 200, 100];
      return { name: t('integration.picture.sampleTournament'), finishedAt: now, results: Array.from({ length: 8 }, (_, i) => ({ place: i + 1, name: nick(i + 1), payout: payouts[i] ?? 0, bounty: bounties[i] ?? 0 })) };
    }
    const nets = [1850, 620, 140, 0, -310, -900, -1400];
    return {
      name: t('integration.picture.sampleEvening'),
      from: now - 4 * 3600_000,
      to: now,
      games: 3,
      players: nets.map((net, i) => ({ nickname: nick(i + 1), net, knockouts: Math.max(0, 3 - i), score: Math.round((nets.length - i) * 14.5 * 10) / 10 })),
      mvp: { nickname: nick(1), score: 101.5 },
      hunter: { nickname: nick(1), count: 3 },
      banker: { nickname: nick(2), bb: 184 },
      badBeat: { nickname: nick(6), equity: 91.3 },
    };
  }

  /** Picture for an outgoing event, or null when the event has none or its data is gone (the caller then sends text). */
  async forEvent(p: IntegrationPayload): Promise<Picture | null> {
    const id = typeof p.data.id === 'string' ? p.data.id : '';
    const test = p.data.test === true;
    if (p.event === 'tournament.finished') {
      const data = test ? this.sample('tournament', p.at) : await this.tournamentData(id);
      return data ? { png: await this.png(tournamentSvg(data, await this.style())), filename: 'turnaj.png' } : null;
    }
    if (p.event === 'evening.closed') {
      const data = test ? this.sample('evening', p.at) : await this.eveningData(id);
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
