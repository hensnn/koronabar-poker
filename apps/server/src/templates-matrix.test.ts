import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, randomLegalAction, seededRandom, GameError } from '@kb/game-core';
import { buildServer } from './app.js';

// Matice her: každá vestavěná šablona (cash i turnaj) se zahraje s boty a po celou dobu platí účetní invarianty.

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = {
  'time.betweenHandsMs': 100,
  'time.allInRunoutDelayMs': 50,
  'time.allInRiverDramaMs': 50,
  'time.showdownMs': 50,
  'time.potToWinnerMs': 50,
  'time.runItDelayMs': 100,
  'time.turnSeconds': 5,
  'odds.enabled': false,
};
const START = 10_000;

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': START, 'system.mailRequestsPerHour': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const everyone: string[] = [admin!];
  const user = async (role?: string) => {
    const nick = `M${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    everyone.push(userId);
    return userId;
  };
  return { server, clock, admin: admin!, user, everyone };
}

const ledgerIds = (everyone: string[], extra: string[] = []) => [accounts.mint(), accounts.house(), accounts.fund('jackpot'), accounts.fund('sezona'), accounts.fund('liga'), ...everyone.map(accounts.wallet), ...extra];


describe('matice her: cash šablony', { timeout: 600_000 }, () => {
  it('každá vestavěná cash šablona: hra botů, peníze se nikdy neztratí ani nevzniknou, po zrušení stolu jsou všechny zpět v peněženkách', { retry: 2 }, async () => {
    const s = await start();
    const org = await s.user('organizator');
    const users = [await s.user(), await s.user(), await s.user(), await s.user(), await s.user()];
    const templates = s.server.templates.list('cash').filter((t) => t.builtin);
    expect(templates.length).toBeGreaterThan(3);
    for (const [k, tpl] of templates.entries()) {
      const { id } = await s.server.tables.createTable(org, { name: `Matice ${k}`, templateId: tpl.id, settings: FAST });
      const actor = s.server.tables.actors.get(id)!;
      const info = actor.viewFor(null).info;
      const rnd = seededRandom(100 + k);
      for (const [i, u] of users.entries()) {
        try {
          actor.join(u, `H${i}`, i, Math.min(info.maxBuyIn, Math.max(info.minBuyIn, info.bigBlind * 100)));
        } catch (e) {
          if (!(e instanceof GameError)) throw e;
        }
      }
      for (let step = 0; step < 300; step++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
        }
        const vote = v.vote;
        if (vote?.status === 'open') for (const voter of vote.voters) if (rnd() < 0.5) try { actor.voteRunIt(voter.userId, rnd() < 0.7); } catch { /* už rozhodnuto */ }
        s.clock.advance(Math.floor(rnd() * 2500));
        if (step % 25 === 0) {
          expect(s.server.ledger.totalIsZero(ledgerIds(s.everyone, [accounts.table(id)])), `${tpl.id} krok ${step}`).toBe(true);
          expect(s.server.ledger.balance(accounts.table(id)), `${tpl.id} stůl`).toBe(actor.totalChips());
        }
        expect(actor.hasError(), tpl.id).toBeNull();
      }
      await s.server.tables.closeTable(org, id);
      await Promise.resolve();
      expect(s.server.ledger.balance(accounts.table(id)), `${tpl.id} po zrušení`).toBe(0);
      expect(s.server.ledger.totalIsZero(ledgerIds(s.everyone, [accounts.table(id)]))).toBe(true);
    }
    // nic se neztratilo: peníze hráčů + dům + fondy = začátek
    const wallets = users.reduce((n, u) => n + s.server.ledger.balance(accounts.wallet(u)), 0);
    const rest = s.server.ledger.balance(accounts.house()) + s.server.ledger.balance(accounts.fund('jackpot')) + s.server.ledger.balance(accounts.fund('sezona')) + s.server.ledger.balance(accounts.fund('liga'));
    expect(wallets + rest).toBe(users.length * START);
  });
});

describe('matice her: turnajové šablony', { timeout: 600_000 }, () => {
  it('každá vestavěná turnajová šablona se dohraje: pořadí, pool vyplacen, přehled výsledků sedí s peněženkami', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const templates = s.server.templates.list('tournament').filter((t) => t.builtin);
    expect(templates.length).toBeGreaterThan(5);
    const pool: string[] = [];
    for (let i = 0; i < 6; i++) pool.push(await s.user());
    const small = { ...FAST, 'tournament.startingStack': 600, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 15 };
    for (const [k, tpl] of templates.entries()) {
      const heads = tpl.id === 'tour-headsup';
      const n = heads ? 2 : 5;
      const players = pool.slice(0, n);
      const before = new Map(players.map((p) => [p, s.server.ledger.balance(accounts.wallet(p))]));
      const { id } = await s.server.tournaments.create(org, { name: `Turnaj ${k}`, templateId: tpl.id, settings: small });
      for (const p of players) await s.server.tournaments.register(p, id);
      // plný turnaj (např. heads-up) se spustí sám
      if (s.server.tournaments.get(id)!.state().status === 'registering') await s.server.tournaments.start(org, id);
      const actor = s.server.tables.actors.get(id)!;
      const rnd = seededRandom(300 + k);
      for (let i = 0; i < 40_000 && s.server.tournaments.get(id)!.state().status === 'running'; i++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
        }
        // hráči s rozhodnutím o rebuy/re-entry se rozhodují náhodně
        for (const pl of s.server.tournaments.get(id)!.state().players) {
          if (pl.status === 'deciding' && rnd() < 0.3) {
            try {
              await s.server.tournaments.rebuy(pl.userId, id);
            } catch {
              /* nelze */
            }
          }
        }
        s.clock.advance(Math.floor(rnd() * 3000));
        await Promise.resolve();
      }
      await Promise.resolve();
      const view = await s.server.tournaments.view(id, players[0]!);
      expect(view.status, tpl.id).toBe('finished');
      expect(view.results!.map((r) => r.place), tpl.id).toEqual(view.results!.map((_, i) => i + 1));
      expect(new Set(view.results!.map((r) => r.userId)).size, tpl.id).toBe(view.results!.length);
      expect(view.summary, `${tpl.id}: přehled výsledků`).not.toBeNull();
      expect(view.summary!.length, tpl.id).toBe(view.results!.length);
      expect(s.server.ledger.balance(accounts.tournament(id)), `${tpl.id}: pool`).toBe(0);
      expect(s.server.ledger.totalIsZero(ledgerIds(s.everyone, [accounts.tournament(id), accounts.bounty(id)])), tpl.id).toBe(true);
      // přehled výsledků musí souhlasit s tím, co se skutečně stalo s peněženkami hráčů
      for (const row of view.summary!.filter((r) => players.includes(r.userId))) {
        const delta = s.server.ledger.balance(accounts.wallet(row.userId)) - before.get(row.userId)!;
        expect(row.profit, `${tpl.id}: zisk hráče ${row.name}`).toBe(delta);
      }
    }
  });
});

