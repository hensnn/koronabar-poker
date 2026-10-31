/**
 * Simulace hry: skutečný server (Socket.IO brána, účty, účetní kniha, PGlite v paměti) a několik botů,
 * kteří hrají náhodné legální tahy a navíc dělají neplechu (sit out, top-up, odchody, odpojení, pauza, změny nastavení).
 * Průběžně se kontrolují invarianty: součet účetní knihy, žetony u stolů proti knize, zaseknutí hry, chyby serveru.
 *
 *   pnpm --filter @kb/server exec tsx scripts/simulate.ts [cash|tournament|all] [sekundy] [seed]
 */
import { io, type Socket } from 'socket.io-client';
import { accounts } from '@kb/ledger';
import { randomLegalAction, seededRandom } from '@kb/game-core';
import type { TableView } from '@kb/game-core';
import { buildServer } from '../src/app.js';

const mode = process.argv[2] ?? 'all';
const seconds = Number(process.argv[3] ?? 60);
const seed = Number(process.argv[4] ?? Date.now() % 100000);
const rnd = seededRandom(seed);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const problems: string[] = [];
const problem = (msg: string) => {
  if (!problems.includes(msg)) {
    problems.push(msg);
    console.log('  ✗ PROBLÉM:', msg);
  }
};
const origError = console.error;
console.error = (...a: unknown[]) => {
  const text = a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ');
  problem('server.console.error: ' + text.slice(0, 400));
  origError(...a);
};

const FAST = { 'time.betweenHandsMs': 40, 'time.allInRunoutDelayMs': 20, 'time.allInRiverDramaMs': 20, 'time.showdownMs': 20, 'time.potToWinnerMs': 20, 'odds.enabled': false, 'time.turnSeconds': 4, 'time.timeBankSeconds': 3 };

/** Hodnoty pro stoly/turnaje založené přes API (musí projít validací kroků nastavení). */
const FAST_API = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 0, 'time.allInRiverDramaMs': 0, 'time.showdownMs': 0, 'time.potToWinnerMs': 0, 'odds.enabled': false, 'time.turnSeconds': 4, 'time.timeBankSeconds': 3 };

console.log(`Simulace: režim=${mode}, ${seconds}s, seed=${seed}`);
const server = await buildServer({
  settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'system.mailRequestsPerHour': 1000 },
  tableSettings: FAST,
  bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
  defaultTable: false,
  onFatal: (e) => problem('FATAL: ' + (e instanceof Error ? e.message : String(e))),
});
const port = await server.listen(0);
const url = `http://localhost:${port}`;
const [admin] = server.perms.mainAdminIds();

interface Bot {
  n: number;
  id: string;
  nick: string;
  cookie: string;
  socket: Socket;
  tables: Set<string>;
  views: Map<string, TableView>;
  paused: boolean;
  acted: Set<string>;
  pending: Set<(r: { ok: boolean; code?: string }) => void>;
}
const bots: Bot[] = [];
let unknownReplies = 0;

async function makeBot(n: number): Promise<Bot> {
  const nick = `Bot${n}`;
  const inv = await server.accounts.createInvite(admin!, { maxUses: 1 });
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
  const { token } = await server.accounts.login(nick, 'heslo-hrace-123');
  // různé osobní volby pro showdown: ukázat / zeptat se / muck, a výherní karty bez showdownu
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  await server.settings.set(userId, 'user', userId, 'ui.showdownLosing', pick(['show', 'ask', 'muck']));
  await server.settings.set(userId, 'user', userId, 'ui.showdownWinning', pick(['never', 'ask', 'always']));
  // osobní předvolby automatických odpovědí na turnajové dotazy (rebuy, nový vstup, add-on)
  for (const key of ['ui.autoRebuy', 'ui.autoReenter', 'ui.autoAddon']) await server.settings.set(userId, 'user', userId, key, pick(['ask', 'ask', 'never', 'always']));
  const bot: Bot = { n, id: userId, nick, cookie: `kb_session=${token}`, socket: undefined as never, tables: new Set(), views: new Map(), paused: false, acted: new Set(), pending: new Set() };
  await connect(bot);
  return bot;
}

