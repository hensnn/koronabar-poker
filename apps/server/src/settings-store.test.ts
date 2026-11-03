import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { SettingsError } from './settings-store.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

// 15. června 2026 (poledne UTC)
const NOW = Date.UTC(2026, 5, 15, 12);

async function start(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  clock.advance(NOW - clock.now());
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, clock, admin: admin!, userId };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof SettingsError ? `${e.code}${e.reasonKey ? ':' + e.reasonKey : ''}` : String(e);
  }
};

describe('úložiště nastavení: rozsahy a konzistence', () => {
  it('globální vrstva odmítne herní parametry (šablony jsou úplné, hodnota by se neprojevila); systémové přijme', async () => {
    const c = await start();
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'table.bigBlind', 20))).toBe('SCOPE_NOT_ALLOWED');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'cash.minBuyInBb', 20))).toBe('SCOPE_NOT_ALLOWED');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'tournament.startingStack', 3000))).toBe('SCOPE_NOT_ALLOWED');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'time.turnSeconds', 45))).toBe('ok');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'economy.startingBalance', 777))).toBe('ok');
    expect(c.server.settings.resolve()['economy.startingBalance']).toBe(777);
  });

  it('konzistence se kontroluje proti efektivním hodnotám vrstvy, ne proti výchozím', async () => {
    const c = await start();
    // Výchozí převod 100 až 100 000: nejdřív zvýšíme minimum nad výchozí maximum nejde, po zvýšení maxima ano.
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'economy.transferMin', 200_000))).toBe('INVALID');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'economy.transferMax', 500_000))).toBe('ok');
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'economy.transferMin', 200_000))).toBe('ok');
    // Snížení maxima pod už uložené minimum se odmítne (proti výchozím hodnotám by prošlo).
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'economy.transferMax', 150_000))).toBe('INVALID');
  });

  it('vlastní hlas hlasatele si hráč nastaví jen, když to správce povolil', async () => {
    const c = await start();
    expect(await code(c.server.settings.set(c.userId, 'user', c.userId, 'announcer.userVoice', 'Zuzana'))).toBe('ok');
    await c.server.settings.set(c.admin, 'global', '', 'announcer.allowUserChoice', false);
    expect(await code(c.server.settings.set(c.userId, 'user', c.userId, 'announcer.userVoice', 'Karel'))).toBe('DENIED:change.denied.lockedByAdmin');
    // ostatní osobní volby to neblokuje
    expect(await code(c.server.settings.set(c.userId, 'user', c.userId, 'announcer.mute', true))).toBe('ok');
  });

  it('hodnoty z DB mimo rozsah se při načtení oříznou nebo zahodí a neshodí server', async () => {
    const c = await start();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
    try {
      await c.server.db.insert(schema.settingsValues).values([
        { scopeType: 'global', scopeId: '', key: 'system.sessionDays', value: 9999, updatedBy: c.admin },
        { scopeType: 'global', scopeId: '', key: 'economy.debitTarget', value: 'neexistuje', updatedBy: c.admin },
        { scopeType: 'global', scopeId: '', key: 'stats.leaderboardMinHands', value: -5, updatedBy: c.admin },
      ]);
      await c.server.settings.load();
    } finally {
      console.warn = orig;
    }
    const v = c.server.settings.resolve();
    expect(v['system.sessionDays']).toBe(365);
    expect(v['stats.leaderboardMinHands']).toBe(0);
    expect(v['economy.debitTarget']).toBe('mint');
    expect(warnings.filter((w) => w.includes('mimo rozsah'))).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('neplatná'))).toHaveLength(1);
    // načtené hodnoty jsou platné, takže další uložení není blokované
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'system.sessionDays', 10))).toBe('ok');
  });

  it('opakované čtení efektivních hodnot vrací kopii a po změně novou hodnotu', async () => {
    const c = await start();
    const a = c.server.settings.resolve();
    const b = c.server.settings.resolve();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    await c.server.settings.set(c.admin, 'global', '', 'chat.maxLength', 321);
    expect(c.server.settings.resolve()['chat.maxLength']).toBe(321);
    await c.server.settings.reset(c.admin, 'global', '', 'chat.maxLength');
    expect(c.server.settings.resolve()['chat.maxLength']).toBe(500);
  });
});

