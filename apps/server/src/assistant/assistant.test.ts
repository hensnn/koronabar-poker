import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { desc, eq } from 'drizzle-orm';
import { buildServer } from '../app.js';
import { schema } from '../db/index.js';
import { AssistantError } from './service.js';
import { createProvider, ProviderError, type AiProvider, type CompletionRequest, type CompletionResult } from './providers.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

type Step = (req: CompletionRequest) => Partial<CompletionResult>;
const say = (text: string): Step => () => ({ text });
const call = (name: string, args: Record<string, unknown>): Step => () => ({ toolCalls: [{ id: `c-${name}`, name, args }] });

/** Poskytovatel, který postupně vrací připravené odpovědi a pamatuje si, co dostal. */
function scripted(steps: Step[]) {
  const seen: CompletionRequest[] = [];
  const queue = [...steps];
  const provider: AiProvider = {
    async complete(req) {
      seen.push(JSON.parse(JSON.stringify(req)));
      const next = queue.shift();
      if (!next) throw new ProviderError('SCRIPT_END');
      return { text: '', toolCalls: [], tokens: 10, ...next(req) };
    },
  };
  return { provider, seen, left: () => queue.length };
}

async function start(settings: Record<string, unknown> = {}, provider?: AiProvider) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 41), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 5000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    assistantProvider: provider,
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

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AssistantError) return e.code;
    throw e;
  }
};

/** Výsledky nástrojů, jak je model viděl v posledním požadavku (ten obsahuje všechny dosavadní). */
const toolResults = (seen: CompletionRequest[]) => (seen.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);