function connect(bot: Bot): Promise<void> {
  return new Promise((resolve) => {
    const s = io(url, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: bot.cookie } });
    bot.socket = s;
    s.on('disconnect', () => {
      for (const r of bot.pending) r({ ok: false, code: 'OFFLINE' });
      bot.pending.clear();
    });
    s.on('hello', () => {
      for (const t of bot.tables) void emit(bot, 'table:subscribe', { tableId: t });
      resolve();
    });
    s.on('connect_error', (e) => problem(`${bot.nick}: connect_error ${e.message}`));
    s.on('table:view', (m: { tableId: string; view: TableView }) => {
      bot.views.set(m.tableId, m.view);
      play(bot, m.tableId, m.view);
    });
  });
}

function emit(bot: Bot, ev: string, data: unknown): Promise<{ ok: boolean; code?: string; data?: unknown }> {
  return new Promise((resolve) => {
    if (!bot.socket.connected) return resolve({ ok: false, code: 'OFFLINE' });
    const sock = bot.socket;
    const timer = setTimeout(() => {
      if (sock.connected) problem(`${bot.nick}: ${ev} bez odpovědi do 5 s (připojený)`);
      resolve({ ok: false, code: 'TIMEOUT' });
    }, 5000);
    const done = (r: { ok: boolean; code?: string }) => {
      clearTimeout(timer);
      bot.pending.delete(done);
      resolve(r);
    };
    bot.pending.add(done);
    sock.emit(ev, data, (r: { ok: boolean; code?: string }) => {
      clearTimeout(timer);
      bot.pending.delete(done);
      if (!r.ok && r.code === 'UNKNOWN') {
        unknownReplies++;
        problem(`${bot.nick}: ${ev} vrátilo UNKNOWN (neočekávaná chyba serveru) ${JSON.stringify(data).slice(0, 120)}`);
      }
      resolve(r);
    });
  });
}

/** Vypíše vnitřní stav enginu u stolu (jen pro ladění nalezených chyb). */
function dumpEngine(tableId: string) {
  const actor = server.tables.get(tableId) as unknown as { adapter?: { raw?: Record<string, unknown> } } | undefined;
  const raw = actor?.adapter?.raw as { currentBets?: unknown; street?: string; minRaise?: number; lastRaiseAmount?: number; actionTo?: number; bigBlind?: number; smallBlind?: number; actionHistory?: { street: string; seat: number; action: { type: string; amount?: number } }[]; players?: ({ id: string; stack: number; betThisStreet: number; status: string; isSittingOut?: boolean } | null)[] } | undefined;
  if (!raw) return console.log('    (engine nedostupný)');
  const bets = raw.currentBets instanceof Map ? [...raw.currentBets.entries()] : raw.currentBets;
  console.log('    ENGINE', JSON.stringify({ street: raw.street, sb: raw.smallBlind, bb: raw.bigBlind, minRaise: raw.minRaise, lastRaise: raw.lastRaiseAmount, actionTo: raw.actionTo, bets, hist: (raw.actionHistory ?? []).slice(-8).map((h) => `${h.street}:${h.seat}:${h.action.type}${h.action.amount ?? ''}`), players: (raw.players ?? []).map((q) => (q ? `${q.id}:${q.status}:${q.stack}:${q.betThisStreet}${q.isSittingOut ? ':out' : ''}` : null)) }));
}

