import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, GameError, randomLegalAction, seededRandom } from '@kb/game-core';
import { buildServer } from './app.js';

// Zátěžová kontrola jinou formou než běžný test: stejné cash šablony, ale s mnoha semínky, bez zastavení na první chybě.
// Spouští se jen s STRESS=1 (STRESS_FROM, STRESS_TO = rozsah semínek, STRESS_OUT = soubor se zprávou).

const run = process.env.STRESS === '1';
const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.runItDelayMs': 100, 'time.turnSeconds': 5, 'odds.enabled': false, 'time.dealMs': 0 };

describe.skipIf(!run)('zátěž: cash šablony s mnoha semínky', { timeout: 1_800_000 }, () => {
  it('sbírá všechna selhání místo zastavení na prvním', async () => {
    const from = Number(process.env.STRESS_FROM ?? 1);
    const to = Number(process.env.STRESS_TO ?? 5);
    const problems: string[] = [];
    let tables = 0;
    let hands = 0;
    for (let seed = from; seed <= to; seed++) {
      const clock = new FakeClock();
      const server = await buildServer({
        clock,
        emailWorker: false,
        masterKey: { key: Buffer.alloc(32, 6), version: 1 },
        settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'system.mailRequestsPerHour': 10_000 },
        bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
        defaultTable: false,
      });
      try {
        const [admin] = server.perms.mainAdminIds();
        const everyone = [admin!];
        const mk = async (role?: string) => {
          const nick = `Z${everyone.length}x`;
          const inv = await server.accounts.createInvite(admin!, {});
          const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
          if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
          everyone.push(userId);
          return userId;
        };
        const org = await mk('organizator');
        const users = [await mk(), await mk(), await mk(), await mk(), await mk()];
        const all = () => [accounts.mint(), accounts.house(), accounts.fund('jackpot'), accounts.fund('sezona'), accounts.fund('liga'), ...everyone.map(accounts.wallet)];
        for (const tpl of server.templates.list('cash').filter((t) => t.builtin)) {
          const tag = `seed ${seed} ${tpl.id}`;
          let id: string;
          try {
            ({ id } = await server.tables.createTable(org, { name: `Z ${seed} ${tpl.id}`.slice(0, 50), templateId: tpl.id, settings: FAST }));
          } catch (e) {
            problems.push(`${tag}: nelze založit (${(e as Error).message})`);
            continue;
          }
          tables++;
          const actor = server.tables.actors.get(id)!;
          const info = actor.viewFor(null).info;
          users.forEach((u, i) => {
            try {
              actor.join(u, `Z${i}`, i, Math.min(info.maxBuyIn, Math.max(info.minBuyIn, info.bigBlind * 60)));
            } catch (e) {
              if (!(e instanceof GameError)) problems.push(`${tag}: join: ${(e as Error).message}`);
            }
          });
          const rnd = seededRandom(seed * 1000 + tables);
          for (let step = 0; step < 300; step++) {
            try {
              const v = actor.viewFor(null);
              if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
                const p = v.seats.find((x) => x.seat === v.actingSeat)!;
                const legal = actor.viewFor(p.playerId).legal;
                if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
              }
              if (v.vote?.status === 'open') for (const voter of v.vote.voters) if (rnd() < 0.5) try { actor.voteRunIt(voter.userId, rnd() < 0.7); } catch { /* už rozhodnuto */ }
              for (const seat of v.seats) {
                if (seat.stack === 0 || seat.status === 'sittingOut') {
                  try {
                    if (seat.stack === 0) actor.topUp(seat.playerId, info.bigBlind * 60);
                    actor.sitIn(seat.playerId);
                  } catch (e) {
                    if (!(e instanceof GameError)) throw e;
                  }
                }
              }
              clock.advance(Math.floor(rnd() * 2500));
              if (step % 30 === 0) {
                if (!server.ledger.totalIsZero(all().concat(accounts.table(id)))) problems.push(`${tag} krok ${step}: kniha nesedí`);
                if (server.ledger.balance(accounts.table(id)) !== actor.totalChips()) problems.push(`${tag} krok ${step}: stůl ${server.ledger.balance(accounts.table(id))} ≠ žetony ${actor.totalChips()}`);
              }
              if (actor.hasError()) {
                problems.push(`${tag} krok ${step}: stůl skončil chybou ${String((actor.hasError() as Error).message ?? actor.hasError())}`);
                break;
              }
              hands = Math.max(hands, v.handNumber);
            } catch (e) {
              problems.push(`${tag} krok ${step}: výjimka ${(e as Error).message}`);
              break;
            }
          }
          try {
            await server.tables.closeTable(org, id);
            if (server.ledger.balance(accounts.table(id)) !== 0) problems.push(`${tag}: po zrušení zůstaly žetony`);
            if (!server.ledger.totalIsZero(all().concat(accounts.table(id)))) problems.push(`${tag}: po zrušení kniha nesedí`);
          } catch (e) {
            problems.push(`${tag}: zrušení selhalo: ${(e as Error).message}`);
          }
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    }
    writeFileSync(process.env.STRESS_OUT ?? 'stress-report.txt', `stolů ${tables}, nejvyšší číslo handy ${hands}\n${problems.join('\n') || 'bez problémů'}\n`);
    expect(problems).toEqual([]);
  });
});
