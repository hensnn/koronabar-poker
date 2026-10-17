/**
 * Vývojový bot: přihlásí se (nebo si přes pozvánku vytvoří účet) a hraje náhodné legální akce.
 * Spuštění (server musí běžet):
 *   pnpm --filter @kb/server exec tsx scripts/dev-bot.ts [přezdívka] [místo] [stůl nebo id turnaje (t-…)] [url]
 * Správce se bere z ADMIN_NICKNAME a ADMIN_PASSWORD (výchozí jako v .claude/launch.json).
 */
import { io } from 'socket.io-client';
import { randomLegalAction } from '@kb/game-core';
import type { TableView } from '@kb/game-core';

const [nick = 'Bot', seatArg = '4', tableId = 'stul-1', url = 'http://localhost:3000'] = process.argv.slice(2);
const adminNick = process.env.ADMIN_NICKNAME ?? 'Majitel';
const adminPass = process.env.ADMIN_PASSWORD ?? 'vyvoj-heslo-123';
const password = 'bot-heslo-12345';

async function call(method: string, path: string, body: unknown, cookie = '') {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any, cookie: set ? set.split(';')[0]! : '' };
}

async function sessionCookie(): Promise<string> {
  let r = await call('POST', '/api/auth/login', { identifier: nick, password });
  if (r.status === 200) return r.cookie;
  const admin = await call('POST', '/api/auth/login', { identifier: adminNick, password: adminPass });
  const inv = await call('POST', '/api/admin/invites', {}, admin.cookie);
  await call('POST', '/api/auth/register', { inviteCode: inv.json.code, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password, acceptTerms: true });
  // bez ověření e-mailu má účet roli Nováček: správce ho ověří ručně
  const users = await fetch(url + '/api/admin/users', { headers: { cookie: admin.cookie } }).then((x) => x.json() as Promise<any[]>);
  const me = users.find((u) => u.nickname === nick);
  if (me && !me.emailVerified) await call('POST', `/api/admin/users/${me.id}/verify-email`, {}, admin.cookie);
  r = await call('POST', '/api/auth/login', { identifier: nick, password });
  return r.cookie;
}

const cookie = await sessionCookie();
const isTournament = tableId.startsWith('t-');
if (isTournament) {
  const r = await call('POST', `/api/tournaments/${tableId}/register`, {}, cookie);
  console.log('registrace do turnaje', r.status, r.json);
}
const socket = io(url, { transports: ['websocket'], extraHeaders: { cookie } });
let userId = '';
let joined = false;
const emit = (ev: string, data: unknown) => new Promise<any>((r) => socket.emit(ev, data, r));

socket.on('hello', async (m: { userId: string }) => {
  userId = m.userId;
  await emit('table:subscribe', { tableId });
});

socket.on('table:view', async (m: { view: TableView }) => {
  const v = m.view;
  if (!isTournament && !joined && !v.seats.some((s) => s.playerId === userId)) {
    joined = true;
    const r = await emit('table:join', { tableId, seat: Number(seatArg), amount: Math.ceil((v.info.minBuyIn / v.info.chipsPerCurrencyUnit) * 2) });
    console.log('join', r);
    return;
  }
  const me = v.seats.find((s) => s.playerId === userId);
  if (me && me.status === 'sittingOut') await emit('table:sitIn', { tableId });
  if (v.legal && v.viewerSeat === v.actingSeat) {
    const action = randomLegalAction(v.legal, Math.random);
    setTimeout(() => void emit('table:act', { tableId, action }), 800 + Math.random() * 1500);
  }
});
socket.on('connect_error', (e) => console.error('Připojení selhalo:', e.message));