describe('AI asistent: návrhy a potvrzení', { timeout: 90_000 }, () => {
  it('bez poskytovatele je asistent nedostupný, aplikace jede dál', async () => {
    const c = await start();
    const u = await c.user();
    const st = await c.server.assistant.status(u);
    expect(st.available).toBe(false);
    expect(await code(c.server.assistant.chat(u, { text: 'ahoj' }))).toBe('DISABLED');
  });

  it('vyhledá parametr, navrhne změnu, nic se nezmění do potvrzení; potvrzení zapíše audit se značkou asistenta', async () => {
    const sp = scripted([
      call('search_settings', { query: 'sleva v obchodě' }),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.discountPercent', value: '15' }] }),
      say('Navrhl jsem slevu 15 %.'),
    ]);
    const c = await start({}, sp.provider);
    const res = await c.server.assistant.chat(c.admin, { text: 'dej v obchodě slevu 15 procent', context: 'admin' });
    expect(res.reply).toContain('15 %');
    expect(toolResults(sp.seen)[0]).toContain('cosmetics.discountPercent');
    expect(res.proposals).toHaveLength(1);
    const p = res.proposals[0]!;
    expect(p.status).toBe('pending');
    expect(p.diff[0]).toMatchObject({ key: 'cosmetics.discountPercent', before: '0 %', after: '15 %', timing: 'now' });
    expect(c.server.settings.resolve()['cosmetics.discountPercent']).toBe(0);

    const done = await c.server.assistant.apply(c.admin, p.id);
    expect(done.status).toBe('applied');
    expect(c.server.settings.resolve()['cosmetics.discountPercent']).toBe(15);
    const [audit] = await c.server.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'nastaveni.zmena')).orderBy(desc(schema.auditLog.at)).limit(1);
    expect(audit).toMatchObject({ source: 'assistant', reason: 'dej v obchodě slevu 15 procent' });
    expect(await code(c.server.assistant.apply(c.admin, p.id))).toBe('NOT_PENDING');
    const history = await c.server.assistant.history(c.admin);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[1]!.proposals[0]!.status).toBe('applied');
  });

  it('asistent smí jen to, co smí uživatel: hráč nezmění globální nastavení, vlastní ano', async () => {
    const sp = scripted([
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.discountPercent', value: '50' }] }),
      call('propose_settings_change', { target: { kind: 'user' }, changes: [{ key: 'ui.soundVolumePercent', value: '30' }] }),
      say('hotovo'),
    ]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    const res = await c.server.assistant.chat(u, { text: 'změň slevu a hlasitost' });
    const results = toolResults(sp.seen).map((r) => JSON.parse(r));
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].denied[0]).toContain('oprávnění');
    expect(results[1]).toMatchObject({ ok: true });
    expect(res.proposals).toHaveLength(1);
    await c.server.assistant.apply(u, res.proposals[0]!.id);
    expect(c.server.settings.layer('user', u)['ui.soundVolumePercent']).toBe(30);
    expect(c.server.settings.resolve()['cosmetics.discountPercent']).toBe(0);
  });

  it('neplatné hodnoty, neznámé a zakázané parametry se odmítnou ještě před návrhem', async () => {
    const sp = scripted([
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.discountPercent', value: '500' }] }),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'neexistuje.nic', value: '1' }] }),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'assistant.perUserDaily', value: '99999' }] }),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.enabled', value: 'možná' }] }),
      call('propose_settings_change', { target: { kind: 'nikde' }, changes: [{ key: 'cosmetics.enabled', value: 'ne' }] }),
      say('nepovedlo se'),
    ]);
    const c = await start({}, sp.provider);
    const res = await c.server.assistant.chat(c.admin, { text: 'zkus to' });
    expect(res.proposals).toHaveLength(0);
    const out = toolResults(sp.seen).map((r) => JSON.parse(r));
    expect(out.every((o) => o.ok === false)).toBe(true);
    expect(out[0].denied[0]).toContain('0 až 100');
    expect(out[1].denied[0]).toContain('neexistuje');
    expect(out[2].denied[0]).toContain('měnit nesmí');
    expect(c.server.settings.resolve()['assistant.perUserDaily']).toBe(30);
  });

  it('uživatel může hodnoty před potvrzením upravit; zamítnutí a vypršení nic nezmění', async () => {
    const sp = scripted([
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '8' }] }),
      say('a'),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '9' }] }),
      say('b'),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '10' }] }),
      say('c'),
    ]);
    const c = await start({ 'assistant.proposalMinutes': 5 }, sp.provider);
    const a = (await c.server.assistant.chat(c.admin, { text: 'jedna' })).proposals[0]!;
    const done = await c.server.assistant.apply(c.admin, a.id, { 'cosmetics.maxTrophies': 12 });
    expect(done.status).toBe('applied');
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(12);

    const b = (await c.server.assistant.chat(c.admin, { text: 'dva' })).proposals[0]!;
    expect((await c.server.assistant.reject(c.admin, b.id)).status).toBe('rejected');
    expect(await code(c.server.assistant.apply(c.admin, b.id))).toBe('NOT_PENDING');

    const d = (await c.server.assistant.chat(c.admin, { text: 'tri' })).proposals[0]!;
    c.clock.advance(6 * 60_000);
    expect((await c.server.assistant.proposals(c.admin)).find((x) => x.id === d.id)!.status).toBe('expired');
    expect(await code(c.server.assistant.apply(c.admin, d.id))).toBe('EXPIRED');
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(12);
  });

  it('při potvrzení se oprávnění ověří znovu a návrh patří jen tomu, kdo ho vyvolal', async () => {
    const sp = scripted([call('propose_settings_change', { target: { kind: 'user' }, changes: [{ key: 'ui.soundVolumePercent', value: '10' }] }), say('ok')]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    const other = await c.user();
    const p = (await c.server.assistant.chat(u, { text: 'ticho' })).proposals[0]!;
    expect(await code(c.server.assistant.apply(other, p.id))).toBe('NOT_FOUND');
    expect(await code(c.server.assistant.reject(other, p.id))).toBe('NOT_FOUND');
    const roleId = await c.server.perms.createRole(c.admin, { key: 'bezasistenta', name: 'Bez asistenta', power: 5, permissions: [{ key: 'asistent.pouzivat', effect: 'deny' }] });
    await c.server.perms.assignRole(c.admin, u, roleId);
    expect(await code(c.server.assistant.apply(u, p.id))).toBe('FORBIDDEN');
    expect(c.server.settings.layer('user', u)['ui.soundVolumePercent']).toBeUndefined();
  });

  it('stůl: náhled ukáže kdy změna začne platit, změnu provede služba stolu s auditem; cizí stůl nejde', async () => {
    const holder = { id: '' };
    const sp = scripted([
      () => ({ toolCalls: [{ id: 'k1', name: 'propose_settings_change', args: { target: { kind: 'table', id: holder.id }, changes: [{ key: 'table.bigBlind', value: '20' }, { key: 'table.smallBlind', value: '10' }] } }] }),
      say('hotovo'),
      () => ({ toolCalls: [{ id: 'k2', name: 'propose_settings_change', args: { target: { kind: 'table', id: holder.id }, changes: [{ key: 'table.bigBlind', value: '40' }] } }] }),
      say('nešlo to'),
    ]);
    const c = await start({}, sp.provider);
    const tbl = await c.server.tables.createTable(c.admin, { name: 'Neděle', templateId: 'cash-klasika' });
    holder.id = tbl.id;
    const res = await c.server.assistant.chat(c.admin, { text: 'zdvojnásob blindy', context: 'table', targetId: tbl.id });
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]!.diff.map((r) => r.timing)).toEqual(['now', 'now']);
    expect(sp.seen[0]!.system).toContain('Neděle');
    await c.server.assistant.apply(c.admin, res.proposals[0]!.id);
    expect(c.server.tables.settingsOf(tbl.id)!['table.bigBlind']).toBe(20);
    const [audit] = await c.server.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'nastaveni.zmena')).orderBy(desc(schema.auditLog.at)).limit(1);
    expect(audit).toMatchObject({ source: 'assistant', reason: 'zdvojnásob blindy' });

    // hráč, který stůl nespravuje, dostane odmítnutí a žádný návrh
    const u = await c.user();
    const denied = await c.server.assistant.chat(u, { text: 'zdvojnásob blindy ještě jednou' });
    expect(denied.proposals).toHaveLength(0);
    expect(JSON.parse(toolResults(sp.seen).at(-1)!).denied[0]).toContain('oprávnění');
    expect(c.server.tables.settingsOf(tbl.id)!['table.bigBlind']).toBe(20);
  });
});

