import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';
import { EveningError } from './evenings.js';
import { schema } from './db/index.js';
import { like } from 'drizzle-orm';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 19), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'liveCash.enabled': true, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `E${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof EveningError) return e.code;
    throw e;
  }
};

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' };

/** Živý turnaj se třemi hráči: vyhrává a, druhý b, třetí c (vyřadil ho a). */
async function playTournament(s: Awaited<ReturnType<typeof start>>, org: string, name: string, [a, b, c]: string[]) {
  const { id } = await s.server.tournaments.create(org, { name, templateId: 'tour-turbo', settings: LIVE });
  for (const p of [a!, b!, c!]) await s.server.tournaments.liveRegister(org, id, p);
  await s.server.tournaments.start(org, id);
  await s.server.tournaments.liveEliminate(org, id, c!, [a!]);
  await s.server.tournaments.liveEliminate(org, id, b!, [a!]);
  return id;
}

describe('herní večery', { timeout: 90_000 }, () => {
  it('hry se samy přiřadí do jednoho večera, souhrn spočítá vyúčtování, MVP a ocenění', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const tId = await playTournament(s, org, 'Páteční', [a, b, c]);
    const live = await s.server.liveCash.create(org, 'Cash po turnaji');
    await s.server.liveCash.buyIn(org, live.id, a, 500);
    await s.server.liveCash.buyIn(org, live.id, b, 500);
    await s.server.liveCash.timeFee(org, live.id, b, 20);
    await s.server.liveCash.cashOut(org, live.id, a, 300);
    await s.server.liveCash.cashOut(org, live.id, b, 700);
    await s.server.liveCash.close(org, live.id);
    await s.server.journal.flush();

    // ocenění z uložených hand
    await s.server.db.insert(schema.hands).values({ id: 'h-evening-1', tableId: tId, kind: 'tournament', tournamentId: tId, handNumber: 1, playedAt: new Date(), pot: 6000, blinds: { sb: 100, bb: 200, ante: 0 } });
    await s.server.db.insert(schema.handPlayers).values([
      { handId: 'h-evening-1', userId: a, seat: 0, kind: 'tournament', playedAt: new Date(), startStack: 3000, invested: 3000, won: 6000 },
      { handId: 'h-evening-1', userId: b, seat: 1, kind: 'tournament', playedAt: new Date(), startStack: 3000, invested: 3000, won: 0, allInEquity: 0.85 },
    ]);

    const list = await s.server.evenings.list(org);
    expect(list.evenings).toHaveLength(1);
    const id = list.evenings[0]!.id;
    expect(list.evenings[0]!.status).toBe('open');

    const v = await s.server.evenings.view(id, org);
    expect(v.summary.games.map((g) => g.kind).sort()).toEqual(['live_cash', 'tournament']);
    const sum = v.summary;
    const row = (u: string) => sum.players.find((p) => p.userId === u)!;
    expect(row(a).tournament).toBe(200); // vyhrál pool 300, vložil 100
    expect(row(b).tournament).toBe(-100);
    expect(row(c).tournament).toBe(-100);
    expect(row(a).cash).toBe(-200);
    expect(row(b).cash).toBe(200 - 20);
    expect(row(a).knockouts).toBe(2);
    // nic nevzniklo ani nezmizelo: hráči + dům = 0
    expect(sum.players.reduce((n, p) => n + p.net, 0) + sum.house).toBe(0);
    expect(sum.transfers.reduce((n, t) => n + t.amount, 0)).toBeGreaterThan(0);
    expect(sum.awards.hunter).toMatchObject({ userId: a, count: 2 });
    expect(sum.awards.banker).toMatchObject({ userId: a, bb: 30 });
    expect(sum.awards.badBeat).toMatchObject({ userId: b, equity: 85 });
    expect(sum.mvp?.userId).toBe(b); // a prodělal na cashi, takže vede b
    expect(sum.stats).toMatchObject({ games: 2, players: 3 });
    expect(sum.bestHand).toBeNull(); // bez ukázaných karet není handa večera

    // otevřený večer vidí jen účastník a správce
    const outsider = await s.user();
    expect(await code(s.server.evenings.view(id, outsider))).toBe('FORBIDDEN');
    await s.server.evenings.view(id, c);

    await s.server.evenings.close(org, id);
    expect(await code(s.server.evenings.close(org, id))).toBe('CLOSED');
    const closed = await s.server.evenings.view(id, outsider);
    expect(closed.status).toBe('closed');
    expect(closed.summary.mvp?.userId).toBe(b);
    const chat = await s.server.db.select().from(schema.chatMessages).where(like(schema.chatMessages.body, 'Večer %'));
    expect(chat).toHaveLength(1);
    expect(chat[0]!.body).toContain('MVP večera');
    expect(chat[0]!.body).toContain('Lovec');
    expect(await s.server.evenings.csv(a, id)).toContain(';');
    expect(s.server.ledger.balance(accounts.table(live.id))).toBe(0);

    // znovu otevření: jen správce, jen uzavřený večer, souhrn se smaže a po dalším uzavření se spočítá znovu
    expect(await code(s.server.evenings.reopen(a, id))).toBe('FORBIDDEN');
    await s.server.evenings.reopen(org, id);
    expect((await s.server.evenings.view(id, org)).status).toBe('open');
    expect(await code(s.server.evenings.reopen(org, id))).toBe('INVALID');
    const other = await s.server.evenings.create(org, 'Druhý večer');
    await s.server.evenings.close(org, id);
    expect(await code(s.server.evenings.reopen(org, id))).toBe('OPEN_EXISTS');
    await s.server.evenings.close(org, other.id);
    await s.server.evenings.reopen(org, id);
    await s.server.evenings.close(org, id);
    expect((await s.server.evenings.view(id, org)).summary.mvp?.userId).toBe(b);
  });

  it('po dlouhé mezeře vznikne nový večer a starý se sám uzavře', async () => {
    const s = await start({ 'evening.gapHours': 3 });
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    await playTournament(s, org, 'První', [a, b, c]);
    await new Promise((r) => setTimeout(r, 300)); // automatické přiřazení doběhne
    s.clock.advance(4 * 3600_000);
    await playTournament(s, org, 'Druhý', [a, b, c]);
    const list = (await s.server.evenings.list(org)).evenings;
    expect(list).toHaveLength(2);
    expect(await s.server.evenings.closeStale()).toBe(1);
    const after = (await s.server.evenings.list(org)).evenings;
    expect(after.filter((e) => e.status === 'closed')).toHaveLength(1);
    expect(after.filter((e) => e.status === 'open')).toHaveLength(1);
  });

  it('automatika jde vypnout a ručně založený večer se sám nezavírá', async () => {
    const off = await start({ 'evening.autoCreate': false });
    const org = await off.user('organizator');
    const [a, b, c] = [await off.user(), await off.user(), await off.user()];
    await playTournament(off, org, 'Bez večera', [a, b, c]);
    expect((await off.server.evenings.list(org)).evenings).toHaveLength(0);

    const s = await start({ 'evening.gapHours': 1 });
    const org2 = await s.user('organizator');
    const { id } = await s.server.evenings.create(org2, 'Ručně');
    s.clock.advance(5 * 3600_000);
    expect(await s.server.evenings.closeStale()).toBe(0);
    expect((await s.server.evenings.view(id, org2)).status).toBe('open');
  });

  it('správa her: oprávnění, jedna hra jen v jednom večeru, uzavřený večer se nemění', async () => {
    const s = await start({ 'evening.autoCreate': false });
    const org = await s.user('organizator');
    const player = await s.user();
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    expect(await code(s.server.evenings.create(player, 'Nic'))).toBe('FORBIDDEN');
    const e1 = await s.server.evenings.create(org, 'Večer 1');
    const e2 = await s.server.evenings.create(org, 'Večer 2');
    const tId = await playTournament(s, org, 'Turnaj', [a, b, c]);
    expect(await code(s.server.evenings.addGame(player, e1.id, 'tournament', tId))).toBe('FORBIDDEN');
    expect(await code(s.server.evenings.addGame(org, e1.id, 'tournament', 'neexistuje'))).toBe('INVALID');
    await s.server.evenings.addGame(org, e1.id, 'tournament', tId);
    expect(await code(s.server.evenings.addGame(org, e2.id, 'tournament', tId))).toBe('GAME_TAKEN');
    const cand = await s.server.evenings.candidates(org, e2.id);
    expect(cand.games.some((g) => g.ref === tId)).toBe(false);
    await s.server.evenings.removeGame(org, e1.id, 'tournament', tId);
    await s.server.evenings.addGame(org, e2.id, 'tournament', tId);
    await s.server.evenings.rename(org, e2.id, 'Přejmenovaný');
    await s.server.journal.flush();
    await s.server.evenings.close(org, e2.id);
    expect(await code(s.server.evenings.addGame(org, e2.id, 'tournament', tId))).toBe('CLOSED');
    await s.server.evenings.recompute(org, e2.id);
    expect((await s.server.evenings.view(e2.id, org)).name).toBe('Přejmenovaný');
    await s.server.evenings.remove(org, e2.id);
    expect(await code(s.server.evenings.view(e2.id, org))).toBe('NOT_FOUND');
    const audit = await s.server.audit.list({ action: 'vecer.uzavrit' });
    expect(audit).toHaveLength(1);
  });

  it('váhy MVP jde změnit a vypnuté večery nic nedělají', async () => {
    const s = await start({ 'evening.mvpNetWeight': 0, 'evening.mvpPlaceWeight': 0, 'evening.mvpKnockoutWeight': 100, 'evening.mvpXpWeight': 0 });
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    await playTournament(s, org, 'Váhy', [a, b, c]);
    await s.server.journal.flush();
    const id = (await s.server.evenings.list(org)).evenings[0]!.id;
    const v = await s.server.evenings.view(id, org);
    expect(v.summary.players[0]).toMatchObject({ userId: a, score: 200 });
    expect(v.summary.players.find((p) => p.userId === b)!.score).toBe(0);

    const off = await start({ 'evening.enabled': false });
    const org2 = await off.user('organizator');
    expect(await code(off.server.evenings.create(org2, 'Nic'))).toBe('DISABLED');
    expect(await off.server.evenings.attach('tournament', 'x')).toBeNull();
  });

  it('výsledek večera obsahuje odměny na hlavu a sázky s rozpisem všech pohybů (součet sedí s knihou i vyúčtováním)', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const tId = await playTournament(s, org, 'Hlavy', [a, b, c]);
    const post = (kind: Parameters<typeof s.server.ledger.post>[0]['kind'], key: string, entries: { account: string; amount: number }[]) => s.server.ledger.post({ kind, idempotencyKey: key, gameId: tId, entries });
    // b vypsal odměnu 50 na hlavu hráče a, vyplatila se hráči c (vyřadil ho); c vsadil 30 na sázku, kterou prohrál (vklad propadl hráči a)
    post('head_bounty_post', 'hb:1:post', [{ account: accounts.wallet(b), amount: -50 }, { account: accounts.escrow('hb:1'), amount: 50 }]);
    post('head_bounty_payout', 'hb:1:settle', [{ account: accounts.escrow('hb:1'), amount: -50 }, { account: accounts.wallet(c), amount: 50 }]);
    post('bet_stake', 'bet:1:stake:c', [{ account: accounts.wallet(c), amount: -30 }, { account: accounts.escrow('bet:1'), amount: 30 }]);
    post('bet_payout', 'bet:1:settle', [{ account: accounts.escrow('bet:1'), amount: -30 }, { account: accounts.wallet(a), amount: 30 }]);
    await s.server.journal.flush();

    const id = (await s.server.evenings.list(org)).evenings[0]!.id;
    const sum = (await s.server.evenings.view(id, org)).summary;
    const row = (u: string) => sum.players.find((p) => p.userId === u)!;
    expect(row(b).side).toBe(-50);
    expect(row(c).side).toBe(50 - 30);
    expect(row(a).side).toBe(30);
    expect(row(b).net).toBe(-100 - 50);
    expect(row(b).breakdown).toMatchObject({ head_bounty_post: -50 });
    expect(row(c).breakdown).toMatchObject({ head_bounty_payout: 50, bet_stake: -30 });
    // rozpis: každý pohyb má řádek a součet řádků hráče je jeho výsledek večera
    for (const p of sum.players) expect(sum.lines.filter((l) => l.userId === p.userId).reduce((n, l) => n + l.amount, 0)).toBe(p.net);
    expect(sum.lines.find((l) => l.userId === c && l.kind === 'head_bounty_payout')).toMatchObject({ game: tId, count: 1, amount: 50 });
    // nic nevzniklo ani nezmizelo
    expect(sum.players.reduce((n, p) => n + p.net, 0) + sum.house).toBe(0);
    // CSV obsahuje rozpis pohybů s popisky
    const csv = await s.server.evenings.csv(org, id);
    expect(csv).toContain('Odměna na hlavu (vyplaceno)');
    expect(csv).toContain('Vklad do sázky');
  });

  it('a manual close warns while somebody sits at a cash table; a forced or automatic close marks that player in the summary', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, c] = [await s.user(), await s.user()];
    const { id: tableId } = await s.server.tables.createTable(org, { name: 'Cash večer', templateId: 'cash-klasika' });
    const { id } = await s.server.evenings.create(org, 'Cash');
    await s.server.evenings.addGame(org, id, 'cash', tableId);
    // a bought in, lost everything and left: there is no cash-out movement at all; c still sits with chips
    s.server.cash.buyIn(a, tableId, 300, 'test:a:buyin');
    s.server.tables.get(tableId)!.join(c, 'E2x', 0, 500);
    await s.server.journal.flush();

    // open evening: the chips at the table count as a withdrawal and the player is marked as sitting
    const live = (await s.server.evenings.view(id, org)).summary;
    const of = (sum: typeof live, u: string) => sum.players.find((p) => p.userId === u)!;
    expect(of(live, c)).toMatchObject({ seated: 500, net: 0 });
    expect(of(live, a).seated).toBeUndefined();
    expect(of(live, a).parts).toEqual({ cashBuyIn: -300 });

    // manual close: refused with the names, nothing changes
    const err = await s.server.evenings.close(org, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EveningError);
    expect((err as EveningError).code).toBe('SEATED');
    expect((err as EveningError).params).toEqual({ players: 'E2x' });
    expect((await s.server.evenings.view(id, org)).status).toBe('open');

    // forced close: the chips are not in the result, the summary says who was still sitting and with how much
    await s.server.evenings.close(org, id, {}, { force: true });
    const closed = (await s.server.evenings.view(id, org)).summary;
    expect(of(closed, c)).toMatchObject({ seated: 500, net: -500 });
    expect(of(closed, a).seated).toBeUndefined(); // left with nothing: no mark, the page shows an explicit 0
    expect(of(closed, a).net).toBe(-300);

    // the player leaves after the close; recomputing keeps the note (it cannot be found out later)
    s.clock.advance(60_000);
    s.server.tables.get(tableId)!.leave(c);
    await s.server.journal.flush();
    await s.server.evenings.recompute(org, id);
    expect(of((await s.server.evenings.view(id, org)).summary, c)).toMatchObject({ seated: 500, net: -500 });

    // reopening and closing again takes the cash-out in and the mark is gone
    await s.server.evenings.reopen(org, id);
    await s.server.evenings.close(org, id);
    const fixed = (await s.server.evenings.view(id, org)).summary;
    expect(of(fixed, c).seated).toBeUndefined();
    expect(of(fixed, c).net).toBe(0);
    expect(of(fixed, c).parts).toEqual({ cashBuyIn: -500, cashOut: 500 });
  });

  it('the automatic close never asks: it closes and marks who was still sitting', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const c = await s.user();
    const { id: tableId } = await s.server.tables.createTable(org, { name: 'Noční cash', templateId: 'cash-klasika' });
    const { id } = await s.server.evenings.create(org, 'Noc');
    await s.server.evenings.addGame(org, id, 'cash', tableId);
    s.server.tables.get(tableId)!.join(c, 'E1x', 0, 400);
    await s.server.journal.flush();
    await s.server.evenings.close(null, id);
    const view = await s.server.evenings.view(id, org);
    expect(view.status).toBe('closed');
    expect(view.summary.players.find((p) => p.userId === c)).toMatchObject({ seated: 400, net: -400 });
  });

  it('cash buy-ins made before the first hand belong to the automatic evening, those of the previous evening do not', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id: tableId } = await s.server.tables.createTable(org, { name: 'Cash', templateId: 'cash-klasika' });
    const actor = s.server.tables.get(tableId)!;
    // first evening: a sits down half a minute before the first hand (which is what creates the evening)
    actor.join(a, 'E1x', 0, 500);
    s.clock.advance(30_000);
    await s.server.evenings.cashActivity(tableId);
    await s.server.journal.flush();
    const first = (await s.server.evenings.list(org)).evenings[0]!.id;
    expect((await s.server.evenings.view(first, org)).summary.players.find((p) => p.userId === a)).toMatchObject({ net: 0, seated: 500, parts: { cashBuyIn: -500, cashOut: 500 } });
    actor.leave(a);
    await s.server.journal.flush();
    await s.server.evenings.close(null, first);
    expect((await s.server.evenings.view(first, org)).summary.players.find((p) => p.userId === a)).toMatchObject({ net: 0, parts: { cashBuyIn: -500, cashOut: 500 } });

    // second evening an hour later at the same table: only b, nothing of a's earlier play
    s.clock.advance(3600_000);
    actor.join(b, 'E2x', 1, 400);
    s.clock.advance(30_000);
    await s.server.evenings.cashActivity(tableId);
    await s.server.journal.flush();
    const list = (await s.server.evenings.list(org)).evenings;
    expect(list).toHaveLength(2);
    const second = list.find((e) => e.id !== first)!.id;
    const players = (await s.server.evenings.view(second, org)).summary.players;
    expect(players.map((p) => p.userId)).toEqual([b]);
    expect(players[0]).toMatchObject({ net: 0, seated: 400, parts: { cashBuyIn: -400, cashOut: 400 } });
  });

  it('wallet settlement counts whole evenings by the day they started; an evening across midnight is not split', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const t0 = s.clock.now();
    const midnight = t0 + 4 * 3600_000;
    // evening 1 starts before midnight, its tournament pays out after midnight
    const { id: t1 } = await s.server.tournaments.create(org, { name: 'První', templateId: 'tour-turbo', settings: LIVE });
    for (const p of [a, b, c]) await s.server.tournaments.liveRegister(org, t1, p);
    await s.server.tournaments.start(org, t1);
    await new Promise((r) => setTimeout(r, 300)); // the automatic attachment finishes
    s.clock.advance(5 * 3600_000);
    await s.server.tournaments.liveEliminate(org, t1, c, [a]);
    await s.server.tournaments.liveEliminate(org, t1, b, [a]);
    await s.server.journal.flush();
    const e1 = (await s.server.evenings.list(org)).evenings[0]!.id;
    await s.server.evenings.close(null, e1);
    // evening 2 the next day
    s.clock.advance(20 * 3600_000);
    await playTournament(s, org, 'Druhý', [b, a, c]);
    await new Promise((r) => setTimeout(r, 300));
    // a movement that belongs to no evening: still picked by its own time
    s.server.cash.buyIn(c, 'stul-bez-vecera', 40, 'test:free:buyin');
    await s.server.journal.flush();
    const end = s.clock.now() + 1000;

    const names = (r: Awaited<ReturnType<typeof s.server.wallet.settlementForPeriod>>) => r.games.map((g) => g.name).sort();
    const net = (r: Awaited<ReturnType<typeof s.server.wallet.settlementForPeriod>>, u: string) => r.players.find((p) => p.userId === u)?.total ?? 0;

    // "today" (from midnight): only the evening that started today, although the first tournament paid out today too
    const today = await s.server.wallet.settlementForPeriod(s.admin, midnight, end);
    expect(names(today)).toEqual(['Druhý', 'stul-bez-vecera']);
    expect(net(today, b)).toBe(200); // b won the second tournament
    expect(net(today, a)).toBe(-100);
    expect(net(today, c)).toBe(-100 - 40);

    // "yesterday" (until midnight): the whole first evening including the payout after midnight
    const yesterday = await s.server.wallet.settlementForPeriod(s.admin, t0 - 3600_000, midnight);
    expect(names(yesterday)).toEqual(['První']);
    expect(net(yesterday, a)).toBe(200);
    expect(net(yesterday, b)).toBe(-100);
    expect(yesterday.players.reduce((n, p) => n + p.total, 0)).toBe(0);
    expect(Math.abs(yesterday.house!)).toBe(0);

    // exactly one evening by its id, whatever the dates say
    const one = await s.server.wallet.settlementForPeriod(s.admin, 0, 1, [], { eveningId: e1 });
    expect(names(one)).toEqual(['První']);
    expect(net(one, a)).toBe(200);
    await expect(s.server.wallet.settlementForPeriod(s.admin, 0, 1, [], { eveningId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow();

    // both days together: nothing is counted twice
    const both = await s.server.wallet.settlementForPeriod(s.admin, t0 - 3600_000, end);
    expect(names(both)).toEqual(['Druhý', 'První', 'stul-bez-vecera']);
    expect(net(both, a)).toBe(200 - 100);
  });
});