/** Bot na tahu zahraje náhodnou legální akci; občas pošle záměrně špatnou. */
function play(bot: Bot, tableId: string, v: TableView) {
  if (v.showdownChoice) {
    const key = `${tableId}:${v.handId}:choice`;
    if (!bot.acted.has(key)) {
      bot.acted.add(key);
      const delay = rnd() < 0.3 ? 7000 : 20 + Math.floor(rnd() * 400); // občas bez odpovědi (vyprší čas)
      setTimeout(() => {
        const cur = bot.views.get(tableId);
        if (!cur || cur.handId !== v.handId || !cur.showdownChoice) return;
        void emit(bot, 'table:showdown', { tableId, choice: rnd() < 0.5 ? 'show' : 'muck' }).then((r) => {
          if (!r.ok && !['NOT_ALLOWED', 'OFFLINE', 'TIMEOUT'].includes(r.code ?? '')) problem(`${bot.nick}: showdown → ${r.code}`);
        });
      }, delay);
    }
  }
  if (!v.legal || v.viewerSeat === null || v.viewerSeat !== v.actingSeat) return;
  const handId = v.handId;
  // jedna akce na jeden stav stolu (stejný stav může přijít víckrát)
  const key = `${tableId}:${v.handId}:${v.street}:${v.actingSeat}:${v.totalPot}`;
  if (bot.acted.has(key)) return;
  bot.acted.add(key);
  const delay = 5 + Math.floor(rnd() * 60);
  setTimeout(() => {
    const cur = bot.views.get(tableId);
    if (!cur || cur.handId !== handId || cur.actingSeat !== cur.viewerSeat || !cur.legal) return;
    if (rnd() < 0.02) {
      void emit(bot, 'table:act', { tableId, action: { type: 'raise', amount: -5 } }).then((r) => {
        if (r.ok) problem(`${bot.nick}: raise se zápornou částkou byl přijat`);
      });
      return;
    }
    const action = randomLegalAction(cur.legal, rnd);
    void emit(bot, 'table:act', { tableId, action }).then((r) => {
      if (!r.ok && !['NOT_YOUR_TURN', 'ILLEGAL_ACTION', 'NOT_SEATED', 'OFFLINE', 'HAND_NOT_ACTIVE', 'INVALID_ACTION', 'NO_HAND'].includes(r.code ?? '')) problem(`${bot.nick}: act ${JSON.stringify(action)} → ${r.code} | legal=${JSON.stringify(cur.legal)} stack=${cur.seats.find((x) => x.seat === cur.viewerSeat)?.stack} bet=${cur.seats.find((x) => x.seat === cur.viewerSeat)?.bet} street=${cur.street} pot=${cur.totalPot} acting=${cur.actingSeat} straddle=${cur.straddleSeat} bomb=${cur.bombPot} seats=${cur.seats.map((x) => `${x.seat}:${x.status}/${x.bet}/${x.stack}`).join(' ')} hand=${cur.handNumber}`);
    });
  }, delay);
}

// ---------- invarianty ----------
const allAccounts = () => {
  const set = new Set<string>([accounts.mint(), accounts.house()]);
  for (const tx of server.ledger.transactions()) for (const e of tx.entries) set.add(e.account);
  return [...set];
};
function checkInvariants(label: string) {
  if (!server.ledger.totalIsZero(allAccounts())) problem(`${label}: součet účetní knihy není nula`);
  for (const [id, actor] of server.tables.actors) {
    if (actor.hasError()) problem(`${label}: stůl ${id} v chybovém stavu: ${String(actor.hasError())}`);
    const inLedger = server.ledger.balance(accounts.table(id));
    if (!server.tables.row(id) && !server.tournaments.get(id)) continue;
    if (server.tables.row(id) && inLedger !== actor.totalChips()) problem(`${label}: stůl ${id}: v knize ${inLedger}, u stolu ${actor.totalChips()}`);
  }
  for (const b of bots) if (server.ledger.balance(accounts.wallet(b.id)) < 0) problem(`${label}: záporný zůstatek ${b.nick}`);
}