describe('AI asistent: další návrhy, limity, prompty, pískoviště', { timeout: 90_000 }, () => {
  it('drobné změny ze seznamu bez potvrzení se provedou hned, globální nikdy', async () => {
    const sp = scripted([
      call('propose_settings_change', { target: { kind: 'user' }, changes: [{ key: 'ui.soundVolumePercent', value: '20' }] }),
      call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '7' }] }),
      say('hotovo'),
    ]);
    const c = await start({ 'assistant.autoKeys': 'ui.soundVolumePercent, cosmetics.maxTrophies' }, sp.provider);
    const res = await c.server.assistant.chat(c.admin, { text: 'ztlum to a uprav trofeje' });
    expect(res.proposals.map((p) => p.status)).toEqual(['applied', 'pending']);
    expect(c.server.settings.layer('user', c.admin)['ui.soundVolumePercent']).toBe(20);
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(5);
  });

  it('založení turnaje a anketa se vytvoří až po potvrzení', async () => {
    const start20 = Date.now() + 7 * 86_400_000;
    const sp = scripted([
      call('list_templates', { kind: 'tournament' }),
      call('propose_create_tournament', { name: 'Páteční turbo', templateId: 'tour-turbo', settings: [{ key: 'tournament.buyIn', value: '200' }], startAt: new Date(start20).toISOString() }),
      call('propose_poll', { title: 'Hrajeme v pátek?', options: ['Ano', 'Ne'], durationMinutes: 120 }),
      say('navrženo'),
    ]);
    const c = await start({}, sp.provider);
    const res = await c.server.assistant.chat(c.admin, { text: 'naplánuj turbo na pátek a udělej anketu', context: 'planning' });
    expect(toolResults(sp.seen)[0]).toContain('tour-turbo');
    expect(res.proposals).toHaveLength(2);
    expect(c.server.tournaments.list().some((x) => x.name === 'Páteční turbo')).toBe(false);
    const t = await c.server.assistant.apply(c.admin, res.proposals[0]!.id);
    expect(t.status).toBe('applied');
    expect(c.server.tournaments.list().find((x) => x.name === 'Páteční turbo')?.settings['tournament.buyIn']).toBe(200);
    const p = await c.server.assistant.apply(c.admin, res.proposals[1]!.id);
    expect(p.status).toBe('applied');
    const polls = await c.server.db.select().from(schema.polls);
    expect(polls.some((x) => x.title === 'Hrajeme v pátek?')).toBe(true);
  });

  it('špatná šablona nebo čas se odmítnou; hráč bez práva nástroj pro turnaje vůbec nevidí', async () => {
    const sp = scripted([call('propose_create_tournament', { name: 'X', templateId: 'neni', settings: [] }), say('nic')]);
    const c = await start({}, sp.provider);
    await c.server.assistant.chat(c.admin, { text: 'turnaj' });
    expect(JSON.parse(toolResults(sp.seen)[0]!).denied.length).toBeGreaterThan(0);
    const r = await c.server.db.select().from(schema.users);
    void r;
    const specsAdmin = (await c.server.assistant.toolSpecs(c.admin)).map((x) => x.name);
    expect(specsAdmin).toContain('propose_create_tournament');
    const hrac = await c.user();
    const roleId = await c.server.perms.createRole(c.admin, { key: 'beztur', name: 'Bez turnajů', power: 5, permissions: [{ key: 'turnaj.vytvorit', effect: 'deny' }] });
    await c.server.perms.assignRole(c.admin, hrac, roleId);
    expect((await c.server.assistant.toolSpecs(hrac)).map((x) => x.name)).not.toContain('propose_create_tournament');
  });

  it('denní limity: na hráče i celkem; vypnutý nástroj model nedostane', async () => {
    const sp = scripted([say('1'), say('2'), say('3'), say('4')]);
    const c = await start({ 'assistant.perUserDaily': 2, 'assistant.globalDaily': 3 }, sp.provider);
    const [a, b] = [await c.user(), await c.user()];
    await c.server.assistant.chat(a, { text: 'a' });
    await c.server.assistant.chat(a, { text: 'b' });
    expect(await code(c.server.assistant.chat(a, { text: 'c' }))).toBe('LIMIT_USER');
    await c.server.assistant.chat(b, { text: 'd' });
    expect(await code(c.server.assistant.chat(b, { text: 'e' }))).toBe('LIMIT_GLOBAL');
    const usage = await c.server.assistant.usage(c.admin);
    expect(usage.totalRequests).toBe(3);
    expect(usage.rows.find((r) => r.userId === a)?.requests).toBe(2);
    expect(usage.rows[0]!.tokens).toBeGreaterThan(0);
    c.clock.advance(86_400_000 * 2);
    expect((await c.server.assistant.status(a)).used).toBe(0);

    const d = await start({ 'assistant.disabledTools': 'list_games, propose_poll' }, scripted([say('x')]).provider);
    expect((await d.server.assistant.toolSpecs(d.admin)).map((x) => x.name)).not.toContain('propose_poll');
    expect(JSON.parse(await d.server.assistant.runTool({ userId: d.admin, source: 'assistant', requestText: '', dryRun: true, proposals: [] }, 'list_games', {})).ok).toBe(false);
  });

  it('selhání poskytovatele se zopakuje a pak vrátí srozumitelnou chybu', async () => {
    let calls = 0;
    const provider: AiProvider = {
      async complete() {
        calls++;
        throw new ProviderError('HTTP 500', 500);
      },
    };
    const c = await start({ 'assistant.retries': 2 }, provider);
    expect(await code(c.server.assistant.chat(c.admin, { text: 'ahoj' }))).toBe('PROVIDER');
    expect(calls).toBe(3);
    expect((await c.server.assistant.test(c.admin)).ok).toBe(false);
  });


  it('prompty: úprava s kontrolou proměnných, verze, návrat, reset; použije se v systémovém promptu', async () => {
    const sp = scripted([say('ok')]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    expect(await code(c.server.assistant.savePrompt(u, 'system', 'text'))).toBe('FORBIDDEN');
    expect(await code(c.server.assistant.savePrompt(c.admin, 'system', 'Ahoj {neznama}'))).toBe('UNKNOWN_VARIABLE');
    expect(await code(c.server.assistant.savePrompt(c.admin, 'ctx.rules', 'Stůl {stul} nejde'))).toBe('UNKNOWN_VARIABLE');
    expect(await code(c.server.assistant.savePrompt(c.admin, 'nic', 'x'))).toBe('NOT_FOUND');
    expect((await c.server.assistant.savePrompt(c.admin, 'system', 'První {prezdivka}')).version).toBe(1);
    expect((await c.server.assistant.savePrompt(c.admin, 'system', 'Druhý {prezdivka}')).version).toBe(2);
    const find = async () => (await c.server.assistant.prompts(c.admin)).find((p) => p.key === 'system')!;
    expect(await find()).toMatchObject({ custom: true, text: 'Druhý {prezdivka}', version: 2 });
    expect((await c.server.assistant.revertPrompt(c.admin, 'system', 1)).version).toBe(3);
    expect((await find()).text).toBe('První {prezdivka}');

    const out = await c.server.assistant.sandbox(c.admin, { text: 'ahoj' });
    expect(out.system.startsWith('První Admin')).toBe(true);
    expect(out.system).not.toContain('{prezdivka}');
    expect(out.system).toContain('lobby'); // kontextový pokyn se dosadil

    expect((await c.server.assistant.promptVersions(c.admin, 'system')).map((v) => v.version)).toEqual([3, 2, 1]);
    await c.server.assistant.resetPrompt(c.admin, 'system');
    const after = await find();
    expect(after.custom).toBe(false);
    expect(after.text).toBe(after.defaultText);
    expect((await c.server.assistant.promptVersions(c.admin, 'system'))[0]).toMatchObject({ version: 4, isDefault: true });
    // návrat k verzi z doby před resetem
    await c.server.assistant.revertPrompt(c.admin, 'system', 2);
    expect((await find()).text).toBe('Druhý {prezdivka}');
    await c.server.assistant.resetPrompt(c.admin, null);
    expect((await find()).custom).toBe(false);
  });

  it('popis nástroje jde přepsat v GUI', async () => {
    const c = await start({}, scripted([]).provider);
    await c.server.assistant.savePrompt(c.admin, 'tool.explain_setting', 'Moje vlastní vysvětlení nástroje.');
    const spec = (await c.server.assistant.toolSpecs(c.admin)).find((x) => x.name === 'explain_setting')!;
    expect(spec.description).toBe('Moje vlastní vysvětlení nástroje.');
    expect((await c.server.assistant.toolSpecs(c.admin)).find((x) => x.name === 'get_settings')!.description).toContain('Vrátí aktuální hodnoty');
  });

  it('pískoviště nic nezapisuje ani neprovádí, ukáže prompt a navržené změny', async () => {
    const sp = scripted([call('propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '9' }] }), say('Navrhuji devět.')]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    expect(await code(c.server.assistant.sandbox(u, { text: 'x' }))).toBe('FORBIDDEN');
    const out = await c.server.assistant.sandbox(c.admin, { text: 'devět trofejí', context: 'admin' });
    expect(out.reply).toBe('Navrhuji devět.');
    expect(out.proposals[0]).toMatchObject({ id: 'dry-1', status: 'pending' });
    expect(out.proposals[0]!.diff[0]).toMatchObject({ key: 'cosmetics.maxTrophies', after: '9 ×' });
    expect(out.system).toContain('Admin');
    expect(await c.server.db.select().from(schema.assistantProposals)).toHaveLength(0);
    expect(await c.server.db.select().from(schema.assistantMessages)).toHaveLength(0);
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(5);
  });

  it('nástroje nevydají tajné ani skryté údaje a čtení je omezené na viditelné parametry', async () => {
    const sp = scripted([call('search_settings', { query: 'heslo klíč api asistent denní' }), call('get_settings', { target: { kind: 'global' }, keys: ['assistant.perUserDaily', 'cosmetics.enabled'] }), call('list_games', {}), say('ok')]);
    const c = await start({}, sp.provider);
    await c.server.tables.createTable(c.admin, { name: 'Pátek', templateId: 'cash-klasika' });
    await c.server.assistant.chat(c.admin, { text: 'co je k dispozici' });
    const [search, get, games] = toolResults(sp.seen);
    expect(search).not.toContain('assistant.');
    expect(JSON.parse(get!).values).toEqual({ 'cosmetics.enabled': true });
    expect(games).not.toMatch(/hole|deck|cards|karty/i);
    expect(JSON.parse(games!).tables[0]).toMatchObject({ name: 'Pátek' });
  });
});

describe('poskytovatelé AI: převod požadavků a odpovědí', () => {
  const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
    model: 'model-x',
    system: 'Systém',
    messages: [{ role: 'user', content: 'Ahoj' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'list_games', args: {} }] }, { role: 'tool', toolCallId: 't1', name: 'list_games', content: '{"ok":true}' }],
    tools: [{ name: 'list_games', description: 'Popis', parameters: { type: 'object', properties: { a: { type: 'string', description: 'A' } }, required: ['a'] } }],
    temperature: 0.2,
    maxTokens: 100,
    timeoutMs: 1000,
    ...over,
  });
  const fakeFetch = (json: unknown, status = 200) => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status, text: async () => JSON.stringify(json) } as Response;
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('Gemini: typy velkými písmeny, funkce a odpověď funkce, spotřeba tokenů', async () => {
    const { f, calls } = fakeFetch({ candidates: [{ content: { parts: [{ text: 'Čau' }, { functionCall: { name: 'list_games', args: { a: 'b' } } }] } }], usageMetadata: { totalTokenCount: 42 } });
    const r = await createProvider('gemini', { apiKey: 'K', fetcher: f }).complete(req());
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com/v1beta/models/model-x:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('K');
    expect(calls[0]!.body.systemInstruction.parts[0].text).toBe('Systém');
    expect(calls[0]!.body.tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
    expect(calls[0]!.body.contents[2].parts[0].functionResponse.name).toBe('list_games');
    expect(r).toMatchObject({ text: 'Čau', tokens: 42, toolCalls: [{ name: 'list_games', args: { a: 'b' } }] });
  });

  it('Gemini 3: thoughtSignature u volání nástroje se uloží a pošle zpět, části „thought“ se nezobrazí', async () => {
    const { f, calls } = fakeFetch({ candidates: [{ content: { parts: [{ text: 'tajné uvažování', thought: true }, { text: 'Viditelné' }, { functionCall: { name: 'list_games', args: {} }, thoughtSignature: 'sig-123' }] } }], usageMetadata: { totalTokenCount: 1 } });
    const p = createProvider('gemini', { apiKey: 'K', fetcher: f });
    const r = await p.complete(req());
    expect(r.text).toBe('Viditelné');
    expect(r.toolCalls[0]).toMatchObject({ name: 'list_games', meta: { thoughtSignature: 'sig-123' } });
    // druhé kolo: odpověď asistenta s voláním nástroje se posílá zpět i s podpisem
    await p.complete(req({ messages: [{ role: 'user', content: 'Ahoj' }, { role: 'assistant', content: '', toolCalls: [r.toolCalls[0]!] }, { role: 'tool', toolCallId: r.toolCalls[0]!.id, name: 'list_games', content: '{}' }] }));
    const modelParts = calls[1]!.body.contents[1].parts;
    expect(modelParts[0]).toMatchObject({ functionCall: { name: 'list_games' }, thoughtSignature: 'sig-123' });
  });

  it('Claude: tool_use a tool_result se spojují do střídajících se zpráv', async () => {
    const { f, calls } = fakeFetch({ content: [{ type: 'text', text: 'Ano' }, { type: 'tool_use', id: 'u1', name: 'list_games', input: { a: 'x' } }], usage: { input_tokens: 5, output_tokens: 7 } });
    const r = await createProvider('anthropic', { apiKey: 'K', fetcher: f }).complete(req());
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': 'K', 'anthropic-version': '2023-06-01' });
    expect(calls[0]!.body.system).toBe('Systém');
    expect(calls[0]!.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(calls[0]!.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(calls[0]!.body.tools[0].input_schema.type).toBe('object');
    expect(r).toMatchObject({ text: 'Ano', tokens: 12, toolCalls: [{ id: 'u1', args: { a: 'x' } }] });
  });

  it('OpenAI a kompatibilní rozhraní: argumenty jsou JSON text, vlastní adresa', async () => {
    const { f, calls } = fakeFetch({ choices: [{ message: { content: null, tool_calls: [{ id: 'o1', function: { name: 'list_games', arguments: '{"a":"z"}' } }] } }], usage: { total_tokens: 9 } });
    const r = await createProvider('openai', { apiKey: 'K', fetcher: f }).complete(req());
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer K');
    expect(calls[0]!.body.messages[0]).toEqual({ role: 'system', content: 'Systém' });
    expect(calls[0]!.body.messages[2].tool_calls[0].function.arguments).toBe('{}');
    expect(r.toolCalls[0]).toMatchObject({ id: 'o1', args: { a: 'z' } });
    await createProvider('compatible', { apiKey: '', baseUrl: 'http://lokalni:11434/v1/', fetcher: f }).complete(req());
    expect(calls[1]!.url).toBe('http://lokalni:11434/v1/chat/completions');
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(() => createProvider('compatible', { apiKey: '' })).toThrow();
  });

  it('chyba poskytovatele nese srozumitelný text', async () => {
    const { f } = fakeFetch({ error: { message: 'Quota exceeded' } }, 429);
    await expect(createProvider('openai', { apiKey: 'K', fetcher: f }).complete(req())).rejects.toMatchObject({ detail: 'Quota exceeded', status: 429 });
  });
});

describe('AI asistent: úspora a ochrana limitů (bezplatný plán)', { timeout: 90_000 }, () => {
  it('jednoduchá otázka na vysvětlení se zodpoví z návodu bez volání AI a nepočítá se do limitů; opakovaná jde na model', async () => {
    const sp = scripted([say('Odpověď modelu.')]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    const first = await c.server.assistant.chat(u, { text: 'co je straddle?', context: 'rules' });
    expect(first.reply).toContain('Z návodu');
    expect(first.reply).toContain('Straddle');
    expect(first.tokens).toBe(0);
    expect(sp.seen).toHaveLength(0); // model se nevolal
    expect((await c.server.assistant.status(u)).used).toBe(0); // nepočítá se do denního limitu
    // stejná otázka znovu = uživatel chce víc: odpoví model
    const again = await c.server.assistant.chat(u, { text: 'co je straddle?', context: 'rules' });
    expect(again.reply).toBe('Odpověď modelu.');
    expect(sp.seen).toHaveLength(1);
    expect((await c.server.assistant.status(u)).used).toBe(1);
    const usage = await c.server.assistant.usage(c.admin);
    expect(usage.totalLocal).toBe(1);
  });

  it('žádosti o změnu, obecné otázky a vypnuté „nejdřív návod“ jdou na model', async () => {
    const sp = scripted([say('a'), say('b'), say('c')]);
    const c = await start({}, sp.provider);
    const u = await c.user();
    await c.server.assistant.chat(u, { text: 'zapni straddle u stolu', context: 'table' }); // žádost o změnu
    await c.server.assistant.chat(u, { text: 'poker', context: 'rules' }); // příliš obecné
    expect(sp.seen).toHaveLength(2);
    const off = await start({ 'assistant.localFirst': false }, scripted([say('x')]).provider);
    const v = await off.user();
    expect((await off.server.assistant.chat(v, { text: 'co je straddle?', context: 'rules' })).reply).toBe('x');
  });

  it('vysvětlování běží na rychlém modelu a bez nástrojů pro návrhy; návrhy změn na hlavním modelu', async () => {
    const sp = scripted([say('ok'), say('ok')]);
    const c = await start({ 'assistant.localFirst': false }, sp.provider);
    await c.server.assistant.chat(c.admin, { text: 'vysvětli mi sázky na turnaj', context: 'rules' });
    await c.server.assistant.chat(c.admin, { text: 'vysvětli mi sázky na turnaj', context: 'admin' });
    expect(sp.seen[0]!.model).toBe('gemini-3.5-flash-lite');
    expect(sp.seen[0]!.tools.some((t) => t.name.startsWith('propose'))).toBe(false);
    expect(sp.seen[1]!.model).toBe('gemini-3.5-flash');
    expect(sp.seen[1]!.tools.some((t) => t.name.startsWith('propose'))).toBe(true);
    // vlastní model pro vysvětlování má přednost
    const own = scripted([say('ok')]);
    const d = await start({ 'assistant.localFirst': false, 'assistant.modelExplain': 'muj-model' }, own.provider);
    await d.server.assistant.chat(d.admin, { text: 'vysvětli mi sázky na turnaj', context: 'rules' });
    expect(own.seen[0]!.model).toBe('muj-model');
  });

  it('limit volání za minutu: nad limit hned srozumitelná chyba, po minutě zase jde', async () => {
    const sp = scripted([say('1'), say('2'), say('3')]);
    const c = await start({ 'assistant.perMinute': 2, 'assistant.localFirst': false }, sp.provider);
    const u = await c.user();
    await c.server.assistant.chat(u, { text: 'otázka jedna dlouhá', context: 'admin' });
    await c.server.assistant.chat(u, { text: 'otázka dvě dlouhá', context: 'admin' });
    expect(await code(c.server.assistant.chat(u, { text: 'otázka tři dlouhá', context: 'admin' }))).toBe('BUSY');
    expect(sp.seen).toHaveLength(2); // třetí volání poskytovatele se vůbec neodeslalo
    c.clock.advance(61_000);
    expect((await c.server.assistant.chat(u, { text: 'otázka čtyři dlouhá', context: 'admin' })).reply).toBe('3');
  });

  it('vyčerpaný limit poskytovatele (429) a vypršený čas se neopakují; celkový strop otázky', async () => {
    let calls = 0;
    const limited: AiProvider = { async complete() { calls++; throw new ProviderError('Resource exhausted', 429); } };
    const c = await start({ 'assistant.retries': 3, 'assistant.localFirst': false }, limited);
    expect(await code(c.server.assistant.chat(c.admin, { text: 'otázka na model', context: 'admin' }))).toBe('PROVIDER_LIMIT');
    expect(calls).toBe(1);

    calls = 0;
    const slow: AiProvider = { async complete() { calls++; throw new ProviderError('TIMEOUT'); } };
    const d = await start({ 'assistant.retries': 3, 'assistant.localFirst': false }, slow);
    expect(await code(d.server.assistant.chat(d.admin, { text: 'otázka na model', context: 'admin' }))).toBe('TIMEOUT');
    expect(calls).toBe(1);

    // celkový strop: druhé volání nastane až po uplynutí stropu, takže se už neodešle
    let n = 0;
    const clockRef: { advance?: (ms: number) => void } = {};
    const stepper: AiProvider = { async complete() { n++; clockRef.advance!(70_000); return { text: '', toolCalls: [{ id: 'x', name: 'list_games', args: {} }], tokens: 1 }; } };
    const e = await start({ 'assistant.totalTimeoutSeconds': 60, 'assistant.localFirst': false }, stepper);
    clockRef.advance = (ms) => e.clock.advance(ms);
    expect(await code(e.server.assistant.chat(e.admin, { text: 'otázka na model', context: 'admin' }))).toBe('TIMEOUT');
    expect(n).toBe(1);
  });

  it('dlouhý výsledek nástroje se zkrátí na nastavený počet znaků', async () => {
    const { clipTool } = await import('./service.js');
    expect(clipTool('a'.repeat(50), 100)).toBe('a'.repeat(50));
    const clipped = clipTool('b'.repeat(500), 100);
    expect(clipped.startsWith('b'.repeat(100))).toBe(true);
    expect(clipped).toContain('zkráceno');
    expect(clipped.length).toBeLessThan(200);
  });
});
