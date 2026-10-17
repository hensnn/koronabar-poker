import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { accounts } from '@kb/ledger';
import type { TableView } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
type TestSocket = Socket & { views: TableView[]; last(): TableView | undefined };
const open: { servers: Server[]; sockets: Socket[]; dirs: string[] } = { servers: [], sockets: [], dirs: [] };

const FAST = { 'time.betweenHandsMs': 50, 'time.allInRunoutDelayMs': 20, 'time.allInRiverDramaMs': 20, 'time.showdownMs': 20, 'time.potToWinnerMs': 20, 'odds.enabled': false };

async function start(opts: { global?: Record<string, number | boolean | string>; table?: Record<string, unknown>; dataDir?: string } = {}) {
  const server = await buildServer({
    dataDir: opts.dataDir,
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...opts.global },
    tableSettings: { ...FAST, ...opts.table },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    onFatal: (e) => {
      throw e;
    },
  });
  const port = await server.listen(0);
  open.servers.push(server);
  return { server, url: `http://localhost:${port}` };
}

/** Založí hráče přes pozvánku a vrátí cookie s relací. */
async function player(server: Server, nick: string) {
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, { maxUses: 1 });
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
  const { token } = await server.accounts.login(nick, 'heslo-hrace-123');
  return { userId, cookie: `kb_session=${token}`, token };
}

function client(url: string, cookie: string | null, origin?: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    }) as TestSocket;
    s.views = [];
    s.last = () => s.views[s.views.length - 1];
    s.on('table:view', (m: { view: TableView }) => s.views.push(m.view));
    open.sockets.push(s);
    s.on('hello', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}