describe('časové pásmo aplikace ve statistikách', () => {
  it('hranice roku v roční statistice se řídí system.timezone', async () => {
    const c = await start();
    // 1. ledna 2026 02:00 UTC: v Praze už 2026, v Los Angeles ještě 31. 12. 2025.
    await c.server.db.insert(schema.gameResults).values({ kind: 'tournament', ref: 't-novy-rok', userId: c.userId, finishedAt: new Date(Date.UTC(2026, 0, 1, 2)), place: 1, field: 4, spent: 100, payout: 400, bounty: 0, rebuys: 0 });
    expect((await c.server.yearStats.compute(c.userId, 2026)).tournaments).toBe(1);
    expect((await c.server.yearStats.compute(c.userId, 2025)).tournaments).toBe(0);
    await c.server.settings.set(c.admin, 'global', '', 'system.timezone', 'America/Los_Angeles');
    expect((await c.server.yearStats.compute(c.userId, 2026)).tournaments).toBe(0);
    expect((await c.server.yearStats.compute(c.userId, 2025)).tournaments).toBe(1);
    expect(await code(c.server.settings.set(c.admin, 'global', '', 'system.timezone', 'Nikde/Nic'))).toBe('INVALID');
  });
});

describe('žebříček: krátká mezipaměť', () => {
  it('drží výsledek po dobu stats.cacheSeconds, nový výsledek hry ho zahodí', async () => {
    const c = await start({ 'stats.cacheSeconds': 30, 'stats.leaderboardMinHands': 0 });
    const all = { from: null, to: null };
    const result = (ref: string, payout: number) => c.server.db.insert(schema.gameResults).values({ kind: 'tournament', ref, userId: c.userId, finishedAt: new Date(NOW - 60_000), place: 1, field: 4, spent: 100, payout, bounty: 0, rebuys: 0 });
    await result('t1', 400);
    const first = await c.server.stats.leaderboard(all);
    expect(first.find((r) => r.userId === c.userId)?.tournamentNet).toBe(300);
    // přímý zápis do DB mimo službu: v mezipaměti zůstává starý výsledek…
    await result('t2', 1100);
    expect((await c.server.stats.leaderboard(all)).find((r) => r.userId === c.userId)?.tournamentNet).toBe(300);
    // …po vypršení doby se spočítá znovu
    c.clock.advance(31_000);
    expect((await c.server.stats.leaderboard(all)).find((r) => r.userId === c.userId)?.tournamentNet).toBe(1300);
    // výsledek zapsaný přes službu mezipaměť zahodí hned
    c.server.stats.recordTournament('t3', { targetMinutes: 60, rated: true }, { finishedAt: NOW - 30_000, results: [{ userId: c.userId, place: 1, payout: 250 }], payments: [{ userId: c.userId, kind: 'turnaj_buyin', cost: 100, fee: 0 }] });
    await c.server.stats.idle();
    expect((await c.server.stats.leaderboard(all)).find((r) => r.userId === c.userId)?.tournamentNet).toBe(1450);
    // vrácené řádky jsou kopie, úprava neovlivní mezipaměť
    const rows = await c.server.stats.leaderboard(all);
    rows[0]!.tournamentNet = -1;
    expect((await c.server.stats.leaderboard(all))[0]!.tournamentNet).not.toBe(-1);
  });

  it('s nulovou dobou se počítá při každém zobrazení', async () => {
    const c = await start({ 'stats.cacheSeconds': 0, 'stats.leaderboardMinHands': 0 });
    const all = { from: null, to: null };
    await c.server.db.insert(schema.gameResults).values({ kind: 'tournament', ref: 't1', userId: c.userId, finishedAt: new Date(NOW - 60_000), place: 1, field: 4, spent: 100, payout: 400, bounty: 0, rebuys: 0 });
    expect((await c.server.stats.leaderboard(all))[0]!.tournamentNet).toBe(300);
    await c.server.db.insert(schema.gameResults).values({ kind: 'tournament', ref: 't2', userId: c.userId, finishedAt: new Date(NOW - 60_000), place: 1, field: 4, spent: 100, payout: 200, bounty: 0, rebuys: 0 });
    expect((await c.server.stats.leaderboard(all))[0]!.tournamentNet).toBe(400);
  });
});
