import type { Server, Socket } from 'socket.io';
import { accounts, type CashService, type Ledger, LedgerError, LedgerGuardError } from '@kb/ledger';
import { clientMessages, type ClientMessageName, type PermissionChecker, type SettingValues } from '@kb/shared';
import { GameError, type PlayerAction, type TableActor } from '@kb/game-core';
import { z } from 'zod';
import { registerChatSocket } from './chat/gateway.js';
import type { ChatService } from './chat/service.js';

export interface GatewayDeps {
  chat?: ChatService;
  io: Server;
  ledger: Ledger;
  cash: CashService;
  /** Aktuální (globální) nastavení; limity se čtou při každé zprávě. */
  settings: () => SettingValues;
  tables: Map<string, TableActor>;
  /** Přihlášení spojení (cookie relace): vrací uživatele nebo null. */
  authenticate: (socket: Socket) => Promise<{ userId: string; name: string } | null>;
  perms: PermissionChecker;
}

type Ack = (r: { ok: true; data?: unknown } | { ok: false; code: string; params?: Record<string, unknown> }) => void;

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Jednotný řetězec pro každou zprávu: autentizace → rate limit → validace schématem →
 * oprávnění → handler. Žádný handler se nesmí registrovat mimo `handle`.
 */
export function setupGateway(deps: GatewayDeps) {
  const { io, tables } = deps;
  const connections = new Map<string, number>();
  const subscriptions = new Map<string, Set<string>>(); // socket.id -> tableIds

  const walletOf = (userId: string) => deps.ledger.balance(accounts.wallet(userId));
  const sendWallet = (userId: string) => io.to(`user:${userId}`).emit('wallet', { balance: walletOf(userId) });

  function broadcast(tableId: string) {
    const table = tables.get(tableId);
    if (!table) return;
    for (const [, socket] of io.sockets.sockets) {
      if (!subscriptions.get(socket.id)?.has(tableId)) continue;
      const user = socket.data.user as { userId: string } | undefined;
      socket.emit('table:view', { tableId, view: table.viewFor(user?.userId ?? null), serverTime: Date.now() });
    }
    const seated = table.playersSeated();
    for (const s of seated) sendWallet(s.userId);
  }

  /** Kdo je online a kdo sedí u stolu. */
  const presence = () => {
    const seen = new Map<string, { userId: string; nickname: string; status: 'online' | 'table' }>();
    for (const [, s] of io.sockets.sockets) {
      const u = s.data.user as { userId: string; name: string } | undefined;
      if (!u) continue;
      const atTable = [...tables.values()].some((t) => t.playersSeated().some((p) => p.userId === u.userId));
      seen.set(u.userId, { userId: u.userId, nickname: u.name, status: atTable ? 'table' : 'online' });
    }
    return [...seen.values()];
  };
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  const broadcastPresence = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      io.emit('presence', presence());
    }, 300);
    presenceTimer.unref?.();
  };

  io.use(async (socket, next) => {
    try {
      const user = await deps.authenticate(socket);
      if (!user) return next(new Error('NOT_LOGGED_IN'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('NOT_LOGGED_IN'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as { userId: string; name: string };
    socket.join(`user:${user.userId}`);
    connections.set(user.userId, (connections.get(user.userId) ?? 0) + 1);
    subscriptions.set(socket.id, new Set());

    socket.emit('hello', { userId: user.userId, name: user.name, balance: walletOf(user.userId) });

    // Připojení z dalšího zařízení nebo po výpadku: hráč u stolu dostane plný stav.
    for (const [id, table] of tables) {
      if (table.playersSeated().some((s) => s.userId === user.userId)) {
        table.setConnected(user.userId, true);
        // Turnaj: hráč, který začal v sit outu (nebyl online), se po připojení sám vrátí do hry.
        if (table.viewFor(user.userId).info.tournament) {
          try {
            table.sitIn(user.userId);
          } catch {
            // už sedí ve hře, nebo nemá žetony
          }
        }
        subscriptions.get(socket.id)!.add(id);
        socket.join(`table:${id}`);
        socket.emit('table:view', { tableId: id, view: table.viewFor(user.userId), serverTime: Date.now() });
      }
    }

    const bucket: Bucket = { tokens: Number(deps.settings()['system.rateLimitBurst']), at: Date.now() };
    const allow = () => {
      const s = deps.settings();
      const now = Date.now();
      bucket.tokens = Math.min(Number(s['system.rateLimitBurst']), bucket.tokens + ((now - bucket.at) / 1000) * Number(s['system.rateLimitPerSecond']));
      bucket.at = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    };

    // Hlášky hlasatele: klient na stránce turnaje nebo živé hry se přihlásí do místnosti „announce:<id>“.
    socket.on('announce:join', (id: unknown) => {
      if (typeof id === 'string' && id.length <= 80 && deps.perms.can(user.userId, 'stul.zobrazit').allowed) void socket.join(`announce:${id}`);
    });
    socket.on('announce:leave', (id: unknown) => {
      if (typeof id === 'string' && id.length <= 80) void socket.leave(`announce:${id}`);
    });

    if (deps.chat) registerChatSocket(socket, { io, chat: deps.chat, user, allow, presence });
    broadcastPresence();

    function handle<N extends ClientMessageName>(
      name: N,
      permission: string,
      fn: (msg: z.infer<(typeof clientMessages)[N]>, table: TableActor | undefined) => unknown,
    ) {
      (socket as unknown as { on(ev: string, fn: (...a: any[]) => void): void }).on(name, (raw: unknown, ack?: Ack) => {
        const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
        if (!allow()) return reply({ ok: false, code: 'RATE_LIMITED' });
        const parsed = clientMessages[name].safeParse(raw);
        if (!parsed.success) return reply({ ok: false, code: 'INVALID_MESSAGE' });
        const msg = parsed.data as z.infer<(typeof clientMessages)[N]>;
        const tableIdValue = (msg as { tableId: string }).tableId;
        const decision = deps.perms.can(user.userId, permission, { scopeType: 'table', scopeId: tableIdValue });
        if (!decision.allowed) return reply({ ok: false, code: 'PERMISSION_DENIED' });
        const table = tables.get(tableIdValue);
        if (!table) return reply({ ok: false, code: 'NO_TABLE' });
        try {
          const data = fn(msg, table);
          reply({ ok: true, data });
          sendWallet(user.userId);
        } catch (e) {
          if (e instanceof GameError) return reply({ ok: false, code: e.code, params: e.context });
          if (e instanceof LedgerError) return reply({ ok: false, code: e.code, ...(e instanceof LedgerGuardError ? { params: e.params } : {}) });
          // Neočekávaná chyba: stůl se zastavil sám, klient dostane obecnou hlášku, detail jde do logu.
          console.error(`[${name}]`, e);
          reply({ ok: false, code: 'UNKNOWN' });
        }
      });
    }

    handle('table:subscribe', 'stul.zobrazit', ({ tableId }, table) => {
      subscriptions.get(socket.id)!.add(tableId);
      socket.join(`table:${tableId}`);
      socket.emit('table:view', { tableId, view: table!.viewFor(user.userId), serverTime: Date.now() });
    });
    handle('table:unsubscribe', 'stul.zobrazit', ({ tableId }) => {
      subscriptions.get(socket.id)!.delete(tableId);
      socket.leave(`table:${tableId}`);
    });
    handle('table:join', 'stul.hrat', ({ tableId, seat, amount }, table) => {
      table!.join(user.userId, user.name, seat, amount);
      subscriptions.get(socket.id)!.add(tableId);
      socket.join(`table:${tableId}`);
      broadcastPresence();
    });
    handle('table:leave', 'stul.hrat', (_m, table) => {
      table!.leave(user.userId);
      broadcastPresence();
    });
    handle('table:topUp', 'stul.hrat', ({ amount }, table) => table!.topUp(user.userId, amount));
    handle('table:sitOut', 'stul.hrat', (_m, table) => table!.sitOut(user.userId));
    handle('table:sitIn', 'stul.hrat', (_m, table) => table!.sitIn(user.userId));
    handle('table:straddle', 'stul.hrat', ({ want }, table) => table!.setStraddle(user.userId, want));
    handle('table:callClock', 'stul.hrat', (_m, table) => table!.callClock(user.userId));
    handle('table:show', 'stul.hrat', ({ which }, table) => table!.showCards(user.userId, which));
    handle('table:showdown', 'stul.hrat', ({ choice }, table) => table!.showdownChoice(user.userId, choice));
    handle('table:rabbit', 'stul.hrat', (_m, table) => table!.rabbitHunt(user.userId));
    handle('table:ready', 'stul.hrat', ({ ready }, table) => table!.setReady(user.userId, ready));
    handle('table:vote', 'stul.hrat', ({ yes }, table) => table!.voteRunIt(user.userId, yes));
    handle('table:act', 'stul.hrat', ({ action }, table) => table!.act(user.userId, action as PlayerAction));

    socket.on('disconnect', () => {
      subscriptions.delete(socket.id);
      const left = (connections.get(user.userId) ?? 1) - 1;
      if (left <= 0) {
        connections.delete(user.userId);
        for (const table of tables.values()) table.setConnected(user.userId, false);
      } else connections.set(user.userId, left);
      broadcastPresence();
    });
  });

  /** Je uživatel právě připojený (aspoň jedno zařízení)? */
  const isOnline = (userId: string) => (connections.get(userId) ?? 0) > 0;
  return { broadcast, presence, broadcastPresence, isOnline };
}
