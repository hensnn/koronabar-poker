import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, randomLegalAction, seededRandom } from '@kb/game-core';
import { eq } from 'drizzle-orm';
import { buildServer } from './app.js';
import { schema } from './db/index.js';

// Hloubkové scénáře turnajů: dohoda po rebuy a add-onu ve všech metodách a typech bounty, živý turnaj s rebuy.
// Každý scénář kontroluje, že přehled výsledků (náklady, výhra, bounty, zisk) sedí s peněženkami a že kniha zůstává vyrovnaná.

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.runItDelayMs': 100, 'time.turnSeconds': 5 };
const BASE = { ...FAST, 'tournament.startingStack': 600, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 15 };

async function start(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 8), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'system.mailRequestsPerHour': 10_000, ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const everyone: string[] = [admin!];
  let n = 0;
  const user = async (role?: string) => {
    const nick = `D${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    everyone.push(userId);
    return userId;
  };
  return { server, clock, admin: admin!, user, everyone };
}

const ids = (everyone: string[], extra: string[] = []) => [accounts.mint(), accounts.house(), accounts.fund('jackpot'), accounts.fund('sezona'), accounts.fund('liga'), ...everyone.map(accounts.wallet), ...extra];

/** Hraje nahodilé handy a nahodile dokupuje, dokud neplatí podmínka (nebo nedojde krok). */
async function play(s: Awaited<ReturnType<typeof start>>, id: string, rnd: () => number, until: () => boolean, chaos: boolean) {
  const actor = s.server.tables.actors.get(id)!;
  for (let i = 0; i < 40_000 && s.server.tournaments.get(id)!.state().status === 'running' && !until(); i++) {
    const v = actor.viewFor(null);
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((x) => x.seat === v.actingSeat)!;
      const legal = actor.viewFor(p.playerId).legal;
      if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
    }
    if (chaos) {
      for (const pl of s.server.tournaments.get(id)!.state().players) {
        const r = rnd();
        try {
          if (pl.status === 'deciding' && r < 0.5) await s.server.tournaments.rebuy(pl.userId, id);
          else if (pl.status === 'playing' && r < 0.03) await s.server.tournaments.addon(pl.userId, id);
        } catch {
          /* mimo okno nebo limit */
        }
      }
    }
    s.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
  }
}

describe('hloubkově: dohoda po rebuy a add-onu', { timeout: 900_000 }, () => {
  const METHODS = ['icm', 'chipChop', 'equal'] as const;
  const BOUNTIES = ['none', 'fixed', 'pko', 'mystery'] as const;
  for (const method of METHODS)
    for (const bounty of BOUNTIES) {
      it(`${method}, bounty ${bounty}: výsledek, náklady a peněženky sedí`, async () => {
        const s = await start();
        const org = await s.user('organizator');
        const players = [await s.user(), await s.user(), await s.user(), await s.user()];
        const before = new Map(players.map((p) => [p, s.server.ledger.balance(accounts.wallet(p))]));
        const { id } = await s.server.tournaments.create(org, {
          name: 'Dohoda po rebuy',
          templateId: 'tour-turbo',
          settings: {
            ...BASE,
            'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 2, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2,
            'tournament.addonEnabled': true, 'tournament.addonFromLevel': 1, 'tournament.addonUntilLevel': 2, 'tournament.addonCost': 50, 'tournament.addonChips': 400,
            'tournament.dealEnabled': true, 'tournament.dealMaxPlayers': 3, 'tournament.dealVoteSeconds': 300, 'tournament.dealCooldownSeconds': 5,
            'tournament.payoutPreset': 'top3',
            'tournament.bountyType': bounty,
            ...(bounty === 'none' ? {} : { 'tournament.bountyPercent': 40 }),
          },
        });
        for (const p of players) await s.server.tournaments.register(p, id);
        if (s.server.tournaments.get(id)!.state().status === 'registering') await s.server.tournaments.start(org, id);
        const rnd = seededRandom(900 + METHODS.indexOf(method) * 10 + BOUNTIES.indexOf(bounty));
        const dealReady = () => s.server.tournaments.get(id)!.dealBlocker() === null;
        await play(s, id, rnd, dealReady, true);
        const tour = s.server.tournaments.get(id)!;
        if (tour.state().status === 'running') {
          // dohoda je možná: navrhne ji hráč, který ještě hraje; všichni zbývající souhlasí
          const alive = tour.state().players.filter((p) => p.status === 'playing').map((p) => p.userId);
          expect(alive.length).toBeGreaterThanOrEqual(2);
          await s.server.tournaments.proposeDeal(alive[0]!, id, { method });
          for (const p of alive) await s.server.tournaments.voteDeal(p, id, true);
          await Promise.resolve();
        }
        const view = await s.server.tournaments.view(id, players[0]!);
        expect(view.status).toBe('finished');
        expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
        expect(s.server.ledger.balance(accounts.bounty(id))).toBe(0);
        expect(s.server.ledger.totalIsZero(ids(s.everyone, [accounts.tournament(id), accounts.bounty(id)]))).toBe(true);
        const summary = view.summary!;
        // scénář opravdu zahrnul dokupování (bez něj by test nic neověřoval)
        expect(summary.reduce((n, r) => n + r.rebuys + r.addons, 0)).toBeGreaterThan(0);
        expect(summary).toHaveLength(view.results!.length);
        for (const row of summary) {
          // rozpis nákladů dává dohromady zaplacené a zisk je výhra + bounty − zaplaceno
          expect(row.spent).toBe(row.entryAmount + row.rebuyAmount + row.addonAmount);
          expect(row.profit).toBe(row.payout + row.bounty - row.spent);
          if (before.has(row.userId)) expect(s.server.ledger.balance(accounts.wallet(row.userId)) - before.get(row.userId)!).toBe(row.profit);
        }
        // nikdo nevydělal na cizích vkladech navíc: součet zisků je přesně to, co ubylo domu a fondům
        const sum = summary.reduce((n, r) => n + r.profit, 0);
        expect(sum).toBe(-(s.server.ledger.balance(accounts.house()) + s.server.ledger.balance(accounts.fund('jackpot')) + s.server.ledger.balance(accounts.fund('sezona')) + s.server.ledger.balance(accounts.fund('liga'))));
        expect(sum).toBeLessThanOrEqual(0);
      });
    }
});

describe('hloubkově: živý turnaj s rebuy a add-onem', { timeout: 120_000 }, () => {
  it('dva hráči: náklady v přehledu, zisky sedí a součet není kladný', async () => {
    const s = await start({ 'live.enabled': true });
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, {
      name: 'Živě s rebuy',
      templateId: 'tour-turbo',
      settings: {
        ...BASE,
        'tournament.live': true,
        'table.seats': 9,
        'tournament.payoutPreset': 'top3',
        'tournament.rebuyEnabled': true, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2, 'tournament.rebuyUntilLevel': 5,
        'tournament.addonEnabled': true, 'tournament.addonFromLevel': 1, 'tournament.addonUntilLevel': 5, 'tournament.addonCost': 50, 'tournament.addonChips': 400,
      },
    });
    const before = new Map([a, b].map((p) => [p, s.server.ledger.balance(accounts.wallet(p))]));
    await s.server.tournaments.liveRegister(org, id, a);
    await s.server.tournaments.liveRegister(org, id, b);
    await s.server.tournaments.start(org, id);
    await s.server.tournaments.liveBuy(org, id, a, 'rebuy');
    await s.server.tournaments.liveBuy(org, id, a, 'addon');
    await s.server.tournaments.liveBuy(org, id, b, 'addon');
    await s.server.tournaments.liveEliminate(org, id, b, [a]);
    const v = await s.server.tournaments.view(id, org);
    expect(v.status).toBe('finished');
    const row = (u: string) => v.summary!.find((r) => r.userId === u)!;
    expect(row(a)).toMatchObject({ entries: 1, rebuys: 1, addons: 1, entryAmount: 110, rebuyAmount: 100, addonAmount: 50, spent: 260 });
    expect(row(b)).toMatchObject({ entries: 1, rebuys: 0, addons: 1, entryAmount: 110, spent: 160 });
    for (const u of [a, b]) {
      expect(row(u).profit).toBe(row(u).payout + row(u).bounty - row(u).spent);
      expect(s.server.ledger.balance(accounts.wallet(u)) - before.get(u)!).toBe(row(u).profit);
    }
    const sum = row(a).profit + row(b).profit;
    expect(sum).toBe(-(s.server.ledger.balance(accounts.house()) + s.server.ledger.balance(accounts.fund('jackpot'))));
    expect(sum).toBeLessThanOrEqual(0);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);

    // export výsledků s náklady do CSV: jen pro přihlášené, s BOM, středníky a řádkem celkem
    const nick = (await s.server.db.select({ n: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, a)))[0]!.n;
    expect((await s.server.app.inject({ method: 'GET', url: `/api/tournaments/${id}/export.csv` })).statusCode).toBe(401);
    const login = await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: nick, password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await s.server.app.inject({ method: 'GET', url: `/api/tournaments/${id}/export.csv`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toMatch(/turnaj-.*\.csv/);
    expect(res.body.startsWith('\uFEFF')).toBe(true);
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines).toHaveLength(5); // turnaj, hlavicka, dva hraci, celkem
    const cells = (line: string) => line.split(';').map((c) => c.replace(/^"|"$/g, ''));
    const rowA = cells(lines.find((l) => l.includes(nick))!);
    expect(rowA.slice(2, 9)).toEqual(['1', '110', '1', '100', '1', '50', '260']);
    const total = cells(lines[lines.length - 1]!);
    expect(Number(total[11])).toBe(row(a).profit + row(b).profit);
  });
});
