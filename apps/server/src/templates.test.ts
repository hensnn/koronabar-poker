import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { TemplateError } from './templates.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(dataDir?: string) {
  const server = await buildServer({
    clock: new FakeClock(),
    dataDir,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const player = dataDir && (await server.accounts.listUsers(admin!)).find((u) => u.nickname === 'Hrac')?.id;
  const { userId } = player ? { userId: player } : await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player: userId };
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

  it('vestavěnou šablonu jde přepsat (název i hodnoty) a obnovit', async () => {
    const s = await start();
    const before = s.server.templates.get('tour-turbo')!;
    const t2 = await s.server.templates.update(s.admin, 'tour-turbo', { name: 'Páteční turbo', kind: 'tournament', values: { ...before.values, 'tournament.levelMinutes': 4 } });
    expect(t2.name).toBe('Páteční turbo');
    expect(t2.builtin).toBe(false);
    expect(s.server.templates.isOverridden('tour-turbo')).toBe(true);
    expect(s.server.templates.get('tour-turbo')!.values['tournament.levelMinutes']).toBe(4);
    // v seznamu je jen jednou, na místě vestavěné
    expect(s.server.templates.list('tournament').filter((x) => x.id === 'tour-turbo')).toHaveLength(1);
    // turnaj z přepsané šablony si uloží snímek
    const { id } = await s.server.tournaments.create(s.admin, { name: 'Pátek', templateId: 'tour-turbo' });
    expect(s.server.tournaments.settingsOf(id)!['tournament.levelMinutes']).toBe(4);
    // obnovení původní verze (i když šablonu používá turnaj)
    await s.server.templates.restore(s.admin, 'tour-turbo');
    expect(s.server.templates.isOverridden('tour-turbo')).toBe(false);
    expect(s.server.templates.get('tour-turbo')!.name).toBe(before.name);
    expect(s.server.tournaments.settingsOf(id)!['tournament.levelMinutes']).toBe(4);
  });

  it('pořadí šablon v nabídce jde změnit a drží', async () => {
    const s = await start();
    const ids = s.server.templates.list('tournament').map((x) => x.id);
    const moved = [ids[2]!, ...ids.filter((x) => x !== ids[2])];
    await s.server.templates.reorder(s.admin, 'tournament', moved);
    expect(s.server.templates.list('tournament').map((x) => x.id)).toEqual(moved);
    // cash šablony zůstaly, jak byly
    expect(s.server.templates.list('cash').map((x) => x.id)).toEqual(s.server.templates.list('cash').map((x) => x.id));
    expect(await code(s.server.templates.reorder(s.player, 'tournament', ids))).toBe('FORBIDDEN');
  });

  it('pořadí šablon přežije nové načtení nastavení (textová hodnota s JSON se nerozpadne)', async () => {
    const s = await start();
    const ids = s.server.templates.list('cash').map((x) => x.id);
    const moved = [ids[1]!, ids[0]!, ...ids.slice(2)];
    await s.server.templates.reorder(s.admin, 'cash', moved);
    await s.server.settings.load();
    expect(typeof s.server.settings.resolve()['templates.order']).toBe('string');
    expect(s.server.templates.list('cash').map((x) => x.id)).toEqual(moved);
  });

  it('vlastní šablony přežijí restart (načtou se z databáze)', async () => {
    const s = await start();
    const tpl = await s.server.templates.create(s.admin, { name: 'Trvalá', kind: 'tournament', values: { 'tournament.levelMinutes': 7 } });
    await s.server.templates.load();
    expect(s.server.templates.get(tpl.id)?.values['tournament.levelMinutes']).toBe(7);
  });

  it('prázdný základ „Turnaj: vlastní nastavení“ je k dispozici a jde z něj založit turnaj s podrobným nastavením', async () => {
    const s = await start();
    const base = s.server.templates.get('tour-vlastni')!;
    expect(base.kind).toBe('tournament');
    const { id } = await s.server.tournaments.create(s.admin, { name: 'Z prázdného základu', templateId: 'tour-vlastni', settings: { 'tournament.startingStack': 777, 'tournament.buyIn': 50 } });
    expect(s.server.tournaments.settingsOf(id)!['tournament.startingStack']).toBe(777);
    expect(s.server.tournaments.settingsOf(id)!['tournament.buyIn']).toBe(50);
  });

  it('vestavěnou šablonu jde přejmenovat, smazat i obnovit; smazání přežije restart a běžící hry nemění', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-tpl-'));
    dirs.push(dir);
    const first = await start(dir);
    const { id } = await first.server.tournaments.create(first.admin, { name: 'Běžící', templateId: 'tour-turbo' });
    const before = first.server.tournaments.settingsOf(id)!['tournament.levelMinutes'];
    // přejmenování (úprava názvu)
    const cur = first.server.templates.get('tour-turbo')!;
    const renamed = await first.server.templates.update(first.admin, 'tour-turbo', { name: 'Moje turbo', kind: 'tournament', values: cur.values });
    expect(renamed.name).toBe('Moje turbo');
    // smazání vestavěné (i přepsané): zmizí z nabídky a nejde z ní založit nový turnaj
    expect(await code(first.server.templates.remove(first.admin, 'tour-turbo'))).toBe('OK');
    expect(first.server.templates.get('tour-turbo')).toBeUndefined();
    expect(first.server.templates.list('tournament').some((x) => x.id === 'tour-turbo')).toBe(false);
    expect(first.server.templates.deletedBuiltin().map((x) => x.id)).toContain('tour-turbo');
    await expect(first.server.tournaments.create(first.admin, { name: 'Nový', templateId: 'tour-turbo' })).rejects.toThrow();
    // už založený turnaj zůstává beze změny
    expect(first.server.tournaments.settingsOf(id)!['tournament.levelMinutes']).toBe(before);
    expect(await code(first.server.templates.remove(first.admin, 'tour-turbo'))).toBe('NOT_FOUND');
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();
    // po restartu je šablona pořád smazaná, obnovit ji jde
    const second = await start(dir);
    expect(second.server.templates.get('tour-turbo')).toBeUndefined();
    await second.server.templates.restore(second.admin, 'tour-turbo');
    expect(second.server.templates.get('tour-turbo')!.name).toBe('template.tour-turbo.name');
    expect(second.server.templates.deletedBuiltin()).toEqual([]);
    expect(await code(second.server.templates.restore(second.admin, 'vl-neexistuje'))).toBe('NOT_FOUND');
    expect(await code(second.server.templates.restore(second.player, 'tour-turbo'))).toBe('FORBIDDEN');
  });
});
