import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';
import { sideNets } from './side-results.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 29), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `S${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' };

describe('vedlejší pohyby (odměny na hlavu, sázky) se vždy započítají k turnaji ve všech přehledech', { timeout: 120_000 }, () => {
  it('statistiky, žebříček, přehled, časová osa, roční statistika i výsledek turnaje ukazují stejná čísla včetně diváka', async () => {
    const s = await start();
    s.clock.advance(Date.parse('2026-06-01T10:00:00Z') - s.clock.now()); // roční statistika počítá jen rozumná data
    const org = await s.user('organizator');
    const [a, b, c, fan] = [await s.user(), await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Vedlejší', templateId: 'tour-turbo', settings: LIVE });
    for (const p of [a, b, c]) await s.server.tournaments.liveRegister(org, id, p);
    await s.server.tournaments.start(org, id);

    const post = (kind: Parameters<typeof s.server.ledger.post>[0]['kind'], key: string, entries: { account: string; amount: number }[]) => s.server.ledger.post({ kind, idempotencyKey: key, gameId: id, entries });
    // b vypsal 50 na hlavu hráče c, vyplatí se hráči a (vyřadil ho); divák „fan“ vsadil 30 a vyhrál 80 (sázka bokem)
    post('head_bounty_post', 'hb:t:post', [{ account: accounts.wallet(b), amount: -50 }, { account: accounts.escrow('hb:t'), amount: 50 }]);
    post('head_bounty_payout', 'hb:t:settle', [{ account: accounts.escrow('hb:t'), amount: -50 }, { account: accounts.wallet(a), amount: 50 }]);
    post('bet_stake', 'bet:t:stake:fan', [{ account: accounts.wallet(fan), amount: -30 }, { account: accounts.escrow('bet:t'), amount: 30 }]);
    post('bet_stake', 'bet:t:stake:c', [{ account: accounts.wallet(c), amount: -50 }, { account: accounts.escrow('bet:t'), amount: 50 }]);
    post('bet_payout', 'bet:t:settle', [{ account: accounts.escrow('bet:t'), amount: -80 }, { account: accounts.wallet(fan), amount: 80 }]);
    await s.server.tournaments.liveEliminate(org, id, c, [a]);
    await s.server.tournaments.liveEliminate(org, id, b, [a]);
    await s.server.journal.flush();
    await new Promise((r) => setTimeout(r, 300));
    await s.server.journal.flush();

    // společný základ: čisté vedlejší výsledky podle hráče a hry
    const rows = await sideNets(s.server.db, { gameIds: [id] });
    const net = (u: string) => rows.find((r) => r.userId === u)?.net ?? 0;
    expect([net(a), net(b), net(c), net(fan)]).toEqual([50, -50, -50, 50]);

    const all = { from: null, to: null };
    // osobní statistika: net obsahuje vedlejší pohyby, side je vidět zvlášť
    const stA = await s.server.stats.playerStats(a, a, all);
    expect(stA.tournaments.side).toBe(50);
    const stFan = await s.server.stats.playerStats(fan, fan, all);
    expect(stFan.tournaments.side).toBe(50); // divák bez turnajové účasti
    expect(stFan.tournaments.net).toBe(50);
    expect(stFan.tournaments.games).toBe(0);

    // žebříček
    const board = await s.server.stats.leaderboard(all);
    expect(board.find((r) => r.userId === a)).toMatchObject({ side: 50 });
    expect(board.find((r) => r.userId === fan)).toMatchObject({ side: 50, tournamentNet: 50, total: 50 });
    expect(board.find((r) => r.userId === b)!.tournamentNet).toBe(-100 - 50);

    // přehled „kdo je v čem nejlepší“: součet = turnajový výsledek + vedlejší
    const ov = (await s.server.overview.overview()).rows;
    expect(ov.find((r) => r.userId === fan)!.tournamentNet).toBe(50);
    expect(ov.find((r) => r.userId === b)!.tournamentNet).toBe(-150);

    // časová osa: výdělek obsahuje vedlejší pohyby, divák má událost
    const tlFan = await s.server.timeline.of(fan);
    expect(tlFan.earnings.reduce((n, p) => n + p[1], 0)).toBe(50);
    const tlA = await s.server.timeline.of(a);
    const tour = tlA.tournaments.find((x) => x.name === 'Vedlejší')!;
    expect(tour.net).toBe(200 + 50); // vyhrál pool 300, vložil 100, + hlava 50

    // roční statistika
    const year = await s.server.yearStats.compute(fan, 2026);
    expect(year.tournamentNet).toBe(50);

    // výsledek turnaje: sázky bokem a hlavy jsou ve zisku a v samostatných sloupcích
    const v = await s.server.tournaments.view(id, org);
    const rowOf = (u: string) => v.summary!.find((r) => r.userId === u)!;
    expect(rowOf(c)).toMatchObject({ betNet: -50 });
    expect(rowOf(c).profit).toBe(-100 - 50);
    expect(rowOf(b).profit).toBe(-100); // hlavu zadával přes knihu mimo službu odměn, proto jen vstup
    // vyúčtování v peněžence (období): sloupce Odměny na hlavu a Sázky, součet hráče sedí s turnajem i vedlejšími pohyby
    const period = await s.server.wallet.settlementForPeriod(s.admin, 0, Date.parse('2027-01-01'));
    const pl = (u: string) => period.players.find((p) => p.userId === u)!;
    expect(pl(a).parts).toMatchObject({ headBounty: 50 });
    expect(pl(b).parts).toMatchObject({ headBounty: -50 });
    expect(pl(c).parts).toMatchObject({ bets: -50 });
    expect(pl(fan).parts).toMatchObject({ bets: 50 });
    expect(pl(fan).total).toBe(50);
    expect(pl(fan).tournament).toBe(50);
    // večer: složky tabulky (buy-in, výhra, hlavy, sázky…) dávají dohromady výsledek v penězích
    const ev = (await s.server.evenings.list(org)).evenings[0]!;
    const evSum = (await s.server.evenings.view(ev.id, org)).summary;
    for (const p of evSum.players) expect(Object.values(p.parts).reduce((n, v) => n + v, 0)).toBe(p.net);
    expect(evSum.players.find((p) => p.userId === a)!.parts).toMatchObject({ headBounty: 50, buyIn: -100 });
    expect(evSum.players.find((p) => p.userId === fan)!.parts).toEqual({ bets: 50 });
    // CSV večera má stejné sloupce a pořadí jako tabulka: složky, vyřazení, Profit (bez bodů a XP)
    const csv = (await s.server.evenings.csv(org, ev.id)).trim().split(String.fromCharCode(10)).map((l) => l.trim());
    const head = csv[0]!.split(';').map((x) => x.replace(/^"|"$/g, ''));
    expect(head[0]).toBe('Hráč');
    expect(head[head.length - 1]).toBe('Profit');
    expect(head.indexOf('Buy-in')).toBeLessThan(head.indexOf('Výhra'));
    expect(head.indexOf('Výhra')).toBeLessThan(head.indexOf('Odměny na hlavu'));
    expect(head.indexOf('Odměny na hlavu')).toBeLessThan(head.indexOf('Sázky'));
    expect(head).not.toContain('XP');
    expect(head).not.toContain('Body');
    const game = period.games.find((g) => g.id === id)!;
    expect(game.parts[a]).toMatchObject({ headBounty: 50 });
    expect(period.players.reduce((n, p) => n + p.total, 0) + (period.house ?? 0)).toBe(0);
    // vedlejší pohyby jsou uzavřené: escrow účty jsou po vypořádání prázdné a vše, co hráči vyhráli, někdo zaplatil
    expect(s.server.ledger.balance(accounts.escrow('hb:t'))).toBe(0);
    expect(s.server.ledger.balance(accounts.escrow('bet:t'))).toBe(0);
    expect(rows.reduce((n, r) => n + r.net, 0)).toBe(0);
  });
});
