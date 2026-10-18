import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { CashService, Ledger, accounts as ledgerAccounts } from '@kb/ledger';
import { realClock, type Clock } from '@kb/game-core';
import { coerceSettingValue, createDefaultRegistry, formatLocal, t as tr, type SettingValues } from '@kb/shared';
import { AccountService, type AccountNotifier } from './auth/accounts.js';
import { AuditService } from './auth/audit.js';
import { PermissionService } from './auth/permissions.js';
import { seedRoles } from './auth/seed.js';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { t } from '@kb/shared';
import { ChatService } from './chat/service.js';
import { setupChatEvents } from './chat/gateway.js';
import { schema } from './db/index.js';
import { ApprovalService } from './auth/approvals.js';
import { WalletService } from './wallet/service.js';
import { EmailService } from './email/service.js';
import { loadMasterKey, SecretStore, type MasterKey } from './secrets/store.js';
import { openPglite, openPostgres, type Database } from './db/index.js';
import { Journal, ledgerTxOp, openLedgerStore } from './db/journal.js';
import { setupGateway } from './gateway.js';
import { parseCookies, SESSION_COOKIE } from './http/cookies.js';
import { registerRoutes } from './http/routes.js';
import { SettingsStore } from './settings-store.js';
import { TableManager } from './tables.js';
import { TemplateService } from './templates.js';
import { MaintenanceService } from './maintenance.js';
import { HistoryService } from './history.js';
import { BlindStructureService } from './structures.js';
import { TimelineService } from './timeline.js';
import { OverviewService } from './overview.js';
import { TournamentManager, resultSummary, tournamentChatText, type TournamentNotice } from './tournaments.js';
import { NotificationService } from './notifications.js';
import { StatsService } from './stats.js';
import { ProgressService } from './progress.js';
import { RatingService } from './rating.js';
import { PollService } from './polls.js';
import { ThemeService } from './themes.js';
import { ThemeAssets } from './theme-assets.js';
import { LiveCashService } from './live-cash.js';
import { TvService } from './tv.js';
import { AnnouncerService } from './announcer.js';
import { EveningService } from './evenings.js';
import { BetService, HeadBountyService } from './bets.js';
import { LimitsService } from './limits.js';
import { NotesService } from './notes.js';
import { SharedHandService } from './shared-hands.js';
import { CosmeticService } from './cosmetics.js';
import { IntegrationService, type TournamentSummary } from './integrations/service.js';
import { ApiTokenService } from './api-tokens.js';
import { AssistantService } from './assistant/service.js';
import { McpService } from './assistant/mcp.js';
import { buildManifest } from './pwa.js';
type SettingsLike = Record<string, unknown>;
import type { TableEvent as AnnounceTableEvent, TournamentEvent as AnnounceTournamentEvent } from '@kb/game-core';
import { ProfileBuilder } from './poll-profiles.js';
import { AchievementService } from './achievements.js';
import { SoundService } from './sounds.js';
import { ChatImages } from './chat/images.js';
import { ChatDigest, ChatNotifier } from './chat/notify.js';
import { FfmpegProcessor, type AudioProcessor } from './audio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PushService, type PushSender } from './push.js';
import { Scheduler } from './scheduler.js';
import { SeriesService } from './series.js';

export interface ServerOptions {
  port?: number;
  clock?: Clock;
  logger?: boolean;
  /** Hotová databáze (testy); jinak `databaseUrl` (PostgreSQL), nebo PGlite v `dataDir` / v paměti. */
  database?: Database;
  databaseUrl?: string;
  dataDir?: string;
  /** Přepsání globálního nastavení (testy, vývoj). */
  settingsOverride?: Partial<SettingValues>;
  /** První hlavní administrátor; bez hesla se vygeneruje a vrátí ve výsledku. */
  bootstrapAdmin?: { nickname: string; password?: string };
  /** Vlastní notifikátor (testy); jinak se e-maily řadí do fronty a odesílají přes SMTP. */
  notifier?: AccountNotifier;
  /** Hlavní šifrovací klíč (testy); jinak z MASTER_KEY / souboru. */
  masterKey?: MasterKey;
  /** Soubor s hlavním klíčem, pokud není v prostředí. */
  masterKeyFile?: string;
  /** Falešný SMTP transport (testy). */
  mailTransport?: ConstructorParameters<typeof EmailService>[0]['transport'];
  /** Spouštět zpracování fronty e-mailů na pozadí (výchozí ano). */
  emailWorker?: boolean;
  /** Výměnný odesílač web push (testy); výchozí je skutečná push služba prohlížeče. */
  pushSender?: PushSender;
  /** Složka s obrázky z chatu (výchozí CHAT_IMAGES_DIR, vedle dat, nebo dočasná). */
  chatImagesDir?: string;
  /** Složka s obrázky motivů (výchozí THEME_ASSETS_DIR, vedle dat, nebo dočasná). */
  themeAssetsDir?: string;
  /** Složka s namluvenými hláškami hlasatele (výchozí ANNOUNCER_DIR, vedle dat, nebo dočasná). */
  announcerDir?: string;
  /** Náhrada za fetch při volání Google TTS (testy). */
  announcerFetch?: typeof fetch;
  /** Složka se zvuky (výchozí SOUNDS_DIR, vedle dat, nebo dočasná). */
  soundsDir?: string;
  /** Převodník zvuku (testy); výchozí je ffmpeg. */
  audioProcessor?: AudioProcessor;
  /** Náhrada za fetch a spojení s MQTT (testy). */
  integrationFetch?: typeof fetch;
  mqttConnector?: import('./integrations/mqtt.js').MqttConnector;
  /** Náhrada poskytovatele AI a jeho spojení (testy). */
  assistantProvider?: import('./assistant/providers.js').AiProvider;
  assistantFetch?: typeof fetch;
  /** Povolené původy pro cookie a WebSocket (kromě `system.publicUrl`). */
  extraOrigins?: string[];
  /** Veřejná adresa z prostředí (PUBLIC_URL): platí, dokud správce nenastaví jinou v GUI. */
  publicUrlDefault?: string;
  /** Vytvořit výchozí stůl, pokud žádný není (vývoj a první start). */
  defaultTable?: boolean;
  /** Zápis do DB selhal: výchozí je zastavit proces. */
  onFatal?: (e: unknown) => void;
  /** Plánovač turnajů: false = nespouštět automatické tikání (testy volají `scheduler.tick()` ručně). */
  scheduler?: boolean;
  /** Jak často plánovač kontroluje čas (ms). */
  schedulerTickMs?: number;
  /** Složka se sestaveným klientem (výchozí WEB_DIR); servíruje se na `/` s návratem na index.html. */
  webDir?: string;
  /** Přepsání nastavení výchozího stolu (vrstva stolu). */
  tableSettings?: Record<string, unknown>;
}