const call = (s: Socket, ev: string, data: unknown) => new Promise<{ ok: boolean; code?: string; data?: unknown }>((r) => s.emit(ev, data, r));
const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(async () => {
  for (const s of open.sockets) s.close();
  open.sockets = [];
  for (const s of open.servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('server: Socket.IO brána s účty a oprávněními', () => {
  it('bez přihlášení, s neplatnou relací nebo z cizího původu se spojení odmítne', async () => {
    const { url, server } = await start();
    await expect(client(url, null)).rejects.toThrow('NOT_LOGGED_IN');
    await expect(client(url, 'kb_session=neplatny')).rejects.toThrow('NOT_LOGGED_IN');
    const a = await player(server, 'Alice');
    await expect(client(url, a.cookie, 'https://evil.example')).rejects.toThrow('NOT_LOGGED_IN');
    await expect(client(url, a.cookie, 'http://localhost')).resolves.toBeDefined();
  });

  it('nový hráč dostane počáteční vklad přes účetní knihu (a jen jednou)', async () => {
    const { url, server } = await start();
    const a = await player(server, 'Alice');
    expect(server.ledger.balance(accounts.wallet(a.userId))).toBe(10_000);
    const s1 = await client(url, a.cookie);
    s1.close();
    await client(url, a.cookie);
    expect(server.ledger.balance(accounts.wallet(a.userId))).toBe(10_000);
    await server.journal.flush();
  });

  it('každá zpráva se validuje a kontroluje (špatná zpráva, neexistující stůl, tah mimo pořadí)', async () => {
    const { url, server } = await start();
    const a = await client(url, (await player(server, 'Alice')).cookie);
    expect((await call(a, 'table:join', { tableId: 'stul-1', seat: 'x', amount: 5 })).code).toBe('INVALID_MESSAGE');
    expect((await call(a, 'table:join', { tableId: 'nic', seat: 0, amount: 500 })).code).toBe('NO_TABLE');
    expect((await call(a, 'table:act', { tableId: 'stul-1', action: { type: 'raise' } })).code).toBe('INVALID_MESSAGE');
    expect((await call(a, 'table:act', { tableId: 'stul-1', action: { type: 'fold' } })).code).toBe('NOT_SEATED');
    expect((await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 10 })).code).toBe('BUYIN_TOO_SMALL');
    expect((await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 999_999 })).code).toBe('BUYIN_TOO_LARGE');
  });

  it('oprávnění se kontroluje na serveru a změna rolí se projeví okamžitě', async () => {
    const { url, server } = await start({ global: { 'system.emailVerificationRequired': true } });
    const nov = await player(server, 'Novacek');
    const [admin] = server.perms.mainAdminIds();
    const s = await client(url, nov.cookie);
    // Nováček smí sledovat, ale ne hrát.
    expect((await call(s, 'table:subscribe', { tableId: 'stul-1' })).ok).toBe(true);
    expect((await call(s, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 })).code).toBe('PERMISSION_DENIED');
    expect((await call(s, 'table:act', { tableId: 'stul-1', action: { type: 'fold' } })).code).toBe('PERMISSION_DENIED');
    await server.perms.assignRole(admin!, nov.userId, server.perms.roleByKey('hrac')!.id);
    expect((await call(s, 'table:join', { tableId: 'stul-1', seat: 0, amount: 10 })).code).toBe('BUYIN_TOO_SMALL');
  });

  it('hráči vidí jen své karty, přihlížející žádné, a hra běží až do výhry', async () => {
    const { url, server } = await start();
    const [pa, pb, pc] = [await player(server, 'Alice'), await player(server, 'Bob'), await player(server, 'Carol')];
    const [a, b, c] = [await client(url, pa.cookie), await client(url, pb.cookie), await client(url, pc.cookie)];
    expect((await call(c, 'table:subscribe', { tableId: 'stul-1' })).ok).toBe(true);
    expect((await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 1000 })).ok).toBe(true);
    expect((await call(b, 'table:join', { tableId: 'stul-1', seat: 1, amount: 1000 })).ok).toBe(true);
    await until(() => a.last()?.street === 'PREFLOP' && b.last()?.street === 'PREFLOP');

    const table = server.tables.get('stul-1')!;
    const holeA = table.viewFor(pa.userId).seats.find((s) => s.playerId === pa.userId)!.cards!;
    const holeB = table.viewFor(pb.userId).seats.find((s) => s.playerId === pb.userId)!.cards!;
    const json = (s: TestSocket) => JSON.stringify(s.views);
    for (const card of holeB) expect(json(a)).not.toContain(`"${card}"`);
    for (const card of holeA) expect(json(b)).not.toContain(`"${card}"`);
    for (const card of [...holeA, ...holeB]) expect(json(c)).not.toContain(`"${card}"`);
    for (const card of holeA) expect(json(a)).toContain(`"${card}"`);

    const first = a.last()!.legal ? a : b;
    const other = first === a ? b : a;
    expect((await call(other, 'table:act', { tableId: 'stul-1', action: { type: 'fold' } })).code).toBe('NOT_YOUR_TURN');
    expect((await call(first, 'table:act', { tableId: 'stul-1', action: { type: 'check' } })).ok).toBe(false);
    expect((await call(first, 'table:act', { tableId: 'stul-1', action: { type: 'fold' } })).ok).toBe(true);
    await until(() => a.views.some((v) => !!v.winners) && b.views.some((v) => !!v.winners), 15000);
    expect(a.views.find((v) => v.winners)!.winners![0]!.amount).toBe(10);
    expect(server.ledger.balance(accounts.table('stul-1'))).toBe(2000);
  });

  it('druhé zařízení téhož hráče dostane stav u stolu hned po přihlášení', async () => {
    const { url, server } = await start();
    const pa = await player(server, 'Alice');
    const pb = await player(server, 'Bob');
    const a1 = await client(url, pa.cookie);
    const b = await client(url, pb.cookie);
    await call(a1, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    await call(b, 'table:join', { tableId: 'stul-1', seat: 1, amount: 500 });
    await until(() => a1.last()?.street === 'PREFLOP');
    const a2 = await client(url, pa.cookie);
    await until(() => a2.views.length > 0);
    expect(a2.last()!.viewerSeat).toBe(0);
    expect(a2.last()!.seats.find((s) => s.playerId === pa.userId)!.cards).toHaveLength(2);
  });

  it('odchod vrátí žetony do peněženky a rate limit odmítne zahlcení', async () => {
    const { url, server } = await start({ global: { 'system.rateLimitBurst': 5, 'system.rateLimitPerSecond': 1 } });
    const pa = await player(server, 'Alice');
    const a = await client(url, pa.cookie);
    expect((await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 })).ok).toBe(true);
    expect((await call(a, 'table:leave', { tableId: 'stul-1' })).ok).toBe(true);
    expect(server.ledger.balance(accounts.wallet(pa.userId))).toBe(10_000);
    const results: (string | undefined)[] = [];
    for (let i = 0; i < 10; i++) results.push((await call(a, 'table:sitIn', { tableId: 'stul-1' })).code);
    expect(results).toContain('RATE_LIMITED');
  });

  it('dobrovolný straddle: vypnutý stůl ho odmítne, zapnutý přijme a pohled to ukáže', async () => {
    const off = await start();
    const a = await client(off.url, (await player(off.server, 'Alice')).cookie);
    await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    expect((await call(a, 'table:straddle', { tableId: 'stul-1', want: true })).code).toBe('STRADDLE_DISABLED');
    expect((await call(a, 'table:straddle', { tableId: 'stul-1', want: 'ano' })).code).toBe('INVALID_MESSAGE');
    a.close();
    await off.server.close();
    open.servers.pop();
    const on = await start({ table: { 'table.straddleEnabled': true, 'table.straddleMandatory': false } });
    const b = await client(on.url, (await player(on.server, 'Bob')).cookie);
    await call(b, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    expect((await call(b, 'table:straddle', { tableId: 'stul-1', want: true })).ok).toBe(true);
    await until(() => b.last()?.myStraddle === true);
    expect(b.last()!.info.straddle).toBe('optional');
  });

  it('osobní nastavení, změna rolí a peněženka se okamžitě projeví na všech zařízeních hráče', async () => {
    const { url, server } = await start();
    const pa = await player(server, 'Alice');
    const a1 = await client(url, pa.cookie);
    const a2 = await client(url, pa.cookie);
    const got: Record<string, unknown>[] = [];
    a2.on('settings:changed', (m) => got.push({ type: 'settings', ...m }));
    a2.on('permissions:changed', () => got.push({ type: 'permissions' }));
    a2.on('wallet', (m) => got.push({ type: 'wallet', ...m }));
    await server.settings.set(pa.userId, 'user', pa.userId, 'ui.colorMode', 'dark');
    await server.settings.set(pa.userId, 'userDevice', pa.userId + ':mobil', 'ui.soundVolumePercent', 10);
    const [admin] = server.perms.mainAdminIds();
    await server.perms.assignRole(admin!, pa.userId, server.perms.roleByKey('moderator')!.id);
    server.cash.mint(pa.userId, 5, 'bonus');
    await call(a1, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    await until(() => got.some((g) => g.type === 'wallet'));
    expect(got).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'settings', scope: 'user', key: 'ui.colorMode', value: 'dark', device: null }),
      expect.objectContaining({ type: 'settings', scope: 'userDevice', key: 'ui.soundVolumePercent', value: 10, device: 'mobil' }),
      expect.objectContaining({ type: 'permissions' }),
    ]));
  });

  it('odpojení všech zařízení hráče ho označí jako odpojeného', async () => {
    const { url, server } = await start();
    const a = await client(url, (await player(server, 'Alice')).cookie);
    await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    a.close();
    await until(() => !server.tables.get('stul-1')!.playersSeated()[0]!.connected);
  });

  it('po restartu serveru se stůl, žetony hráčů a peněženky obnoví z databáze a součty sedí', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-pglite-'));
    open.dirs.push(dir);
    const first = await start({ dataDir: dir });
    const pa = await player(first.server, 'Alice');
    const pb = await player(first.server, 'Bob');
    const a = await client(first.url, pa.cookie);
    const b = await client(first.url, pb.cookie);
    await call(a, 'table:join', { tableId: 'stul-1', seat: 0, amount: 800 });
    await call(b, 'table:join', { tableId: 'stul-1', seat: 1, amount: 600 });
    await first.server.journal.flush();
    await first.server.close();
    open.servers.pop();

    const second = await start({ dataDir: dir });
    const table = second.server.tables.get('stul-1')!;
    expect(table.playersSeated().map((s) => [s.userId, s.chips]).sort()).toEqual([[pa.userId, 800], [pb.userId, 600]].sort());
    expect(second.server.ledger.balance(accounts.wallet(pa.userId))).toBe(10_000 - 800);
    expect(second.server.ledger.balance(accounts.table('stul-1'))).toBe(1400);
    expect(table.totalChips()).toBe(1400);
    // hráč se po restartu přihlásí znovu a vidí svůj stůl
    const { token } = await second.server.accounts.login('Alice', 'heslo-hrace-123');
    const a2 = await client(second.url, `kb_session=${token}`);
    await until(() => a2.views.length > 0);
    expect(a2.last()!.viewerSeat).toBe(0);
  });
});