// ---------- cash ----------
async function cashPhase(ms: number) {
  console.log('— CASH GAME —');
  const { id } = await server.tables.createTable(admin!, { name: 'Simulace', templateId: 'cash-klasika', settings: { ...FAST_API, 'table.seats': 6, 'time.timeoutsToSitOut': 2 } });
  const actor = server.tables.get(id)!;
  // ladění: záznam plánování dalších hand
  const trace: string[] = [];
  let handStarts = 0;
  let readySince = 0;
  let startsAtReady = 0;
  const raw = actor as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['scheduleNextHand', 'boundary', 'hold', 'release', 'startHand']) {
    const orig = raw[name]!.bind(actor);
    raw[name] = (...a: unknown[]) => {
      const ph = (actor as unknown as { phase: string; pendingStart: unknown; held: boolean });
      if (name === 'startHand') handStarts++;
      trace.push(`${Date.now() % 100000}:${name}(${a.join(',')}) phase=${ph.phase} pend=${!!ph.pendingStart} held=${ph.held}`);
      if (trace.length > 40) trace.shift();
      return orig(...a);
    };
  }
  (globalThis as { __trace?: string[] }).__trace = trace;
  for (const b of bots) b.tables.add(id);
  for (const b of bots) {
    await emit(b, 'table:subscribe', { tableId: id });
    const r = await emit(b, 'table:join', { tableId: id, seat: b.n % 6, amount: 400 + Math.floor(rnd() * 600) });
    if (!r.ok && r.code !== 'SEAT_TAKEN' && r.code !== 'ALREADY_SEATED') problem(`${b.nick}: join → ${r.code}`);
  }
  let lastHand = 0;
  let lastProgress = Date.now();
  const end = Date.now() + ms;
  let tick = 0;
  while (Date.now() < end) {
    await sleep(700);
    tick++;
    // bot neplecha
    const b = pick(bots);
    const roll = rnd();
    const view = b.views.get(id);
    const seated = view?.seats.some((s) => s.playerId === b.id);
    if (roll < 0.14) await emit(b, 'table:sitOut', { tableId: id });
    else if (roll < 0.3) await emit(b, 'table:sitIn', { tableId: id });
    else if (roll < 0.4) await emit(b, 'table:topUp', { tableId: id, amount: 100 + Math.floor(rnd() * 400) });
    else if (roll < 0.5) {
      const r = await emit(b, 'table:leave', { tableId: id });
      if (!r.ok && r.code !== 'NOT_SEATED') problem(`${b.nick}: leave → ${r.code}`);
      await sleep(30);
      await emit(b, 'table:join', { tableId: id, seat: b.n % 6, amount: 300 + Math.floor(rnd() * 500) });
    } else if (roll < 0.58) {
      b.socket.close();
      await sleep(40);
      await connect(b);
    } else if (roll < 0.63) await emit(b, 'table:callClock', { tableId: id });
    else if (roll < 0.68) await emit(b, 'table:straddle', { tableId: id, want: rnd() < 0.5 });
    else if (roll < 0.72 && !seated) await emit(b, 'table:join', { tableId: id, seat: b.n % 6, amount: 500 });
    // admin: pauza a změny nastavení za hry
    if (tick % 9 === 0) await server.tables.pause(admin!, id, false).catch((e) => problem('pauza: ' + e));
    if (tick % 9 === 3) await server.tables.pause(admin!, id, true).catch((e) => problem('pokračování: ' + e));
    if (tick % 11 === 0) {
      const bb = pick([10, 20, 40]);
      await server.tables.updateSettings(admin!, id, { 'table.smallBlind': bb / 2, 'table.bigBlind': bb }).catch((e) => problem('změna blindů: ' + (e as Error).message));
    }
    // zaseknutí: když jsou aspoň 2 hráči ve hře a stůl není pozastavený a je v klidu (idle), musí do pár sekund začít handa
    const st = actor as unknown as { phase?: string; held?: boolean; pendingStart?: unknown };
    const playing = actor.playersSeated().filter((x) => x.mode === 'in' && x.chips + x.pendingChips > 0).length;
    const ready = playing >= 2 && !actor.isHeld() && st.phase === 'idle';
    if (!ready) readySince = 0;
    else if (readySince === 0) {
      readySince = Date.now();
      startsAtReady = handStarts;
    } else if (handStarts === startsAtReady && Date.now() - readySince > 6000) {
      problem(`cash: stůl je připravený (${playing} hráčů ve hře, nepozastavený), ale 6 s nezačala handa`);
      console.log('    STAV', JSON.stringify({ phase: st.phase, held: st.held, pendingStart: !!st.pendingStart, seats: actor.playersSeated().map((x) => `${x.seat}:${x.mode}:${x.chips}+${x.pendingChips}:fresh=${x.fresh}`) }));
      console.log('    TRACE', trace.slice(-10).join(' | '));
      readySince = Date.now();
    }
    if (tick % 3 === 0) checkInvariants(`cash t${tick}`);
  }
  await server.tables.pause(admin!, id, true).catch(() => undefined);
  console.log(`  odehráno hand: ${handStarts}`);
  // všichni odejdou, stůl se zavře: žetony se vrátí
  for (const b of bots) await emit(b, 'table:leave', { tableId: id });
  await sleep(1500);
  checkInvariants('cash konec');
  await server.tables.closeTable(admin!, id).catch((e) => problem('zavření stolu: ' + e));
  await sleep(300);
  if (server.ledger.balance(accounts.table(id)) !== 0) problem(`cash: po zavření zůstalo na stole ${server.ledger.balance(accounts.table(id))}`);
  checkInvariants('cash po zavření');
}