export async function buildServer(opts: ServerOptions = {}) {
  const registry = createDefaultRegistry();
  const clock = opts.clock ?? realClock;
  const database = opts.database ?? (opts.databaseUrl ? await openPostgres(opts.databaseUrl) : await openPglite(opts.dataDir));
  const { db } = database;

  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit);
  await seedRoles(db, perms);
  const settings = new SettingsStore(db, registry, audit, perms);
  await settings.load();
  if (opts.settingsOverride) settings.preset('global', '', opts.settingsOverride);
  if (opts.publicUrlDefault && settings.layer('global')['system.publicUrl'] === undefined && !opts.settingsOverride?.['system.publicUrl']) settings.preset('global', '', { 'system.publicUrl': opts.publicUrlDefault });

  const journal = new Journal(db, opts.onFatal);
  const ledger = new Ledger(await openLedgerStore(db), { negativeBalanceLimit: 0 }, () => clock.now(), (tx) => journal.push('ledger', ledgerTxOp(tx)));
  const startSettings = settings.resolve();
  const cash = new CashService(ledger, Number(startSettings['cash.chipsPerCurrencyUnit']));
  ledger.setPolicy({ negativeBalanceLimit: Number(startSettings['economy.negativeBalanceLimit']) });

  const publicOrigin = () => {
    try {
      return new URL(String(settings.resolve()['system.publicUrl'])).origin;
    } catch {
      return '';
    }
  };
  // Ve vývoji (mimo NODE_ENV=production) jsou povolené i adresy Vite serveru.
  const devOrigins = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const allowedOrigins = () => [publicOrigin(), ...devOrigins, ...(opts.extraOrigins ?? [])].filter(Boolean);

  const keyFile = opts.masterKeyFile ?? process.env.MASTER_KEY_FILE ?? (opts.dataDir ? join(opts.dataDir, '..', 'master.key') : undefined);
  const master =
    opts.masterKey ??
    loadMasterKey({
      envKey: process.env.MASTER_KEY,
      envVersion: process.env.MASTER_KEY_VERSION ? Number(process.env.MASTER_KEY_VERSION) : undefined,
      keyFile,
      log: (m) => console.log(m),
    });
  const secrets = new SecretStore(db, audit, perms, master, keyFile);
  const email = new EmailService({ db, audit, perms, secrets, settings: () => settings.resolve(), transport: opts.mailTransport });
  if (opts.emailWorker !== false) email.start();

  const accounts = new AccountService({
    db,
    audit,
    perms,
    notifier: opts.notifier ?? email.notifier(),
    settings: () => settings.resolve(),
    onActivated: (userId) => {
      // Počáteční vklad přes účetní knihu (jednou na účet díky idempotenčnímu klíči).
      const amount = Number(settings.resolve()['economy.startingBalance']);
      if (amount > 0) cash.mint(userId, amount, `start:${userId}`, 'system', 'počáteční vklad');
    },
  });

  /** Nepovinný e-mail uživateli: respektuje jeho osobní předvolbu a to, zda má ověřený e-mail. */
  const mailUser = async (userId: string, prefKey: string, template: string, vars: (nickname: string) => Record<string, string | number>) => {
    try {
      const [u] = await db.select({ nickname: schema.users.nickname, email: schema.users.email, verified: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId));
      if (!u?.email || (!u.verified && settings.resolve()['system.emailVerificationRequired'])) return;
      const prefs = settings.resolve([{ scope: 'user', scopeId: userId, values: settings.layer('user', userId) }]);
      if (prefs[prefKey] === false) return;
      await email.enqueue(template, u.email, vars(u.nickname));
    } catch (e) {
      console.error('Odeslání upozornění e-mailem selhalo:', e instanceof Error ? e.message : e);
    }
  };

  const approvals = new ApprovalService(db, perms, audit, {
    notify: (e) => {
      if (e.kind !== 'decided') return;
      void mailUser(e.requestedBy, 'email.notifyApprovalDecided', 'schvaleni_vyrizeno', (prezdivka) => ({ prezdivka, akce: e.action, vysledek: e.approved ? 'schváleno' : 'zamítnuto' }));
    },
  });
  const wallet = new WalletService({
    db,
    ledger,
    perms,
    audit,
    approvals,
    settings: () => settings.resolve(),
    notify: (e) => {
      if (e.kind !== 'request_decided') return;
      void (async () => {
        const [r] = await db.select({ kind: schema.userRequests.kind, note: schema.userRequests.decisionNote }).from(schema.userRequests).where(eq(schema.userRequests.id, e.requestId));
        await mailUser(e.userId, 'email.notifyRequestDecided', 'zadost_vyrizena', (prezdivka) => ({ prezdivka, druh: r?.kind ?? '', vysledek: e.approved ? 'schváleno' : 'zamítnuto', poznamka: r?.note ? `Poznámka správce: ${r.note}\n` : '' }));
      })();
    },
  });
  let sounds!: SoundService;
  let chatImages!: ChatImages;
  const hooks = { pushWallet: (_userId: string) => undefined as void };

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  const tablesRef: { current?: TableManager } = {};
  const maintenanceRef: { current?: MaintenanceService } = {};
  const historyRef: { current?: HistoryService } = {};
  const structuresRef: { current?: BlindStructureService } = {};
  const tournamentsRef: { current?: TournamentManager } = {};
  const schedulerRef: { current?: Scheduler } = {};
  const notificationsRef: { current?: NotificationService } = {};
  const seriesRef: { current?: SeriesService } = {};
  await registerRoutes(app, { db, audit, perms, accounts, settings, ledger, cash, secrets, email, approvals, wallet, hooks, tables: () => tablesRef.current!, tournaments: () => tournamentsRef.current!, templates: () => templates, maintenance: () => maintenanceRef.current!, history: () => historyRef.current!, structures: () => structuresRef.current!, timeline: () => timeline, overview: () => overview, scheduler: () => schedulerRef.current!, notifications: () => notificationsRef.current!, push: () => push, stats: () => stats, progress: () => progress, achievements: () => achievements, rating: () => rating, polls: () => pollsRef, themes: () => themeService, themeAssets: () => themeAssetsRef, liveCash: () => liveCashRef, tv: () => tvRef, announcer: () => announcerRef, evenings: () => eveningRef, bets: () => betsRef, headBounties: () => bountiesRef, limits: () => limitsRef, notes: () => notesRef, sharedHands: () => sharedHandsRef, cosmetics: () => cosmeticsRef, integrations: () => integrationsRef, apiTokens: () => apiTokensRef, assistant: () => assistantRef, mcp: () => mcpRef, chatPost: async (userId, text) => void (await chat.send(userId, await chat.ensureMainChannel(), text)), publicUrl: () => publicUrlNow(), sounds: () => sounds, chatImages: () => chatImages, series: () => seriesRef.current!, calendarSecret: () => master.key }, { secureCookie: publicOrigin().startsWith('https://'), allowedOrigins });

  let broadcast: (tableId: string) => void = () => undefined;
  // Chat: hlavní kanál, kanály stolů a systémové zprávy u stolů.
  const tableAccess = (userId: string, tableId: string) => {
    // Chat turnaje (i na víc stolech, i živého bez stolu): přístup má ten, kdo v turnaji ještě hraje.
    const tm = tournamentsRef.current;
    const tour = tm?.get(tableId);
    const t = tablesRef.current?.get(tableId);
    if (!tour && !t) return { read: false, write: false };
    const seated = tour ? tm!.isPlaying(tableId, userId) : t!.playersSeated().some((p) => p.userId === userId);
    const spectator = !!settings.resolve()['chat.spectatorChat'] && perms.can(userId, 'stul.chat').allowed;
    return { read: seated || perms.can(userId, 'stul.zobrazit').allowed, write: seated || spectator };
  };
  const chat = new ChatService({ db, perms, audit, settings: () => settings.resolve(), tableAccess });
  await chat.ensureMainChannel();
  chatImages = new ChatImages({ db, chat, settings: () => settings.resolve(), dir: opts.chatImagesDir ?? process.env.CHAT_IMAGES_DIR ?? (opts.dataDir ? join(opts.dataDir, '..', 'chat-images') : mkdtempSync(join(tmpdir(), 'kb-chat-img-'))), now: () => clock.now() });
  await chatImages.init();
  // Automatické zprávy o turnajích do hlavního kanálu (zapínatelné v nastavení chatu).
  const announce = (text: string) =>
    void (async () => {
      if (!settings.resolve()['chat.autoTournamentMessages']) return;
      await chat.system(await chat.ensureMainChannel(), text);
    })().catch(() => undefined);
  const cardOf = (id: string) => `{{turnaj:${id}}}`;
  const nickOf = async (userId: string) => (await db.select({ n: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, userId)))[0]?.n ?? '';
  let progress!: ProgressService;
  let achievements!: AchievementService;
  let pollsRef!: PollService;
  let themeService!: ThemeService;
  let themeAssetsRef!: ThemeAssets;
  let liveCashRef!: LiveCashService;
  let tvRef!: TvService;
  let announcerRef!: AnnouncerService;
  let eveningRef!: EveningService;
  let betsRef!: BetService;
  let limitsRef!: LimitsService;
  let notesRef!: NotesService;
  let sharedHandsRef!: SharedHandService;
  let cosmeticsRef!: CosmeticService;
  let integrationsRef!: IntegrationService;
  let apiTokensRef!: ApiTokenService;
  let assistantRef!: AssistantService;
  let mcpRef!: McpService;
  const out = (event: Parameters<IntegrationService['emit']>[0], data?: Parameters<IntegrationService['emit']>[1]) => integrationsRef?.emit(event, data);
  let bountiesRef!: HeadBountyService;
  /** Hlášky událostí turnaje (start, level, přestávka, vyřazení, bublina, konec). */
  const sayTournament = (id: string, e: AnnounceTournamentEvent) => {
    const rooms = [`announce:${id}`, `table:${id}`];
    const say = (event: string, vars: Record<string, string | number> = {}) => void announcerRef?.announce(event, vars, { rooms });
    const tname = tournaments.nameOf(id) ?? '';
    switch (e.type) {
      case 'started':
        out('tournament.started', { name: tname });
        return say('tournamentStart', { name: tname });
      case 'level':
        if (e.level > 1) out('tournament.level', { name: tname, level: e.level, sb: e.smallBlind, bb: e.bigBlind, ante: e.ante });
        return e.level > 1 ? say('levelUp', { level: e.level, sb: e.smallBlind, bb: e.bigBlind, ante: e.ante }) : undefined;
      case 'break':
        out('tournament.break', { name: tname, minutes: e.minutes });
        return say('break', { minutes: e.minutes });
      case 'breakEnd':
        out('tournament.breakEnd', { name: tname });
        return say('breakEnd');
      case 'paused':
        return say('paused');
      case 'resumed':
        return say('resumed');
      case 'eliminated':
        out('player.eliminated', { name: tname, nick: e.name, remaining: e.remaining });
        return say('eliminated', { nick: e.name, remaining: e.remaining });
      case 'knockout':
        return e.secret ? undefined : say('knockout', { killer: e.by.join(' a '), victim: e.victim, amount: e.amount });
      case 'bubble':
        return say('bubble');
      case 'finished':
        out('tournament.finished', { name: tname, winner: e.results[0]?.name ?? '', players: e.results.length });
        return say('winner', { winner: e.results[0]?.name ?? '', name: tournaments.nameOf(id) ?? '' });
      default:
        return undefined;
    }
  };
  /** Vítězná znělka výherce velkého potu. */
  const jingleBigPot = (tableId: string, e: AnnounceTableEvent, ts: SettingsLike | undefined) => {
    if (e.type !== 'handEnd' || !ts) return;
    const limit = Number(settings.resolve()['sounds.jingleBigPotBb']);
    const bb = Number(ts['table.bigBlind']);
    if (limit <= 0 || bb <= 0) return;
    const pot = e.record.players.reduce((n, p) => n + p.invested, 0);
    const best = [...e.record.players].sort((a, b) => b.won - a.won)[0];
    if (best && best.won > 0 && pot / bb >= limit) void sounds?.jingle(best.userId, 'win', { kind: 'table', id: tableId }).catch(() => undefined);
  };
  /** Velký pot a bad beat po handě (napojení ven). */
  const outHand = (e: AnnounceTableEvent, ts: SettingsLike | undefined) => {
    if (e.type !== 'handEnd' || !ts) return;
    const bb = Number(ts['table.bigBlind']);
    if (bb <= 0) return;
    const pot = e.record.players.reduce((n, p) => n + p.invested, 0);
    const best = [...e.record.players].sort((a, b) => b.won - a.won)[0];
    if (best && best.won > 0 && pot / bb >= Number(settings.resolve()['integrations.bigPotBb'])) void nickOf(best.userId).then((nick) => out('hand.bigPot', { nick, pot, bb: Math.round((pot / bb) * 10) / 10 }));
    const min = Number(settings.resolve()['evening.badBeatMinPercent']) / 100;
    for (const p of e.record.players) {
      const eq = e.record.allInEquity?.[p.userId];
      if (p.won === 0 && eq !== undefined && eq !== null && eq >= min) void nickOf(p.userId).then((nick) => out('hand.badBeat', { nick, equity: Math.round(eq * 1000) / 10 }));
    }
  };
  /** All-in u stolu: hráč, jehož sedadlo po akci dostalo stav all-in (platí i pro call a raise na celý stack). */
  /** Výsledek handy zůstane v chatu u stolu (cash i turnaj), i když zmizí z obrazovky: kdo vyhrál kolik, s jakou kombinací a jaký byl board. */
  const postHandResult = async (channelKey: string, e: Extract<AnnounceTableEvent, { type: 'handEnd' }>) => {
    const channelId = await chat.channelIdByKey(channelKey);
    if (!channelId) return;
    const winners = e.record.players.filter((p) => p.won > 0).sort((a, b) => b.won - a.won);
    if (winners.length === 0) return;
    const results = winners
      .map((p) => {
        const hand = e.showdown && p.revealed && p.handDesc ? ` (${t(p.handDesc.key, p.handDesc.params)})` : '';
        return t('chat.sys.handWinner', { nick: p.name, amount: p.won }) + hand;
      })
      .join(', ');
    const board = e.board.length > 0 ? ' ' + t('chat.sys.handBoard', { cards: e.board.join(' ') }) : '';
    const runs = e.record.runs > 1 ? ' ' + t('chat.sys.handRuns', { n: e.record.runs }) : '';
    await chat.system(channelId, t('chat.sys.handResult', { n: e.record.handNumber, results }) + board + runs);
  };
  const sayAllIn = (tableId: string, e: AnnounceTableEvent, tournamentId?: string) => {
    if (e.type !== 'action') return;
    const seat = tablesRef.current?.actors.get(tableId)?.viewFor(null).seats.find((s) => s.playerId === e.userId);
    if (seat?.status !== 'allIn') return;
    void nickOf(e.userId).then((nick) => out('player.allIn', { nick }));
    void nickOf(e.userId).then((nick) => announcerRef?.announce('allIn', { nick }, { rooms: [`announce:${tournamentId ?? tableId}`, `table:${tableId}`], table: true }));
  };
  const rating = new RatingService({ db, perms, settings: () => settings.resolve(), now: () => clock.now(), notify: (userId, kind, params, link) => notificationsRef.current?.simple(userId, kind, params, link) ?? Promise.resolve(), onError: (e) => console.error('Výpočet ratingu selhal:', e instanceof Error ? e.message : e) });
  const stats = new StatsService({ db, perms, settings: () => settings.resolve(), now: () => clock.now(), onHand: (h) => progress.onHand(h), onError: (e) => console.error('Záznam handy selhal:', e instanceof Error ? e.message : e) });
  const templates = new TemplateService({
    db,
    registry,
    perms,
    audit,
    inUse: (id) => (tablesRef.current?.usesTemplate(id) ?? false) || (tournamentsRef.current?.usesTemplate(id) ?? false),
    order: () => {
      try {
        const v = JSON.parse(String(settings.resolve()['templates.order'] || '[]')) as unknown;
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    },
    setOrder: (actorId, ids) => settings.set(actorId, 'global', '', 'templates.order', JSON.stringify(ids)),
  });
  await templates.load();
  const tables = new TableManager({
    db,
    journal,
    registry,
    settings,
    templates,
    cash,
    clock,
    perms,
    audit,
    onChange: (id) => broadcast(id),
    onSpawn: (row) => void chat.ensureTableChannel(row.id, row.name).catch(() => undefined),
    onSettingsChanged: (tableId, changes, pending) => {
      const show = (v: unknown) => (v === true ? t('common.yes') : v === false ? t('common.no') : String(v));
      const list = Object.entries(changes)
        .map(([k, v]) => `${t(`settings.${k}.label`)}: ${show(v)}`)
        .join(', ');
      void (async () => {
        const channelId = await chat.channelIdByKey('table:' + tableId);
        if (channelId) await chat.system(channelId, t(pending ? 'chat.sys.settingsPending' : 'chat.sys.settingsChanged', { list }));
      })().catch(() => undefined);
    },
    onEvent: (tableId, e) => {
      sayAllIn(tableId, e);
      jingleBigPot(tableId, e, tables.settingsOf(tableId));
      outHand(e, tables.settingsOf(tableId));
      if (e.type === 'seat' && e.change === 'join') void sounds?.jingle(e.userId, 'join', { kind: 'table', id: tableId }).catch(() => undefined);
      if (e.type === 'handStart') void eveningRef?.cashActivity(tableId).catch(() => undefined);
      const ts = tables.settingsOf(tableId);
      if (ts) stats.onTableEvent({ tableId, kind: 'cash', settings: ts, chipsPerUnit: Number(ts['cash.chipsPerCurrencyUnit']) || 1 }, e);
      if (e.type === 'bonus' || e.type === 'bombPot' || e.type === 'rabbit' || e.type === 'shown' || e.type === 'mucked') {
        void (async () => {
          const channelId = await chat.channelIdByKey('table:' + tableId);
          if (!channelId) return;
          if (e.type === 'bonus') await chat.system(channelId, t('chat.sys.sevenTwo', { nick: await nickOf(e.userId), amount: e.amount }));
          else if (e.type === 'bombPot') await chat.system(channelId, t('chat.sys.bombPot'));
          else if (e.type === 'shown') await chat.system(channelId, t(e.which === 'both' ? 'chat.sys.shown' : 'chat.sys.shownOne', { nick: await nickOf(e.userId) }));
          else if (e.type === 'mucked') await chat.system(channelId, t('chat.sys.mucked', { nick: await nickOf(e.userId) }));
          else await chat.system(channelId, t('chat.sys.rabbit', { cards: e.cards.join(' ') }));
        })().catch(() => undefined);
        return;
      }
      if (e.type === 'handEnd') {
        void postHandResult('table:' + tableId, e).catch(() => undefined);
        return;
      }
      if (e.type === 'jackpot') {
        void (async () => {
          const channelId = await chat.channelIdByKey('table:' + tableId);
          if (!channelId) return;
          for (const p of e.payouts) await chat.system(channelId, t(e.kind === 'royalFlush' ? 'chat.sys.jackpotRoyal' : e.kind === 'highHand' ? 'chat.sys.jackpotHighHand' : 'chat.sys.jackpotBadBeat', { nick: await nickOf(p.userId), amount: p.amount }));
        })().catch(() => undefined);
        return;
      }
      if (e.type !== 'seat') return;
      const key = e.change === 'join' ? 'chat.sys.join' : e.change === 'leave' ? 'chat.sys.leave' : e.change === 'topUp' ? 'chat.sys.topUp' : null;
      if (!key) return;
      void (async () => {
        const channelId = await chat.channelIdByKey('table:' + tableId);
        if (channelId) await chat.system(channelId, t(key, { nick: await nickOf(e.userId) }));
      })().catch(() => undefined);
    },
  });
  tablesRef.current = tables;
  await tables.load();

  // Turnaje: stůl každého turnaje je v téže mapě jako cash stoly, takže Socket.IO brána funguje beze změn.
  let emitTournamentChanged: (id: string) => void = () => undefined;
  let emitTournamentResult: (userId: string, payload: { id: string; name: string; summary: ReturnType<typeof resultSummary>[] }) => void = () => undefined;
  const publicUrlNow = () => String(settings.resolve()['system.publicUrl'] ?? '');
  const push = new PushService({ db, secrets, subject: () => (publicUrlNow().startsWith('https://') ? publicUrlNow() : 'mailto:admin@localhost.invalid'), sender: opts.pushSender });
  progress = new ProgressService({
    db,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    // výsledky turnaje se do statistik zapisují jinou frontou: úspěchy počkají, až budou uložené
    onActivity: (ids, trigger) => void stats.idle().then(() => achievements.trigger(ids, [trigger])),
    onLevelUp: (userId, level, rank, rankChanged) => {
      achievements.trigger([userId], ['level']);
      void cosmeticsRef?.sync(userId).catch(() => undefined);
      void notifications.simple(userId, 'levelUp', { level, rank: rank.name }, '/postup').catch(() => undefined);
      io.to(`user:${userId}`).emit('progress:level', { level, rank: { name: rank.name, icon: rank.icon, color: rank.color }, rankChanged });
      if (rankChanged) {
        void (async () => {
          if (!settings.resolve()['xp.announceLevelUp']) return;
          await chat.system(await chat.ensureMainChannel(), tr('chat.sys.levelUp', { nick: await nickOf(userId), level, rank: rank.name }));
        })().catch(() => undefined);
      }
    },
    onError: (e) => console.error('Zápis XP selhal:', e instanceof Error ? e.message : e),
  });
  achievements = new AchievementService({
    db,
    perms,
    progress,
    onEarned: (userId, a) => {
      void notifications.simple(userId, 'achievement', { name: a.name, xp: a.xp }, '/postup').catch(() => undefined);
      void cosmeticsRef?.sync(userId).catch(() => undefined);
      io.to(`user:${userId}`).emit('progress:achievement', { key: a.key, name: a.name, icon: a.icon, xp: a.xp });
    },
    onError: (e) => console.error('Vyhodnocení úspěchů selhalo:', e instanceof Error ? e.message : e),
  });
  await achievements.init();
  const notifications = new NotificationService({ db, email, settings, publicUrl: publicUrlNow, push });
  let isOnline: (userId: string) => boolean = () => false;
  const notifyTournament = (to: string[] | 'all', notice: TournamentNotice) => {
    void notifications.tournament(to, notice).catch(() => undefined);
    if (notice.kind === 'registrationOpened') out('tournament.registration', { name: notice.name });
    if (notice.kind === 'registrationOpened') announce(tr('chat.sys.tournamentRegistration', { name: notice.name, card: cardOf(notice.tournamentId) }));
    else if (notice.kind === 'started') announce(tr('chat.sys.tournamentStarted', { name: notice.name, card: cardOf(notice.tournamentId) }));
  };
  const tournaments = new TournamentManager({
    db,
    journal,
    registry,
    settings,
    templates,
    ledger,
    cash,
    clock,
    perms,
    audit,
    actors: tables.actors,
    onTableChange: (id) => broadcast(id),
    onChanged: (id) => emitTournamentChanged(id),
    onWallet: (userId) => hooks.pushWallet(userId),
    onSpawn: (row) => void chat.ensureTableChannel(row.id, row.name).catch(() => undefined),
    onScheduled: (id, name, startAt) => announce(tr('chat.sys.tournamentScheduled', { name, time: formatLocal(startAt), card: cardOf(id) })),
    onTableEvent: (id, tableId, e, ts) => {
      sayAllIn(tableId, e, id);
      jingleBigPot(tableId, e, ts);
      outHand(e, ts);
      if (e.type === 'handEnd') void postHandResult('table:' + id, e).catch(() => undefined);
      stats.onTableEvent({ tableId, kind: 'tournament', tournamentId: id, settings: ts, chipsPerUnit: 1 }, e);
    },
    seatWanted: (tournamentId, userId) => bountiesRef?.wantedSync(tournamentId, userId) ?? 0,
    onLiveMove: (id, m) => {
      void notifications.simple(m.userId, 'liveMove', { table: m.toNo, seat: m.seat }, `/turnaj/${id}`);
      void (async () => {
        const channelId = await chat.channelIdByKey('table:' + id);
        if (channelId) await chat.system(channelId, tr('chat.sys.tMoved', { nick: m.name, from: m.fromNo, to: m.toNo, seat: m.seat }));
      })().catch(() => undefined);
    },
    onSetEvent: (id, e) => {
      const rooms = [`announce:${id}`, `table:${id}`];
      let text: string | null = null;
      if (e.type === 'moved') text = tr('chat.sys.tMoved', { nick: e.name, from: e.fromNo, to: e.toNo, seat: e.seat });
      else if (e.type === 'tableBroken') {
        text = tr('chat.sys.tBroken', { no: e.no });
        void announcerRef?.announce('tableBroken', { no: e.no }, { rooms });
      } else if (e.type === 'finalTable') {
        text = tr('chat.sys.tFinalTable', { no: e.no });
        void announcerRef?.announce('finalTable', {}, { rooms });
      } else {
        text = tr(e.active ? 'chat.sys.tHandForHandOn' : 'chat.sys.tHandForHandOff');
        if (e.active) void announcerRef?.announce('handForHand', {}, { rooms });
      }
      if (!text) return;
      void (async () => {
        const channelId = await chat.channelIdByKey('table:' + id);
        if (channelId) await chat.system(channelId, text!);
      })().catch(() => undefined);
    },
    onEvent: (id, e) => {
      sayTournament(id, e);
      if (e.type === 'started' || e.type === 'level' || e.type === 'eliminated' || e.type === 'finished' || e.type === 'cancelled') void betsRef?.syncTournament(id).catch((err) => console.error('Sázky:', err instanceof Error ? err.message : err));
      if (e.type === 'eliminated') void bountiesRef?.onEliminated(id, e.userId, e.by.map((k) => ({ userId: k.userId, weight: k.weight }))).catch((err) => console.error('Odměny na hlavu:', err instanceof Error ? err.message : err));
      if (e.type === 'finished' && e.results[0]) void sounds?.jingle(e.results[0].userId, 'win', { kind: 'table', id }).catch(() => undefined);
      if (e.type === 'finished') void bountiesRef?.onFinished(id, e.results[0]?.userId ?? null).catch((err) => console.error('Odměny na hlavu:', err instanceof Error ? err.message : err));
      if (e.type === 'cancelled') void bountiesRef?.onCancelled(id).catch((err) => console.error('Odměny na hlavu:', err instanceof Error ? err.message : err));
      if (e.type === 'started') void eveningRef?.attach('tournament', id).catch(() => undefined);
      if (e.type === 'eliminated') progress.onElimination(id, e);
      if (e.type === 'finished') {
        const st = tournaments.get(id)?.state();
        if (st) stats.recordTournament(id, { ...tournaments.get(id)!.ratingInfo(), live: tournaments.isLive(id) }, st);
        if (st?.results) progress.onTournamentFinished(id, st.results, tournaments.schedOf(id)?.seriesId ?? null, st.finishedAt);
        if (st?.results) {
          // rating čeká, až se uloží vyřazení (fronta XP) a výsledky turnaje (fronta statistik)
          const info = tournaments.get(id)!.ratingInfo();
          const rebuys: Record<string, number> = {};
          for (const p of st.payments) if (p.kind === 'turnaj_rebuy' && !p.refunded) rebuys[p.userId] = (rebuys[p.userId] ?? 0) + 1;
          void progress.idle().then(() => stats.idle()).then(() => rating.onTournamentFinished(id, { ...info, live: tournaments.isLive(id), finishedAt: st.finishedAt, results: st.results!, rebuys }));
        }
        if (st?.results && st.results.length > 0) {
          // Každému, kdo se turnaje účastnil, se kdekoli v aplikaci ukáže přehled výsledků (výsledky všech hráčů jsou veřejné).
          const summary = st.results.map((r) => resultSummary(st, r));
          for (const r of st.results) emitTournamentResult(r.userId, { id, name: tournaments.nameOf(id) ?? '', summary });
        }
        if (st?.results && st.results.length > 0) {
          const results = st.results.slice(0, 3).map((r) => `${r.place}. ${r.name}${r.payout > 0 ? ` (+${r.payout})` : ''}`).join(', ');
          announce(tr('chat.sys.tournamentWinner', { name: tournaments.nameOf(id) ?? '', winner: st.results[0]!.name, results }));
        }
      }
      const text = tournamentChatText(e);
      if (!text) return;
      void (async () => {
        const channelId = await chat.channelIdByKey('table:' + id);
        if (channelId) await chat.system(channelId, text);
      })().catch(() => undefined);
    },
    nickOf,
    isOnline: (userId) => isOnline(userId),
    notify: (to, notice) => notifyTournament(to, notice),
  });
  tournamentsRef.current = tournaments;
  notificationsRef.current = notifications;
  const scheduler = new Scheduler({
    db,
    clock,
    tournaments,
    perms,
    audit,
    notify: (to, notice) => notifyTournament(to, notice),
    onError: (e) => console.error('Plánovač:', e instanceof Error ? e.message : e),
    tickMs: opts.schedulerTickMs,
  });
  schedulerRef.current = scheduler;
  const series = new SeriesService({ db, perms, audit, tournaments });
  seriesRef.current = series;
  await tournaments.load();
  // Jen při úplně prvním startu: když správce výchozí stůl zavře, nesmí se při dalším startu zakládat znovu (pád na duplicitním id).
  if (opts.defaultTable !== false && tables.list().length === 0 && !(await tables.anyEver())) {
    await tables.create({ id: 'stul-1', name: 'Stůl 1', templateId: 'cash-klasika', settings: opts.tableSettings ?? {} });
  }

  // Manifest s barvami výchozího motivu; musí být před statickými soubory, aby přebil výchozí manifest.
  app.get('/manifest.webmanifest', async (_req, reply) => reply.header('content-type', 'application/manifest+json').header('cache-control', 'no-cache').send(buildManifest(String(settings.resolve()['pwa.themeId']))));

  const webDir = opts.webDir ?? process.env.WEB_DIR;
  if (webDir && existsSync(webDir)) {
    // index.html a service worker se nesmí kešovat (jinak hráči po aktualizaci vidí starou verzi); soubory s otiskem v názvu naopak natrvalo.
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      setHeaders: (res) => {
        res.header('cache-control', res.request.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/socket.io')) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.status(404).send({ code: 'NOT_FOUND' });
    });
  }

  app.get('/api/tables', async (req, reply) => (!req.user ? reply.status(401).send({ code: 'INVALID_CREDENTIALS' }) : tables.list().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))));

  await app.ready();
  const io = new Server(app.server, { cors: { origin: false } });
  const gw = setupGateway({
    io,
    ledger,
    cash,
    tables: tables.actors,
    settings: () => settings.resolve(),
    perms,
    chat,
    authenticate: async (socket) => {
      const origin = socket.handshake.headers.origin;
      if (origin && !allowedOrigins().includes(origin)) return null;
      const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
      const user = await accounts.authenticate(token);
      return user ? { userId: user.id, name: user.nickname } : null;
    },
  });
  sounds = new SoundService({
    db,
    perms,
    settings: () => settings.resolve(),
    dir: opts.soundsDir ?? process.env.SOUNDS_DIR ?? (opts.dataDir ? join(opts.dataDir, '..', 'sounds') : mkdtempSync(join(tmpdir(), 'kb-sounds-'))),
    processor: opts.audioProcessor ?? new FfmpegProcessor(),
    extraSlots: (userId) => cosmeticsRef.extraSoundSlots(userId),
    jinglePref: (userId, kind) => String(settings.resolve([{ scope: 'user', scopeId: userId, values: settings.layer('user', userId) }])[kind === 'join' ? 'sounds.joinJingle' : 'sounds.winJingle'] ?? ''),
    onJingle: (e, kind) => tvRef?.pushJingle(e, kind, true),
    now: () => clock.now(),
    canSend: async (userId, target) => (target.kind === 'table' ? tableAccess(userId, target.id).write : chat.canWrite(userId, target.id)),
    emit: (target, e) => void io.to(target.kind === 'table' ? `table:${target.id}` : `chat:${target.id}`).emit('sound', e),
    post: (userId, channelId, body) => chat.send(userId, channelId, body),
    nickOf,
  });
  await sounds.init();
  const profileBuilder = new ProfileBuilder({
    db,
    perms,
    ledger,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    isOnline: (userId) => isOnline(userId),
    seated: () => new Map([...tables.actors].map(([id, a]) => [id, a.playersSeated().map((p) => p.userId)])),
    tournaments: () => tournaments.list().flatMap((r) => (tournaments.get(r.id) ? [{ id: r.id, tournament: tournaments.get(r.id)! }] : [])),
    progress,
    rating,
    stats,
    publicChannelIds: async () => (await db.select({ id: schema.chatChannels.id }).from(schema.chatChannels).where(eq(schema.chatChannels.kind, 'public'))).map((c) => c.id),
  });
  pollsRef = new PollService({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    profiles: profileBuilder,
    nickOf,
    notify: (userId, kind, params, link) => notifications.simple(userId, kind, params, link),
    push: async (userIds, title, body, url, tag) => void (await push.send(userIds, { title, body, url, tag })),
    announce: async (target, text) => {
      const channelId = target.kind === 'channel' && target.id ? target.id : target.kind === 'table' && target.id ? await chat.channelIdByKey('table:' + target.id) : await chat.ensureMainChannel();
      if (channelId) await chat.system(channelId, text);
    },
    canTarget: async (userId, target) => (target.kind === 'table' && target.id ? tableAccess(userId, target.id).write : target.kind === 'channel' && target.id ? chat.canWrite(userId, target.id) : true),
    emit: (id) => void io.emit('poll:changed', { id }),
    onCreated: (title) => out('poll.created', { title }),
    tournamentInfo: (id) => {
      const tour = tournaments.get(id);
      if (!tour) return null;
      const st = tour.state();
      return { name: tournaments.nameOf(id) ?? id, status: st.status, paused: st.paused, alive: st.players.filter((p) => p.status === 'playing' || p.status === 'deciding').map((p) => p.userId) };
    },
    runAction: async (kind, actor, params, winner) => {
      const str = (k: string) => String(params[k] ?? '');
      switch (kind) {
        case 'scheduleTournament': {
          if (!winner?.at) throw Object.assign(new Error('NO_WINNER'), { code: 'NO_WINNER' });
          const r = await tournaments.scheduleTournament(actor, { name: str('name'), templateId: str('templateId'), settings: (params.settings as Record<string, unknown> | undefined) ?? {}, startAt: winner.at });
          return { createdId: r.id };
        }
        case 'useTemplate': {
          const templateId = winner?.value ?? str('templateId');
          const r = await tables.createTable(actor, { name: str('name'), templateId });
          return { createdId: r.id };
        }
        case 'changeSettings': {
          const changes = (params.settings as Record<string, unknown> | undefined) ?? { [str('settingKey')]: coerceSettingValue(winner?.value ?? '') };
          if (params.gameKind === 'tournament') await tournaments.updateSettings(actor, str('id'), changes);
          else await tables.updateSettings(actor, str('id'), changes);
          return {};
        }
        case 'pauseGame':
          // Pauza odhlasovaná hráči turnaje (vytvořená serverem) se provede bez oprávnění zakladatele, běžná akce s ním.
          if (params.byVote === true) tournaments.pauseSystem(str('tournamentId'), false);
          else await tournaments.pause(actor, str('tournamentId'), false);
          return {};
        case 'endGame':
          if (params.gameKind === 'tournament') await tournaments.cancel(actor, str('id'));
          else await tables.closeTable(actor, str('id'));
          return {};
        case 'assignRole': {
          const role = perms.roleByKey(str('roleKey'));
          const target = str('userId') || winner?.value || '';
          if (!role || !target) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
          await perms.assignRole(actor, target, role.id);
          return {};
        }
      }
    },
  });
  themeService = new ThemeService({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    notify: (userId, kind, params) => notifications.simple(userId, kind, params, '/nastaveni'),
  });
  announcerRef = new AnnouncerService({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    secrets,
    emit: (rooms, payload) => void io.to(rooms).emit('announce', payload),
    tournaments: () => tournamentsRef.current!,
    dir: opts.announcerDir ?? process.env.ANNOUNCER_DIR ?? (opts.dataDir ? join(opts.dataDir, '..', 'announcer') : mkdtempSync(join(tmpdir(), 'kb-announcer-'))),
    fetchImpl: opts.announcerFetch,
  });
  await announcerRef.init();
  const announceTimer = setInterval(() => announcerRef.tick(), 1000);
  tvRef = new TvService({
    announcer: () => announcerRef,
    evenings: () => eveningRef,
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    tournaments: () => tournamentsRef.current!,
    tables: () => tablesRef.current!,
    stats: () => stats,
    rating: () => rating,
    mainChannelId: () => chat.ensureMainChannel(),
  });
  eveningRef = new EveningService({
    onClosed: (info) => out('evening.closed', info),
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    seated: () => tablesRef.current!.list().flatMap((row) => (tablesRef.current!.get(row.id)?.playersSeated() ?? []).map((s) => ({ userId: s.userId, tableId: row.id, chips: s.chips + s.pendingChips }))),
    postChat: async (text) => void (await chat.system(await chat.ensureMainChannel(), text)),
    createHandPoll: (title, labels, voterIds, hours) =>
      pollsRef.create(
        perms.mainAdminIds()[0]!,
        { title, config: { type: 'single', options: labels.map((label) => ({ label })) }, condition: { type: 'players', keys: voterIds }, eligibility: 'fixed', durationMinutes: hours * 60, results: 'afterVote' },
        { trusted: true },
      ),
    pollResult: async (pollId) => {
      const [p] = await db.select({ status: schema.polls.status, result: schema.polls.result }).from(schema.polls).where(eq(schema.polls.id, pollId));
      if (!p) return null;
      const r = (p.result ?? {}) as { winners?: string[]; voted?: number };
      return { open: p.status === 'open' || p.status === 'tie', winners: r.winners ?? [], votes: r.voted ?? 0 };
    },
    shareHand: (handId) => sharedHandsRef.shareSystem(handId),
    mail: (userId, template, vars) => mailUser(userId, 'email.notifyEvening', template, (prezdivka) => ({ prezdivka, ...vars })),
    onChanged: (id) => void io.emit('evening:changed', { id }),
  });
  const betDeps = {
    db,
    ledger,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    nickOf,
    facts: (id: string) => tournaments.facts(id),
    onWallet: (userId: string) => hooks.pushWallet(userId),
    onChanged: (tournamentId: string) => {
      void io.emit('bets:changed', { tournamentId });
      for (const tableId of tournaments.tableIdsOf(tournamentId)) broadcast(tableId);
    },
    notify: (userId: string, kind: string, params: Record<string, unknown>, link: string | null) => notifications.simple(userId, kind, params, link),
  };
  betsRef = new BetService(betDeps);
  bountiesRef = new HeadBountyService(betDeps);
  await bountiesRef.init();
  // Osobní limity: hlídá je účetní kniha (žádná cesta k penězům je neobejde).
  limitsRef = new LimitsService({
    db,
    ledger,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    eveningStart: () => eveningRef.currentStart(),
    seatedUsers: () => [...tablesRef.current!.actors.values()].flatMap((a) => a.playersSeated().map((p) => p.userId)),
    notify: (userId, kind, params, link) => notifications.simple(userId, kind, params, link),
  });
  await limitsRef.init();
  await eveningRef.refreshOpen();
  ledger.setGuard(limitsRef.guard);
  ledger.addListener(limitsRef.record);
  notesRef = new NotesService({ db, audit, now: () => clock.now() });
  sharedHandsRef = new SharedHandService({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    stats: () => stats,
    postChat: async (userId, channelId, body) => void (await chat.send(userId, channelId ?? (await chat.ensureMainChannel()), body)),
    createPoll: (userId, title, options) =>
      pollsRef.create(userId, {
        title: tr('hands.pollTitle'),
        description: title,
        config: { type: 'single', options: options.map((o) => ({ label: tr(`hands.poll.${o}`) })) },
        durationMinutes: Number(settings.resolve()['hands.pollHours']) * 60,
        results: 'afterVote',
      }),
    nickOf,
    notify: (userId, kind, params, link) => notifications.simple(userId, kind, params, link),
    onChanged: (id) => void io.emit('hand:changed', { id }),
  });
  cosmeticsRef = new CosmeticService({
    db,
    ledger,
    perms,
    audit,
    settings: () => settings.resolve(),
    now: () => clock.now(),
    levelOf: async (userId) => (await progress.progressOf(userId)).level,
    seasonPlacements: async () => {
      const out: { seasonId: string; order: string[] }[] = [];
      for (const s of await stats.seasons()) {
        if (s.endsAt === null || s.endsAt > clock.now()) continue;
        out.push({ seasonId: s.id, order: (await stats.leaderboard(await stats.range(s.id))).map((r) => r.userId) });
      }
      return out;
    },
    onWallet: (userId) => hooks.pushWallet(userId),
    onGranted: (userId, item) => void notifications.simple(userId, 'cosmeticGranted', { name: item.name }, '/obchod').catch(() => undefined),
    onLookChanged: (userId) => void io.emit('looks:changed', { userId }),
  });
  await cosmeticsRef.init();
  integrationsRef = new IntegrationService({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    secrets,
    fetcher: opts.integrationFetch,
    connector: opts.mqttConnector,
    now: () => clock.now(),
    summary: (): TournamentSummary | null => {
      const live = tournaments.list().flatMap((r) => {
        const tr = tournaments.get(r.id);
        return tr && ['running', 'registering'].includes(tr.state().status) ? [{ row: r, tour: tr }] : [];
      });
      const pick = live.find((x) => x.tour.state().status === 'running') ?? live[0];
      if (!pick) return null;
      const { row, tour } = pick;
      const st = tour.state();
      const alive = st.players.filter((p) => p.status === 'playing' || p.status === 'deciding').length;
      return { name: row.name, status: st.status, level: st.levelIndex + 1, players: st.status === 'registering' ? st.players.length : alive, prizePool: tour.prizePool() || 0 };
    },
    onError: (e) => console.error('Napojení ven selhalo:', e instanceof Error ? e.message : e),
  });
  chat.on({
    message: (c, m) => {
      if (c.kind === 'public' && !m.system && m.userId && m.body) out('chat.message', { nick: m.nickname ?? '', channel: c.key, text: m.body.length > 200 ? m.body.slice(0, 199) + '…' : m.body });
    },
  });
  apiTokensRef = new ApiTokenService({ db, perms, audit, accounts, settings: () => settings.resolve(), now: () => clock.now() });
  assistantRef = new AssistantService({
    db,
    perms,
    audit,
    registry,
    store: settings,
    settings: () => settings.resolve(),
    secrets,
    now: () => clock.now(),
    tables: () => tablesRef.current!,
    tournaments: () => tournamentsRef.current!,
    templates: () => templates,
    polls: () => pollsRef,
    nickOf,
    fetcher: opts.assistantFetch,
    provider: opts.assistantProvider,
  });
  mcpRef = new McpService({ db, perms, settings: () => settings.resolve(), assistant: () => assistantRef });
  const integrationsTimer = setInterval(() => void integrationsRef.tick().catch(() => undefined), 10_000);
  const cosmeticsTimer = setInterval(() => void cosmeticsRef.syncAll().catch(() => undefined), 3_600_000);
  const limitsTimer = setInterval(() => void limitsRef.tick().catch(() => undefined), 30_000);
  const betTimer = setInterval(() => void betsRef.tick().catch(() => undefined), 60_000);
  const eveningTimer = setInterval(() => void eveningRef.closeStale().then(() => eveningRef.finalizeHandVotes()).catch(() => undefined), 60_000);
  liveCashRef = new LiveCashService({
    onCreated: (id) => void eveningRef.attach('live_cash', id).catch(() => undefined),
    onClosed: (id, userIds, at) => progress.onLiveCashClosed(id, userIds, at),
    onMove: (id, kind, _userId, nick, amount) => void announcerRef.announce(kind === 'cashout' ? 'liveCashCashOut' : 'liveCashBuyIn', { nick, amount }, { rooms: [`announce:${id}`] }), db, ledger, perms, audit, settings: () => settings.resolve(), now: () => clock.now(), nickOf, onWallet: (userId) => hooks.pushWallet(userId), onChanged: (id) => void io.emit('live:changed', { id }) });
  themeAssetsRef = new ThemeAssets({
    db,
    perms,
    audit,
    settings: () => settings.resolve(),
    dir: opts.themeAssetsDir ?? process.env.THEME_ASSETS_DIR ?? (opts.dataDir ? join(opts.dataDir, '..', 'theme-assets') : mkdtempSync(join(tmpdir(), 'kb-theme-assets-'))),
  });
  await themeAssetsRef.init();
  const pollTimer = setInterval(() => void pollsRef.tick().catch((e) => console.error('Ankety:', e instanceof Error ? e.message : e)), 30_000);
  pollTimer.unref?.();
  broadcast = (tableId) => {
    gw.broadcast(tableId);
    tvRef.onTableChange(tableId);
  };
  isOnline = gw.isOnline;
  notifications.attach(io);
  if (opts.scheduler !== false) scheduler.start();
  emitTournamentChanged = (id) => void io.emit('tournament:changed', { id });
  emitTournamentResult = (userId, payload) => void io.to(`user:${userId}`).emit('tournament:result', payload);
  const sweepTimer = setInterval(() => tournaments.sweep(3600_000), 600_000);
  sweepTimer.unref?.();
  setupChatEvents(io, chat);
  new ChatNotifier({ db, chat, push, settings, isOnline: (userId) => isOnline(userId) }).attach();
  const digest = new ChatDigest({ db, chat, email, settings, publicUrl: publicUrlNow, now: () => clock.now() });
  const digestTimer = setInterval(() => void digest.run().catch(() => undefined), 3600_000);
  digestTimer.unref?.();
  const ratingTimer = setInterval(() => void rating.rateCash().then(() => rating.scanChipFlow()).catch(() => undefined), 3600_000);
  ratingTimer.unref?.();
  const purgeTimer = setInterval(() => {
    void chatImages.purgeOld().catch(() => undefined);
    void chat.purgeOld().catch(() => undefined);
    void stats.purgeOld().catch(() => undefined);
  }, 6 * 3600_000);
  purgeTimer.unref?.();
  hooks.pushWallet = (userId) => void io.to(`user:${userId}`).emit('wallet', { balance: ledger.balance(ledgerAccounts.wallet(userId)) });
  // Osobní nastavení se po změně hned projeví i na dalších zařízeních téhož hráče.
  settings.onChange((scope, scopeId, key, value) => {
    if (scope === 'user' || scope === 'userDevice') {
      const [userId, device] = scopeId.split(':');
      io.to(`user:${userId}`).emit('settings:changed', { scope, device: device ?? null, key, value: value ?? null });
    }
  });
  perms.onChange(() => void io.emit('permissions:changed'));

  const maintenance = new MaintenanceService({
    db,
    ledger,
    cash,
    flush: () => journal.flush(),
    perms,
    audit,
    settings: () => settings.resolve(),
    tables: () => tablesRef.current!,
    tournaments: () => tournamentsRef.current!,
    idle: async () => {
      await stats.idle();
      await progress.idle();
      await achievements.idle();
      await rating.idle();
    },
  });
  maintenanceRef.current = maintenance;
  const history = new HistoryService({ db, perms, audit, tables: () => tablesRef.current!, tournaments: () => tournamentsRef.current!, now: () => clock.now() });
  historyRef.current = history;
  const structures = new BlindStructureService({ db, perms, audit });
  structuresRef.current = structures;
  const timeline = new TimelineService({ db, settings: () => settings.resolve() });
  const overview = new OverviewService({
    db,
    ledger,
    settings: () => settings.resolve(),
    brief: (ids) => progress.brief(ids),
    rating: async (scope) => (await rating.leaderboard(scope)).map((r) => ({ userId: r.userId, rating: r.rating })),
  });

  let bootstrap: { created: boolean; password?: string } | undefined;
  if (opts.bootstrapAdmin) bootstrap = await accounts.ensureMainAdmin(opts.bootstrapAdmin.nickname, opts.bootstrapAdmin.password);

  return {
    app,
    io,
    db,
    ledger,
    cash,
    perms,
    audit,
    accounts,
    settings,
    secrets,
    email,
    approvals,
    wallet,
    chat,
    tables,
    tournaments,
    templates,
    maintenance,
    history,
    structures,
    timeline,
    overview,
    scheduler,
    notifications,
    push,
    stats,
    progress,
    achievements,
    rating,
    polls: pollsRef,
    themes: themeService,
    themeAssets: themeAssetsRef,
    liveCash: liveCashRef,
    tv: tvRef,
    announcer: announcerRef,
    evenings: eveningRef,
    bets: betsRef,
    headBounties: bountiesRef,
    limits: limitsRef,
    notes: notesRef,
    sharedHands: sharedHandsRef,
    cosmetics: cosmeticsRef,
    integrations: integrationsRef,
    apiTokens: apiTokensRef,
    assistant: assistantRef,
    mcp: mcpRef,
    sounds,
    chatImages,
    digest,
    series,
    journal,
    bootstrap,
    registry,
    walletAccount: ledgerAccounts.wallet,
    async listen(port = opts.port ?? Number(process.env.PORT ?? 3000)) {
      await app.listen({ port, host: '0.0.0.0' });
      return (app.server.address() as { port: number }).port;
    },
    async close() {
      email.stop();
      clearInterval(purgeTimer);
      clearInterval(digestTimer);
      clearInterval(ratingTimer);
      clearInterval(announceTimer);
      clearInterval(eveningTimer);
      clearInterval(betTimer);
      clearInterval(limitsTimer);
      clearInterval(cosmeticsTimer);
      clearInterval(integrationsTimer);
      integrationsRef.stop();
      clearInterval(pollTimer);
      rating.stop();
      achievements.stop();
      progress.stop();
      stats.stop();
      clearInterval(sweepTimer);
      scheduler.stop();
      await scheduler.idle();
      tournaments.stop();
      for (const t of tables.actors.values()) t.stop();
      await journal.flush();
      io.close();
      await app.close();
      await database.close();
    },
  };
}
