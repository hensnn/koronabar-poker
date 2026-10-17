import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { TemplateError } from './templates.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const server = await buildServer({
    clock: new FakeClock(),
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof TemplateError) return e.code;
    throw e;
  }
};

describe('vlastní šablony nastavení', () => {
  it('správce založí šablonu turnaje a turnaj z ní; pozdější úprava šablony běžící turnaj nemění', async () => {
    const s = await start();
    const tpl = await s.server.templates.create(s.admin, { name: 'Páteční turbo', kind: 'tournament', values: { 'tournament.minPlayers': 2, 'tournament.levelMinutes': 4, 'tournament.startingStack': 3000 } });
    expect(tpl.id).toMatch(/^vl-patecni-turbo-[0-9a-f]{6}$/);
    expect(tpl.builtin).toBe(false);
    // doplněné výchozí hodnoty + zadané
    expect(tpl.values['tournament.levelMinutes']).toBe(4);
    expect(tpl.values['table.seats']).toBeDefined();
    expect(s.server.templates.list('tournament').some((x) => x.id === tpl.id)).toBe(true);
    expect(s.server.templates.list('cash').some((x) => x.id === tpl.id)).toBe(false);

    const { id } = await s.server.tournaments.create(s.admin, { name: 'Pátek', templateId: tpl.id });
    expect(s.server.tournaments.settingsOf(id)!['tournament.levelMinutes']).toBe(4);
    expect(s.server.tournaments.settingsOf(id)!['tournament.startingStack']).toBe(3000);

    await s.server.templates.update(s.admin, tpl.id, { name: 'Páteční turbo 2', kind: 'tournament', values: { 'tournament.levelMinutes': 9 } });
    expect(s.server.templates.get(tpl.id)!.name).toBe('Páteční turbo 2');
    expect(s.server.templates.get(tpl.id)!.values['tournament.levelMinutes']).toBe(9);
    // snímek u turnaje zůstává
    expect(s.server.tournaments.settingsOf(id)!['tournament.levelMinutes']).toBe(4);
    // nový turnaj už dostane upravenou šablonu
    const second = await s.server.tournaments.create(s.admin, { name: 'Sobota', templateId: tpl.id });
    expect(s.server.tournaments.settingsOf(second.id)!['tournament.levelMinutes']).toBe(9);

    // šablona v užívání se nesmaže; po zrušení turnajů ano
    expect(await code(s.server.templates.remove(s.admin, tpl.id))).toBe('IN_USE');
    await s.server.tournaments.cancel(s.admin, id);
    await s.server.tournaments.cancel(s.admin, second.id);
    expect(await code(s.server.templates.remove(s.admin, tpl.id))).toBe('OK');
    expect(s.server.templates.get(tpl.id)).toBeUndefined();
  });

  it('oprávnění a validace: hráč nesmí, vestavěná šablona se neupravuje, neplatné hodnoty se odmítnou', async () => {
    const s = await start();
    expect(await code(s.server.templates.create(s.player, { name: 'Moje', kind: 'cash', values: {} }))).toBe('FORBIDDEN');
    expect(await code(s.server.templates.update(s.admin, 'cash-klasika', { name: 'X', kind: 'cash', values: {} }))).toBe('BUILTIN');
    expect(await code(s.server.templates.remove(s.admin, 'cash-klasika'))).toBe('BUILTIN');
    expect(await code(s.server.templates.remove(s.admin, 'neexistuje'))).toBe('NOT_FOUND');
    expect(await code(s.server.templates.create(s.admin, { name: 'X', kind: 'cash', values: {} }))).toBe('INVALID');
    expect(await code(s.server.templates.create(s.admin, { name: 'Špatná', kind: 'cash', values: { 'table.bigBlind': -5 } }))).toBe('INVALID');
    expect(await code(s.server.templates.create(s.admin, { name: 'Cizí klíč', kind: 'cash', values: { 'neznamy.klic': 1 } }))).toBe('INVALID');
    // cash šablona se nedá použít pro turnaj
    const cash = await s.server.templates.create(s.admin, { name: 'Cash vlastní', kind: 'cash', values: { 'table.bigBlind': 20, 'table.smallBlind': 10 } });
    await expect(s.server.tournaments.create(s.admin, { name: 'Pátek', templateId: cash.id })).rejects.toThrow();
    const { id } = await s.server.tables.createTable(s.player, { name: 'Stůl z vlastní', templateId: cash.id });
    expect(s.server.tables.settingsOf(id)!['table.bigBlind']).toBe(20);
  });

  it('vlastní šablony přežijí restart (načtou se z databáze)', async () => {
    const s = await start();
    const tpl = await s.server.templates.create(s.admin, { name: 'Trvalá', kind: 'tournament', values: { 'tournament.levelMinutes': 7 } });
    await s.server.templates.load();
    expect(s.server.templates.get(tpl.id)?.values['tournament.levelMinutes']).toBe(7);
  });
});