// ---------- turnaj ----------
async function tournamentPhase(name: string, over: Record<string, string | number | boolean>, ms: number, chaos = false) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  console.log(`— TURNAJ: ${name} —`);
  const { id } = await server.tournaments.create(admin!, {
    name: `Sim ${name}`,
    templateId: 'tour-turbo',
    settings: { ...FAST_API, 'tournament.minPlayers': 2, 'tournament.startingStack': 300, 'tournament.structure': '10/20, 20/40, 40/80, 80/160, 160/320, 320/640', 'tournament.levelMinutes': 1, 'table.seats': 4, 'tournament.maxTables': 2, 'tournament.autoStartWhenFull': false, 'tournament.buyIn': 100, 'tournament.fee': 10, ...over },
  });
  for (const b of bots) {
    b.views.clear();
    await server.tournaments.register(b.id, id).catch((e) => problem(`${b.nick}: registrace → ${(e as Error).message}`));
  }
  const walletsBefore = bots.map((b) => server.ledger.balance(accounts.wallet(b.id)));
  if (chaos) {
    // pevná směs předvoleb: 0–1 vždy, 2–3 nikdy, 4–5 zeptat se (ať se každá větev určitě vyzkouší)
    for (const b of bots) for (const key of ['ui.autoRebuy', 'ui.autoReenter', 'ui.autoAddon']) await server.settings.set(b.id, 'user', b.id, key, b.n < 2 ? 'always' : b.n < 4 ? 'never' : 'ask');
  }
  // Přestávka ani nabídka add-onu nesmí začít, dokud na některém stole běží handa (showdown, dokládání boardu, run it twice, volba ukázat karty).
  const boundaryStarts = { startBreak: 0, openAddonOffer: 0 };
  {
    const t = server.tournaments.get(id)! as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ['startBreak', 'openAddonOffer'] as const) {
      const orig = t[fn]!.bind(t);
      t[fn] = (...a: unknown[]) => {
        boundaryStarts[fn]++;
        for (const tid of server.tournaments.tableIdsOf(id)) {
          const actor = server.tables.actors.get(tid);
          const phase = actor?.currentPhase();
          const v = actor?.viewFor(null);
          if (phase === 'hand' || phase === 'runout' || v?.vote || v?.choice) problem(`turnaj ${name}: ${fn} za běhu handy (stůl ${tid}, fáze ${phase}${v?.vote ? ', hlasování' : ''}${v?.choice ? ', volba karet' : ''})`);
        }
        return orig(...a);
      };
    }
  }
  const decidingSince = new Map<string, number>();
  const maxDecideMs = (Number(over['tournament.rebuyDecisionSeconds'] ?? 30) + (over['tournament.rebuyWaitsForOffline'] ? Number(over['tournament.rebuyOfflineMaxSeconds'] ?? 0) : 0) + (over['tournament.breakEveryLevels'] ? Number(over['tournament.breakMinutes'] ?? 0) * 60 : 0) + 20) * 1000;
  await server.tournaments.start(admin!, id);
  const end = Date.now() + ms;
  let tick = 0;
  let lastKey = '';
  let lastChange = Date.now();
  while (Date.now() < end) {
    await sleep(500);
    tick++;
    const tour = server.tournaments.get(id)!;
    const st = tour.state();
    // boti sledují všechny stoly turnaje, řeší rebuy a dohody
    for (const tid of server.tournaments.tableIdsOf(id)) {
      for (const b of bots) {
        if (!b.tables.has(tid)) {
          b.tables.add(tid);
          void emit(b, 'table:subscribe', { tableId: tid });
        }
      }
    }
    for (const b of bots) {
      const view = await server.tournaments.view(id, b.id).catch(() => null);
      if (!view) continue;
      // kolize časů: hráč se při rozhodování o rebuy někdy odpojí a po chvíli vrátí
      if (chaos && view.me.status === 'deciding' && b.socket.connected && rnd() < 0.08) {
        b.socket.close();
        setTimeout(() => void connect(b), 1500 + Math.floor(rnd() * 4000));
      }
      // zaseknuté rozhodování: nikdo nesmí být ve stavu „rozhoduje se“ déle než čas na rozhodnutí + čekání na odpojeného + rezerva
      if (view.me.status === 'deciding') {
        const since = decidingSince.get(b.id) ?? Date.now();
        decidingSince.set(b.id, since);
        if (Date.now() - since > maxDecideMs) {
          problem(`turnaj ${name}: ${b.nick} se rozhoduje o rebuy už ${Math.round((Date.now() - since) / 1000)} s (limit ${Math.round(maxDecideMs / 1000)} s)`);
          decidingSince.set(b.id, Date.now());
        }
      } else decidingSince.delete(b.id);
      if (view.me.status === 'deciding') {
        if (!(chaos && b.n < 4) && rnd() < 0.7 && view.me.canRebuy) await server.tournaments.rebuy(b.id, id).catch((e) => problem(`${b.nick}: rebuy → ${(e as Error).message}`));
      }
      if (!(chaos && b.n < 4) && view.me.canAddon && rnd() < 0.5) await server.tournaments.addon(b.id, id).catch((e) => problem(`${b.nick}: addon → ${(e as Error).message}`));
    }
    if (tick % 7 === 0 && st.status === 'running') {
      await server.tournaments.pause(admin!, id, false).catch(() => undefined);
      await sleep(400);
      await server.tournaments.pause(admin!, id, true).catch(() => undefined);
    }
    const key = `${st.status}:${st.eliminations.length}:${tour.levelNumber()}:${server.tournaments.tableIdsOf(id).join(',')}`;
    if (key !== lastKey) {
      lastKey = key;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > (chaos ? 200_000 : 45_000) && st.status === 'running') {
      {
        const tables = server.tournaments.tableIdsOf(id).map((tid) => {
          const a = server.tables.actors.get(tid);
          const v = a?.viewFor(null);
          return `${tid}:${a?.currentPhase()}${v?.paused ? ':held' : ''}${v?.vote ? ':vote' : ''}${v?.choice ? ':choice' : ''}${v?.nextHandAt ? ':next' : ''}`;
        });
        const live = (tour as unknown as { liveHands: Set<string> }).liveHands;
        problem(`turnaj ${name}: beze změny (vyřazeno ${st.eliminations.length}, level ${tour.levelNumber()}, onBreak ${st.onBreak}, breakPending ${!!st.breakPending}, addonPending ${!!st.addonOfferPending}, paused ${!!st.paused}, rozehrané handy ${live.size}, stoly ${tables.join(',')}, hráči ${st.players.map((p) => p.status).join('/')})`);
      }
      lastChange = Date.now();
    }
    if (tick % 4 === 0) checkInvariants(`turnaj ${name} t${tick}`);
    if (st.status === 'finished' || st.status === 'cancelled') break;
  }
  const st = server.tournaments.get(id)!.state();
  console.log(`  stav: ${st.status}, vyřazeno ${st.eliminations.length}, level ${server.tournaments.get(id)!.levelNumber()}`);
  if (st.status !== 'finished') problem(`turnaj ${name} se v limitu nedohrál (stav ${st.status})`);
  await sleep(500);
  checkInvariants(`turnaj ${name} konec`);
  // automatika: po konci nesmí zůstat žádný rozdělaný časovač a odpovědět smí jen ten, kdo má předvolbu jinou než „zeptat se“
  await sleep(6000);
  const leftTimers = (server.tournaments as unknown as { autoTimers: Map<string, unknown> }).autoTimers.size;
  if (leftTimers > 0) problem(`turnaj ${name}: po konci zůstalo ${leftTimers} časovačů automatických odpovědí`);
  const autoRows = await server.audit.list({ action: 'turnaj.auto_odpoved' });
  let autoMine = 0;
  for (const row of autoRows) {
    if (row.targetId !== id) continue;
    autoMine++;
    const layer = server.settings.layer('user', row.actorId as string);
    const act = (row.after as { action?: string } | null)?.action;
    const key = act === 'addon' || act === 'declineAddon' ? 'ui.autoAddon' : act === 'reenter' ? 'ui.autoReenter' : 'ui.autoRebuy';
    if (String(layer[key] ?? 'ask') === 'ask' && !(act === 'decline')) problem(`turnaj ${name}: automatická odpověď „${act}“ hráči s předvolbou „zeptat se“`);
  }
  console.log(`  přestávek ${boundaryStarts.startBreak}, nabídek add-onu ${boundaryStarts.openAddonOffer}`);
  console.log(`  automatických odpovědí: ${autoMine}; rebuy celkem ${server.tournaments.get(id)!.state().players.reduce((n, p) => n + p.rebuys, 0)}, add-onů ${server.tournaments.get(id)!.state().players.filter((p) => p.addon).length}`);
  if (st.status === 'finished') {
    const walletsAfter = bots.map((b) => server.ledger.balance(accounts.wallet(b.id)));
    const delta = walletsAfter.reduce((a, x, i) => a + x - walletsBefore[i]!, 0);
    const house = server.ledger.balance(accounts.house());
    console.log(`  součet změn peněženek: ${delta}, dům: ${house}`);
    if (st.results && st.results.length < bots.length - 0) problem(`turnaj ${name}: výsledků ${st.results.length} z ${bots.length}`);
    // tržby = vklady − výplaty: peníze nikde nezmizely
    const left = server.ledger.balance(accounts.tournament(id));
    if (left !== 0) problem(`turnaj ${name}: na účtu turnaje zbylo ${left}`);
  }
}

