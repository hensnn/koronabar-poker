import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from '../app.js';
import { schema } from '../db/index.js';

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
    masterKey: { key: Buffer.alloc(32, 43), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'mcp.enabled': true, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const rpc = async (token: string | null, method: string, params?: unknown, id: number | null = 1) => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params } as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    const content = r.json.result.content[0].text as string;
    return { isError: r.json.result.isError as boolean, data: JSON.parse(content) };
  };
  const token = async (userId: string, scopes = ['mcp']) => (await server.apiTokens.create(userId, { name: 'Claude', scopes, expiresInDays: 30 })).token;
  return { server, clock, admin: admin!, rpc, call, token };
}

describe('MCP server', { timeout: 90_000 }, () => {
  it('handshake, seznam nástrojů a ochrana: bez tokenu, bez rozsahu a při vypnutí', async () => {
    const c = await start();
    expect((await c.rpc(null, 'initialize')).status).toBe(401);
    const tok = await c.token(c.admin);
    const init = await c.rpc(tok, 'initialize', { protocolVersion: '2025-03-26' });
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'KoronaBar Poker' } });
    expect((await c.rpc(tok, 'notifications/initialized', undefined, null)).status).toBe(202);
    expect((await c.rpc(tok, 'ping')).json.result).toEqual({});
    const list = await c.rpc(tok, 'tools/list');
    const names = list.json.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['search_settings', 'propose_settings_change', 'confirm_proposal', 'list_proposals']));
    expect(list.json.result.tools[0].inputSchema.type).toBe('object');
    expect((await c.rpc(tok, 'neznama/metoda')).json.error.code).toBe(-32601);

    const other = await c.server.apiTokens.create(c.admin, { name: 'Jiny', scopes: ['wallet:read'], expiresInDays: 5 });
    expect((await c.rpc(other.token, 'tools/list')).status).toBe(403);
    await c.server.settings.set(c.admin, 'global', '', 'mcp.enabled', false);
    expect((await c.rpc(tok, 'tools/list')).status).toBe(503);
  });

  it('hráč bez oprávnění k MCP token s rozsahem mcp nevytvoří', async () => {
    const c = await start();
    const inv = await c.server.accounts.createInvite(c.admin, {});
    const { userId } = await c.server.accounts.register({ inviteCode: inv, nickname: 'Hrac1', email: 'h@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    await expect(c.server.apiTokens.create(userId, { name: 'Pokus', scopes: ['mcp'], expiresInDays: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('změna se navrhne jedním voláním a provede teprve druhým; audit nese značku MCP', async () => {
    const c = await start();
    const tok = await c.token(c.admin);
    const found = await c.call(tok, 'search_settings', { query: 'maximální počet trofejí' });
    expect(JSON.stringify(found.data)).toContain('cosmetics.maxTrophies');
    const proposed = await c.call(tok, 'propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '9' }] });
    expect(proposed.data.ok).toBe(true);
    expect(proposed.data.proposals[0].diff[0]).toMatchObject({ before: '5 ×', after: '9 ×' });
    expect(proposed.data.instruction).toContain('confirm_proposal');
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(5);
    const pending = await c.call(tok, 'list_proposals');
    expect(pending.data.proposals).toHaveLength(1);
    const id = proposed.data.proposals[0].id;
    const done = await c.call(tok, 'confirm_proposal', { proposalId: id, edits: { 'cosmetics.maxTrophies': 11 } });
    expect(done.data).toMatchObject({ ok: true, status: 'applied' });
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(11);
    const audit = (await c.server.db.select().from(schema.auditLog)).filter((a) => a.action === 'nastaveni.zmena').at(-1);
    expect(audit).toMatchObject({ source: 'mcp' });
    expect((await c.call(tok, 'confirm_proposal', { proposalId: id })).data.ok).toBe(false); // už vyřízeno
    const rejected = await c.call(tok, 'propose_settings_change', { target: { kind: 'global' }, changes: [{ key: 'cosmetics.maxTrophies', value: '3' }] });
    expect((await c.call(tok, 'reject_proposal', { proposalId: rejected.data.proposals[0].id })).data).toMatchObject({ ok: true, status: 'rejected' });
    expect(c.server.settings.resolve()['cosmetics.maxTrophies']).toBe(11);
  });

  it('vypnutý nástroj se nenabídne ani nespustí a volání jsou v logu', async () => {
    const c = await start({ 'mcp.disabledTools': 'propose_poll, list_games' });
    const tok = await c.token(c.admin);
    const names = (await c.rpc(tok, 'tools/list')).json.result.tools.map((x: { name: string }) => x.name);
    expect(names).not.toContain('propose_poll');
    expect(names).not.toContain('list_games');
    const blocked = await c.call(tok, 'list_games');
    expect(blocked.isError).toBe(true);
    await c.call(tok, 'list_templates', { kind: 'cash' });
    const log = await c.server.mcp.log();
    expect(log.map((l) => `${l.tool}:${l.ok}`)).toEqual(expect.arrayContaining(['list_games:false', 'list_templates:true']));
    expect(log[0]!.nickname).toBe('Admin');
    const tools = await c.server.mcp.tools(c.admin, true);
    expect(tools.find((x) => x.name === 'list_games')).toMatchObject({ enabled: false });
  });

  it('dávka více zpráv v jednom požadavku', async () => {
    const c = await start();
    const tok = await c.token(c.admin);
    const res = await c.server.app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${tok}` },
      payload: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }] as unknown as object,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).map((r: { id: number }) => r.id)).toEqual([1, 2]);
    expect((await c.server.app.inject({ method: 'GET', url: '/api/mcp', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(405);
  });
});
