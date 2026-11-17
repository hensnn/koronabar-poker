import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { bookGame, bookTournament } from './test-ledger.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

/**
 * Money in every statistic comes from the accounting ledger, so all views must show the same numbers for a player.
 * The hand table and the result table are filled with deliberately different (wrong) money: they must not matter.
 */
describe('peníze ve všech statistikách sedí s účetní knihou', () => {
  it('žebříček, přehled hráčů, lobby, moje statistiky, osa, rok, veřejný přehled i srovnání ukážou u každého hráče totéž', async () => {
    const clock = new FakeClock();
    clock.advance(Date.UTC(2026, 5, 15, 12) - clock.now());
    const server = await buildServer({
      clock,
      scheduler: false,
      emailWorker: false,
      masterKey: { key: Buffer.alloc(32, 9), version: 1 },
      settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'stats.publicEnabled': true, 'stats.leaderboardMinHands': 0, 'stats.cacheSeconds': 0 },
      bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
      defaultTable: false,
    });
    servers.push(server);
    const [admin] = server.perms.mainAdminIds();
    const mk = async (nick: string, i: number) => {
      const inv = await server.accounts.createInvite(admin!, {});
      return (await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}${i}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true })).userId;
    };
    const [a, b, c] = [await mk('Alfa', 1), await mk('Beta', 2), await mk('Gama', 3)];
    const day = clock.now() - 86_400_000;
    const db = server.db;

    // cash table: results in the ledger (Alfa +700, Beta -400); the hands say something else
    await bookGame(db, { kind: 'cash_buyin', gameId: 'tbl-1', at: day, userId: a, amount: -500 });
    await bookGame(db, { kind: 'cash_cashout', gameId: 'tbl-1', at: day, userId: a, amount: 1200 });
    await bookGame(db, { kind: 'cash_buyin', gameId: 'tbl-1', at: day, userId: b, amount: -400 });
    await bookGame(db, { kind: 'time_charge', gameId: 'tbl-1', at: day, userId: c, amount: -30 });
    await db.insert(schema.hands).values({ id: 'h-x', tableId: 'tbl-1', kind: 'cash', handNumber: 1, playedAt: new Date(day), pot: 10, blinds: { sb: 1, bb: 2, ante: 0 }, chipsPerUnit: 1 });
    await db.insert(schema.handPlayers).values([
      { handId: 'h-x', userId: a, seat: 0, kind: 'cash', playedAt: new Date(day), startStack: 100, invested: 10, won: 5000 },
      { handId: 'h-x', userId: b, seat: 1, kind: 'cash', playedAt: new Date(day), startStack: 100, invested: 10, won: 0 },
    ]);
    // live cash (Gama +200)
    await db.insert(schema.liveCashGames).values({ id: 'live-1', name: 'Doma', status: 'closed' });
    await bookGame(db, { kind: 'cash_buyin', gameId: 'live-1', at: day, userId: c, amount: -300 });
    await bookGame(db, { kind: 'cash_cashout', gameId: 'live-1', at: day, userId: c, amount: 500 });
    // tournament with bounty and a bet: Alfa +350, Beta -100, bet of Beta +40
    await bookTournament(db, { gameId: 'tour-1', at: day, userId: a, spent: 100, payout: 400, bounty: 50 });
    await bookTournament(db, { gameId: 'tour-1', at: day, userId: b, spent: 100, payout: 0 });
    await bookGame(db, { kind: 'bet_payout', gameId: 'tour-1', at: day, userId: b, amount: 40 });
    await db.insert(schema.gameResults).values([
      { kind: 'tournament', ref: 'tour-1', userId: a, finishedAt: new Date(day), place: 1, field: 2, spent: 999, payout: 1, bounty: 0, rebuys: 0 },
      { kind: 'tournament', ref: 'tour-1', userId: b, finishedAt: new Date(day), place: 2, field: 2, spent: 1, payout: 999, bounty: 0, rebuys: 0 },
    ]);
    await server.journal.flush();
    server.stats.invalidateLeaderboard();

    const expected = { [a]: { cash: 700, tournament: 350 }, [b]: { cash: -400, tournament: -60 }, [c]: { cash: 170, tournament: 0 } };
    const total = (id: string) => expected[id]!.cash + expected[id]!.tournament;

    const ov = new Map((await server.overview.overview()).rows.map((r) => [r.userId, r]));
    const lead = new Map((await server.stats.leaderboard({ from: null, to: null })).map((r) => [r.userId, r]));
    const lobby = await server.overview.lobbyBoard(a);
    const board = await server.publicBoards.create(admin!, { name: 'M', config: { columns: ['profit', 'cashProfit', 'tournamentProfit'], limit: 0 } });
    const pub = await server.publicBoards.view(board.token, '1.1.1.1');
    const ys = (id: string) => server.yearStats.compute(id, server.yearStats.currentYear());

    for (const id of [a, b, c]) {
      const e = expected[id]!;
      expect(ov.get(id), 'přehled hráčů').toMatchObject({ cashNet: e.cash, tournamentNet: e.tournament, total: total(id) });
      expect(lead.get(id), 'žebříček').toMatchObject({ cashNet: e.cash, tournamentNet: e.tournament, total: total(id) });
      const ps = await server.stats.playerStats(id, id, { from: null, to: null });
      expect(ps.cashNet, 'moje statistiky cash').toBe(e.cash);
      expect(ps.tournaments.net, 'moje statistiky turnaje').toBe(e.tournament);
      const nick = ov.get(id)!.nickname;
      const prow = pub.rows.find((r) => r.nickname === nick);
      expect(prow, 'veřejný přehled').toMatchObject({ cashProfit: e.cash, tournamentProfit: e.tournament, profit: total(id) });
      expect(lobby.rows.find((r) => r.userId === id)?.total ?? total(id), 'lobby').toBe(total(id));
      const tl = await server.timeline.of(id);
      expect(tl.earnings.reduce((n, p) => n + p[1], 0), 'osa výdělek').toBe(total(id));
      expect(tl.cash.reduce((n, x) => n + x.net, 0), 'osa cash').toBe(e.cash);
      expect(tl.tournaments.reduce((n, x) => n + x.net, 0), 'osa turnaje').toBe(e.tournament);
      const y = await ys(id);
      expect(y.net, 'rok celkem').toBe(total(id));
      expect(y.tournamentNet, 'rok turnaje').toBe(e.tournament);
      expect(y.cashNet + y.liveNet, 'rok cash').toBe(e.cash);
      for (const kind of ['all', 'cash', 'tournament'] as const) {
        const cmp = await server.overview.compare([id], 'profit', kind);
        const want = kind === 'all' ? total(id) : kind === 'cash' ? e.cash : e.tournament;
        expect(cmp.series[0]!.points.at(-1)?.[1] ?? 0, `srovnání ${kind}`).toBe(want);
      }
    }
  });
});