try {
  for (let i = 0; i < 6; i++) bots.push(await makeBot(i));
  const per = Math.max(20, Math.floor((seconds * 1000) / (mode === 'all' ? 4 : 1)));
  if (mode === 'cash' || mode === 'all') await cashPhase(per);
  if (mode === 'tournament' || mode === 'all') {
    await tournamentPhase('freezeout', {}, per);
    await tournamentPhase('rebuy+addon', { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 2, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 300, 'tournament.rebuyMax': 2, 'tournament.addonEnabled': true, 'tournament.addonFromLevel': 2, 'tournament.addonUntilLevel': 2, 'tournament.addonCost': 100, 'tournament.addonChips': 300 }, per);
    await tournamentPhase('bounty', { 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 30 }, per);
    await tournamentPhase('auto odpovědi: kolize časů', { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 4, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 300, 'tournament.rebuyMax': 3, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyTimerStops': true, 'tournament.rebuyWaitsForOffline': true, 'tournament.rebuyOfflineMaxSeconds': 30, 'tournament.rebuyDecisionSeconds': 6, 'tournament.addonEnabled': true, 'tournament.addonMode': 'both', 'tournament.addonFromLevel': 1, 'tournament.addonUntilLevel': 1, 'tournament.addonOfferSeconds': 6, 'tournament.addonCost': 100, 'tournament.addonChips': 300, 'tournament.breakEveryLevels': 1, 'tournament.breakMinutes': 1, 'special.runItTwice': true, 'special.runItVoteSeconds': 5, 'special.rabbitHunt': true, 'special.rabbitHuntSeconds': 3, 'tournament.reentryEnabled': true, 'tournament.reentryMax': 1 }, per, true);
    await tournamentPhase('rebuy: čekání hry + odpojení + nabídka add-onu', { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 3, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 300, 'tournament.rebuyMax': 3, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyTimerStops': true, 'tournament.rebuyWaitsForOffline': true, 'tournament.rebuyOfflineMaxSeconds': 30, 'tournament.rebuyDecisionSeconds': 10, 'tournament.addonEnabled': true, 'tournament.addonMode': 'both', 'tournament.addonFromLevel': 2, 'tournament.addonUntilLevel': 2, 'tournament.addonOfferSeconds': 10, 'tournament.addonCost': 100, 'tournament.addonChips': 300 }, per);
  }
} catch (e) {
  const issues = JSON.stringify((e as { issues?: unknown; params?: unknown }).issues ?? (e as { params?: unknown }).params ?? '');
  problem('VÝJIMKA simulace: ' + (e instanceof Error ? `${e.message} ${issues}\n${e.stack}` : String(e)));
}
for (const b of bots) b.socket.close();
await server.close().catch(() => undefined);
console.log('');
console.log(problems.length === 0 ? '✓ Bez nalezených problémů.' : `✗ Nalezeno problémů: ${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
