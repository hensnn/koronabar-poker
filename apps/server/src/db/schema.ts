import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Všechny částky jsou celá čísla v nejmenších jednotkách (bigint, v JS jako number). */
const money = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------- uživatelé ----------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nickname: text('nickname').notNull(),
    nicknameLower: text('nickname_lower').notNull(),
    email: text('email'),
    emailLower: text('email_lower'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash').notNull(),
    avatar: text('avatar'),
    /** active | pending (čeká na ověření/schválení) | blocked */
    status: text('status').notNull().default('active'),
    blockedReason: text('blocked_reason'),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    locale: text('locale').notNull().default('cs'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_nickname_lower_uq').on(t.nicknameLower), uniqueIndex('users_email_lower_uq').on(t.emailLower)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** Hash tokenu (token samotný je jen v cookie). */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  /** Role, kterou nový uživatel dostane (null = výchozí role Hráč). */
  roleId: uuid('role_id'),
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  email: text('email'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  note: text('note'),
  createdAt: createdAt(),
});

/** Jednorázové tokeny z odkazů (ověření e-mailu, obnova hesla). V DB jen hash. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** verify_email | reset_password | change_email */
    kind: text('kind').notNull(),
    /** Nový e-mail u change_email. */
    payload: text('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
);

// ---------- role a oprávnění ----------

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Úroveň síly 0–100. */
    power: integer('power').notNull(),
    color: text('color'),
    icon: text('icon'),
    /** Vestavěná role (jde upravit, ale ne smazat). */
    isSystem: boolean('is_system').notNull().default(false),
    /** Hlavní administrátor: vždy všechna oprávnění, nejde upravit ani smazat. */
    isLocked: boolean('is_locked').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('roles_key_uq').on(t.key)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    /** allow | deny (zákaz má přednost) */
    effect: text('effect').notNull().default('allow'),
    /** Limity oprávnění (např. maxPerOperation, maxPerDay, maxConcurrent). */
    limits: jsonb('limits').$type<Record<string, number>>(),
    /** Akce vyžaduje schválení druhou osobou (princip čtyř očí). */
    needsApproval: boolean('needs_approval').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    /** global | series | tournament | table | channel */
    scopeType: text('scope_type').notNull().default('global'),
    scopeId: text('scope_id').notNull().default(''),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('role_assignments_user_idx').on(t.userId), uniqueIndex('role_assignments_uq').on(t.userId, t.roleId, t.scopeType, t.scopeId)],
);

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Klíč oprávnění/akce, např. mena.dobit. */
  action: text('action').notNull(),
  payload: jsonb('payload').notNull(),
  requestedBy: uuid('requested_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** pending | approved | rejected | executed | expired */
  status: text('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  result: jsonb('result'),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    /** ui | assistant | api | mcp | cli | system */
    source: text('source').notNull().default('ui'),
    reason: text('reason'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_actor_idx').on(t.actorId)],
);

// ---------- nastavení a tajné údaje ----------

export const settingsValues = pgTable(
  'settings_values',
  {
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull().default(''),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scopeType, t.scopeId, t.key] })],
);

export const secrets = pgTable('secrets', {
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  keyVersion: integer('key_version').notNull(),
  last4: text('last4').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- účetní kniha ----------

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: text('id').primaryKey(),
  balance: money('balance').notNull().default(0),
});

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    gameId: text('game_id'),
    note: text('note'),
    createdBy: text('created_by'),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('ledger_tx_key_uq').on(t.idempotencyKey), index('ledger_tx_game_idx').on(t.gameId)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    transactionId: bigint('transaction_id', { mode: 'number' }).notNull().references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    account: text('account').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.seq] }), index('ledger_entries_account_idx').on(t.account)],
);

// ---------- stoly a hry ----------

export const gameTables = pgTable('game_tables', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** cash (turnaje přijdou ve fázi 3) */
  kind: text('kind').notNull().default('cash'),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  templateId: text('template_id'),
  /** Snímek hodnot vlastní šablony při založení (vestavěné šablony se berou z kódu, pozdější úprava šablony hru nemění). */
  templateValues: jsonb('template_values').$type<Record<string, unknown>>(),
  /** Přepsání nastavení pro tento stůl (vrstva „stůl“). */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('open'),
  createdAt: createdAt(),
});

/** Stav stolu k poslednímu předělu mezi handami (přežije restart serveru). */
export const tableState = pgTable('table_state', {
  tableId: text('table_id').primaryKey(),
  snapshot: jsonb('snapshot').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Spotřeba limitů oprávnění (např. dobití za den). */
export const permissionUsage = pgTable(
  'permission_usage',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    amount: money('amount').notNull().default(0),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('permission_usage_idx').on(t.userId, t.permission, t.at)],
);

// ---------- e-mail ----------

export const emailTemplates = pgTable('email_templates', {
  key: text('key').primaryKey(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  bodyHtml: text('body_html'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailQueue = pgTable(
  'email_queue',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    toAddress: text('to_address').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    /** security (bezpečnostní, mají přednost před denním limitem) | normal */
    priority: text('priority').notNull().default('normal'),
    /** pending | sent | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('email_queue_status_idx').on(t.status, t.nextAttemptAt)],
);

/** Žádosti hráčů (dobití měny, role, schválení obsahu) s frontou a historií vyřízení. */
export const userRequests = pgTable(
  'user_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** dobiti | role | schvaleni */
    kind: text('kind').notNull(),
    amount: money('amount'),
    message: text('message'),
    payload: jsonb('payload'),
    /** pending | approved | rejected | cancelled */
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
  },
  (t) => [index('user_requests_status_idx').on(t.status, t.kind)],
);

// ---------- chat ----------

export const chatChannels = pgTable(
  'chat_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** hospoda, dm:<id>:<id>, group:<náhodné>, table:<id stolu> */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** public | dm | group | table */
    kind: text('kind').notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    topic: text('topic'),
    createdAt: createdAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('chat_channels_key_uq').on(t.key)],
);

export const chatMembers = pgTable(
  'chat_members',
  {
    channelId: uuid('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    lastReadId: bigint('last_read_id', { mode: 'number' }).notNull().default(0),
    notifyMuted: boolean('notify_muted').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    channelId: uuid('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    replyTo: bigint('reply_to', { mode: 'number' }),
    system: boolean('system').notNull().default(false),
    mentions: jsonb('mentions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    pinnedBy: uuid('pinned_by'),
    /** Přiložený obrázek (`chat_images`). */
    image: uuid('image'),
  },
  (t) => [index('chat_messages_channel_idx').on(t.channelId, t.id)],
);

export const chatReactions = pgTable(
  'chat_reactions',
  {
    messageId: bigint('message_id', { mode: 'number' }).notNull().references(() => chatMessages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const chatMutes = pgTable(
  'chat_mutes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** null = ve všech kanálech */
    channelId: uuid('channel_id').references(() => chatChannels.id, { onDelete: 'cascade' }),
    until: timestamp('until', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
  },
  (t) => [index('chat_mutes_user_idx').on(t.userId)],
);

export const chatIgnores = pgTable(
  'chat_ignores',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    ignoredId: uuid('ignored_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ignoredId] })],
);

// ---------- turnaje ----------

/** Turnaj: nastavení (přepsání šablony), stav (hráči, hodiny, výsledky) a vlastník. Stůl turnaje má stav v `table_state`. */
export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  templateId: text('template_id'),
  /** Snímek hodnot vlastní šablony při založení (viz game_tables). */
  templateValues: jsonb('template_values').$type<Record<string, unknown>>(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** registering | running | finished | cancelled (zrcadlo stavu pro rychlé výpisy) */
  status: text('status').notNull().default('registering'),
  state: jsonb('state'),
  /** Plánování: čas startu, otevření registrace, odložení a odeslaná upozornění (viz TournamentManager). */
  sched: jsonb('sched'),
  createdAt: createdAt(),
});

/** Drobné systémové údaje (např. které položky katalogu oprávnění už byly rozdány předpřipraveným rolím). */
export const systemMeta = pgTable('system_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

// ---------- plánování turnajů ----------

/** Opakovaný plán: z něj plánovač vytváří nadcházející turnaje (výskyty). */
export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  templateId: text('template_id').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Pravidlo opakování (viz \`ScheduleRule\` v @kb/shared). */
  rule: jsonb('rule').notNull(),
  timezone: text('timezone').notNull().default('Europe/Prague'),
  enabled: boolean('enabled').notNull().default(true),
  seriesId: text('series_id'),
  createdAt: createdAt(),
});

// ---------- upozornění ----------

/** Upozornění uživatelům v aplikaci (turnaje, později další události). Text se skládá z klíče a parametrů. */
export const notifications = pgTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    link: text('link'),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

/** Série (liga): sdružuje plánované turnaje, bodování a finále. */
export const series = pgTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  config: jsonb('config').notNull(),
  createdAt: createdAt(),
});

// ---------- web push ----------

/** Odběr push upozornění z jednoho prohlížeče/zařízení (adresa u push služby a klíče pro šifrování zprávy). */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

// ---------- statistiky a historie hand ----------

/** Odehraná handa (cash i turnaj): akce po ulicích, board a výsledek. Skryté karty jsou v `hand_players`. */
export const hands = pgTable(
  'hands',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id').notNull(),
    kind: text('kind').notNull(),
    tournamentId: text('tournament_id'),
    handNumber: integer('hand_number').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    buttonSeat: integer('button_seat'),
    board: jsonb('board').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    pot: bigint('pot', { mode: 'number' }).notNull(),
    rake: bigint('rake', { mode: 'number' }).notNull().default(0),
    showdown: boolean('showdown').notNull().default(false),
    runs: integer('runs').notNull().default(1),
    /** Podrobnosti (akce, karty) byly po uplynutí doby uchování smazány. */
    purged: boolean('purged').notNull().default(false),
    /** Kolik žetonů odpovídá jedné jednotce měny (cash); u turnaje 1. */
    chipsPerUnit: integer('chips_per_unit').notNull().default(1),
    blinds: jsonb('blinds').$type<{ sb: number; bb: number; ante: number }>().notNull(),
    actions: jsonb('actions').$type<{ userId: string; street: string; action: string; amount: number; facing: number }[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [index('hands_played_idx').on(t.playedAt), index('hands_table_idx').on(t.tableId, t.playedAt)],
);

export const handPlayers = pgTable(
  'hand_players',
  {
    handId: text('hand_id').notNull().references(() => hands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    seat: integer('seat').notNull(),
    kind: text('kind').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    startStack: bigint('start_stack', { mode: 'number' }).notNull(),
    invested: bigint('invested', { mode: 'number' }).notNull(),
    won: bigint('won', { mode: 'number' }).notNull(),
    hole: jsonb('hole').$type<[string, string] | null>(),
    /** Karty hráče se ukázaly ostatním (showdown nebo dobrovolné ukázání); jinak je vidí jen on sám. */
    revealed: boolean('revealed').notNull().default(false),
    vpip: boolean('vpip').notNull().default(false),
    pfr: boolean('pfr').notNull().default(false),
    threeBetChance: boolean('three_bet_chance').notNull().default(false),
    threeBet: boolean('three_bet').notNull().default(false),
    sawFlop: boolean('saw_flop').notNull().default(false),
    showdown: boolean('showdown').notNull().default(false),
    wonShowdown: boolean('won_showdown').notNull().default(false),
    aggressive: integer('aggressive').notNull().default(0),
    calls: integer('calls').notNull().default(0),
    /** Síla ruky na showdownu (nižší je lepší) a překladový klíč kombinace; jen pokud došlo na showdown. */
    handScore: integer('hand_score'),
    /** Šance na výhru v okamžiku heads-up all-inu (0 až 1); jinak null. */
    allInEquity: doublePrecision('all_in_equity'),
    handKey: text('hand_key'),
  },
  (t) => [primaryKey({ columns: [t.handId, t.userId] }), index('hand_players_user_idx').on(t.userId, t.playedAt)],
);

/** Výsledek hráče v ukončené hře (zatím turnaj); cash se počítá z hand. Částky v měně. */
export const gameResults = pgTable(
  'game_results',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    place: integer('place').notNull(),
    field: integer('field').notNull(),
    spent: bigint('spent', { mode: 'number' }).notNull(),
    payout: bigint('payout', { mode: 'number' }).notNull(),
    bounty: bigint('bounty', { mode: 'number' }).notNull().default(0),
    rebuys: integer('rebuys').notNull().default(0),
    /** Údaje pro zpětný přepočet ratingu. */
    targetMinutes: integer('target_minutes'),
    rated: boolean('rated').notNull().default(true),
    /** Živá hra (skutečné karty): samostatný typ hry, do ratingu jde s váhou z nastavení. */
    live: boolean('live').notNull().default(false),
  },
  (t) => [uniqueIndex('game_results_uq').on(t.kind, t.ref, t.userId), index('game_results_user_idx').on(t.userId, t.finishedAt)],
);

/** Sezóna žebříčku: časové okno; žebříček za sezónu sčítá jen hry v něm. */
export const seasons = pgTable('seasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------- zvukové emotikony ----------

/** Zvukový emotikon: soubor je na disku (volume), tady jsou jen údaje o něm. */
export const soundEmotes = pgTable(
  'sound_emotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null = vestavěný. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    shortcut: text('shortcut').notNull(),
    emoji: text('emoji').notNull().default('🔊'),
    category: text('category').notNull().default('ostatni'),
    /** private (jen autor), pending (čeká na schválení), shared (ve společné knihovně), hidden (skryl správce). */
    status: text('status').notNull().default('private'),
    mime: text('mime').notNull(),
    durationMs: integer('duration_ms').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    builtin: boolean('builtin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sound_emotes_shortcut_uq').on(t.shortcut), index('sound_emotes_owner_idx').on(t.ownerId)],
);

/** Oblíbené a naposledy použité zvuky hráče. */
export const soundFavorites = pgTable(
  'sound_favorites',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    soundId: uuid('sound_id').notNull().references(() => soundEmotes.id, { onDelete: 'cascade' }),
    favorite: boolean('favorite').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    uses: integer('uses').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.soundId] })],
);

/** Příjemce ztlumil konkrétní zvuk, hráče nebo kanál/stůl. */
export const soundMutes = pgTable(
  'sound_mutes',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    target: text('target').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.target] })],
);

/** Obrázek přiložený ke zprávě v chatu. Soubor je na disku; do zprávy se připojí při odeslání. */
export const chatImages = pgTable('chat_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  attached: boolean('attached').notNull().default(false),
  createdAt: createdAt(),
});

// ---------- zkušenosti a hodnosti ----------

/** Zápis zkušeností. Kombinace (hráč, zdroj, odkaz) je jedinečná, takže přepočet z historie nic nezdvojí. */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    ref: text('ref').notNull(),
    day: text('day').notNull(),
    amount: integer('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('xp_events_uq').on(t.userId, t.source, t.ref), index('xp_events_user_day_idx').on(t.userId, t.day)],
);

/** Součet XP a level hráče (odvozeno z `xp_events`, kvůli rychlému zobrazení). */
export const playerProgress = pgTable('player_progress', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  xp: bigint('xp', { mode: 'number' }).notNull().default(0),
  level: integer('level').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Kdo koho vyřadil v turnaji (základ pro XP, rating a vzájemnou bilanci). */
export const tournamentEliminations = pgTable(
  'tournament_eliminations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tournamentId: text('tournament_id').notNull(),
    victimId: uuid('victim_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    place: integer('place').notNull(),
    killers: jsonb('killers').$type<{ userId: string; weight: number; equity?: number | null }[]>().notNull().default(sql`'[]'::jsonb`),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('tournament_eliminations_uq').on(t.tournamentId, t.victimId, t.place)],
);

/** Katalog úspěchů: vestavěné i vlastní. Podmínka je z pevné nabídky typů (viz `@kb/shared`). */
export const achievements = pgTable('achievements', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon').notNull(),
  description: text('description').notNull(),
  condition: jsonb('condition').$type<{ type: string; value: number; rank?: string }>().notNull(),
  xp: integer('xp').notNull().default(0),
  builtin: boolean('builtin').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
});

export const playerAchievements = pgTable(
  'player_achievements',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull().references(() => achievements.key, { onDelete: 'cascade' }),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// ---------- herní rating ----------

/** Aktuální síla hráče (OpenSkill): zvlášť turnajový a cash rating. */
export const ratingState = pgTable(
  'rating_state',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    mu: doublePrecision('mu').notNull(),
    sigma: doublePrecision('sigma').notNull(),
    games: integer('games').notNull().default(0),
    peak: integer('peak').notNull(),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope] })],
);

/** Historie změn ratingu s rozpisem (proč se rating změnil). Jedinečné podle (hráč, druh, odkaz), takže přepočet nic nezdvojí. */
export const ratingEvents = pgTable(
  'rating_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    /** Turnaj: id turnaje; cash: stůl:den; reset: reset:časová značka. */
    ref: text('ref').notNull(),
    kind: text('kind').notNull().default('game'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    muBefore: doublePrecision('mu_before').notNull(),
    sigmaBefore: doublePrecision('sigma_before').notNull(),
    muAfter: doublePrecision('mu_after').notNull(),
    sigmaAfter: doublePrecision('sigma_after').notNull(),
    displayBefore: integer('display_before').notNull(),
    displayAfter: integer('display_after').notNull(),
    breakdown: jsonb('breakdown').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex('rating_events_uq').on(t.userId, t.scope, t.ref), index('rating_events_user_idx').on(t.userId, t.scope, t.at)],
);

/** Podezření na zneužití ratingu (opakované heads-upy, jednosměrný tok žetonů) ke kontrole správcem. */
export const ratingFlags = pgTable(
  'rating_flags',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    /** U toku žetonů hráč, který žetony posílá; u heads-upů první z dvojice. */
    userA: uuid('user_a').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userB: uuid('user_b').notNull().references(() => users.id, { onDelete: 'cascade' }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    windowKey: text('window_key').notNull(),
    status: text('status').notNull().default('open'),
    note: text('note'),
    createdAt: createdAt(),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('rating_flags_uq').on(t.kind, t.userA, t.userB, t.windowKey), index('rating_flags_status_idx').on(t.status)],
);

// ---------- ankety a hlasování ----------

export const polls = pgTable(
  'polls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    founderId: uuid('founder_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** Nastavení ankety (typ, možnosti, většina, kvórum, váhy…); viz `PollConfig` v `@kb/shared`. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** Strom podmínek, kdo smí hlasovat. */
    condition: jsonb('condition').$type<Record<string, unknown>>().notNull(),
    /** fixed = okruh se zafixoval při spuštění, live = vyhodnocuje se průběžně. */
    eligibility: text('eligibility').notNull().default('fixed'),
    /** Zafixovaný okruh hlasujících s vahami (jen u eligibility = fixed). */
    voters: jsonb('voters').$type<{ userId: string; weight: number; power?: number }[] | null>(),
    /** Kde se anketa ukazuje: chat kanál, stůl, nebo všude. */
    targetKind: text('target_kind').notNull().default('global'),
    targetId: text('target_id'),
    /** always | afterVote | afterClose */
    results: text('results').notNull().default('afterVote'),
    /** open | closed | cancelled | tie (čeká na rozhodnutí zakladatele) */
    status: text('status').notNull().default('open'),
    pinned: boolean('pinned').notNull().default(false),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    reminded: boolean('reminded').notNull().default(false),
    extended: boolean('extended').notNull().default(false),
    /** Výsledek po skončení (včetně toho, jak se rozhodla remíza). */
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    /** Navázaná akce po schválení (zatím jen zápis; provádí se v dalším kroku). */
    action: jsonb('action').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [index('polls_status_idx').on(t.status, t.endsAt)],
);

/** Hlas hráče. U tajných anket je `answer` prázdný (ukládá se jen, že hlasoval). */
export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id').notNull().references(() => polls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    answer: jsonb('answer').$type<Record<string, unknown> | null>(),
    weight: doublePrecision('weight').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.userId] })],
);

/** Anonymní lístky tajných anket: bez odkazu na hráče, jen odpověď a váha. */
export const pollSecretBallots = pgTable(
  'poll_secret_ballots',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    pollId: uuid('poll_id').notNull().references(() => polls.id, { onDelete: 'cascade' }),
    answer: jsonb('answer').$type<Record<string, unknown>>().notNull(),
    weight: doublePrecision('weight').notNull(),
  },
  (t) => [index('poll_secret_ballots_idx').on(t.pollId)],
);

export const pollTemplates = pgTable('poll_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

// ---------- vlastní motivy vzhledu ----------

/** Vlastní motiv: jen tokeny (světlé a tmavé hodnoty). Stav: private, pending (čeká na schválení), shared, hidden. */
export const themes = pgTable(
  'themes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    data: jsonb('data').$type<{ schemaVersion: number; light: Record<string, string>; dark: Record<string, string> }>().notNull(),
    status: text('status').notNull().default('private'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('themes_owner_idx').on(t.ownerId), index('themes_status_idx').on(t.status)],
);

/** Obrázek pro motiv vzhledu (textura plsti, pozadí, rub karet, logo). Soubor je na disku. */
export const themeAssets = pgTable(
  'theme_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('theme_assets_owner_idx').on(t.ownerId)],
);

/** Živý cash game (skutečné karty u stolu): evidence buy-inů, poplatků a cash-outů. Peníze leží na účtu stolu v účetní knize. */
export const liveCashGames = pgTable('live_cash_games', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  /** open | closed */
  status: text('status').notNull().default('open'),
  state: jsonb('state'),
  createdAt: createdAt(),
});

/** Televize (TV režim): spárované zařízení čte jen veřejný snapshot. Token ani kód se neukládají, jen jejich otisk. */
export const tvDevices = pgTable('tv_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  layoutId: text('layout_id'),
  tokenHash: text('token_hash'),
  pairCodeHash: text('pair_code_hash'),
  pairExpiresAt: timestamp('pair_expires_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** Herní večer: seskupuje hry a po uzavření drží uložený souhrn (vyúčtování, MVP, ocenění). */
export const evenings = pgTable('evenings', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** open | closed */
  status: text('status').notNull().default('open'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  /** Poslední aktivita (nová hra nebo handa): podle ní se pozná, že večer skončil. */
  touchedAt: timestamp('touched_at', { withTimezone: true }).notNull(),
  /** Vznikl automaticky při startu hry (jen takové se zavírají samy). */
  auto: boolean('auto').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  summary: jsonb('summary'),
  /** Hlasování o handě večera: anketa a kandidáti (kandidát = možnost ankety). */
  handVote: jsonb('hand_vote'),
  createdAt: createdAt(),
});

/** Hry večera: turnaj (tournament), živý cash (live_cash) nebo cash stůl (cash, jen v časovém okně večera). */
export const eveningGames = pgTable(
  'evening_games',
  {
    eveningId: uuid('evening_id').notNull().references(() => evenings.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eveningId, t.kind, t.ref] }), index('evening_games_ref_idx').on(t.kind, t.ref)],
);

// ---------- sázky a odměny na hlavu ----------

/** Sázka vedle hry. Vklady leží na účtu `escrow:<id>` v účetní knize, dokud se sázka nevypořádá. */
export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: text('tournament_id').notNull(),
    /** pool = sázkový bank, direct = přímá sázka dvou hráčů */
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    title: text('title').notNull(),
    creatorId: uuid('creator_id').references(() => users.id, { onDelete: 'set null' }),
    /** open | locked | proposed | disputed | settled | void */
    status: text('status').notNull().default('open'),
    closeRule: text('close_rule').notNull().default('start'),
    feePercent: integer('fee_percent').notNull().default(0),
    outcome: text('outcome'),
    proposedOutcome: text('proposed_outcome'),
    proposedBy: uuid('proposed_by'),
    proposedAt: timestamp('proposed_at', { withTimezone: true }),
    note: text('note'),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [index('bets_tournament_idx').on(t.tournamentId), index('bets_status_idx').on(t.status)],
);

export const betStakes = pgTable(
  'bet_stakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id').notNull().references(() => bets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    side: text('side').notNull(),
    amount: money('amount').notNull(),
    /** held | paid | refunded */
    status: text('status').notNull().default('held'),
    payout: money('payout').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('bet_stakes_bet_idx').on(t.betId), index('bet_stakes_user_idx').on(t.userId)],
);

/** Odměna za vyřazení hráče v turnaji, zablokovaná z peněz zadavatele. */
export const headBounties = pgTable(
  'head_bounties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: text('tournament_id').notNull(),
    targetId: uuid('target_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    posterId: uuid('poster_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    amount: money('amount').notNull(),
    /** open | paid | returned | forfeited */
    status: text('status').notNull().default('open'),
    paidTo: jsonb('paid_to').$type<{ userId: string; amount: number }[]>(),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [index('head_bounties_tournament_idx').on(t.tournamentId, t.status)],
);

// ---------- osobní limity a poznámky o hráčích ----------

/** Osobní limity hráče (platné), čekající uvolnění a pauza od hry. */
export const personalLimits = pgTable('personal_limits', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  current: jsonb('current').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  pending: jsonb('pending').$type<Record<string, { value: number; at: number }>>().notNull().default(sql`'{}'::jsonb`),
  breakUntil: timestamp('break_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Štítky, které si hráč vytváří k poznámkám (barva je klíč designového tokenu). */
export const noteLabels = pgTable(
  'note_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('note_labels_owner_idx').on(t.ownerId)],
);

/** Soukromá poznámka a štítek hráče k jinému hráči; vidí je jen autor. */
export const playerNotes = pgTable(
  'player_notes',
  {
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    note: text('note').notNull().default(''),
    labelId: uuid('label_id').references(() => noteLabels.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.targetId] })],
);

// ---------- sdílené handy ----------

/** Handa sdílená do chatu jako karta (autor může dobrovolně odkrýt své karty). */
export const sharedHands = pgTable(
  'shared_hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    handId: text('hand_id').notNull(),
    /** Autor sdílení; prázdný u handy večera sdílené systémem. */
    sharedBy: uuid('shared_by').references(() => users.id, { onDelete: 'set null' }),
    /** Hráči, kteří při sdílení dobrovolně odkryli své karty. */
    revealed: jsonb('revealed').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    pollId: uuid('poll_id'),
    createdAt: createdAt(),
  },
  (t) => [index('shared_hands_hand_idx').on(t.handId)],
);

export const handComments = pgTable(
  'hand_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedId: uuid('shared_id').notNull().references(() => sharedHands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('hand_comments_shared_idx').on(t.sharedId)],
);

export const handReactions = pgTable(
  'hand_reactions',
  {
    sharedId: uuid('shared_id').notNull().references(() => sharedHands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sharedId, t.userId, t.emoji] })],
);

// ---------- kosmetika a obchod ----------

/** Katalog kosmetických předmětů (vestavěné i vlastní od kurátora). */
export const cosmeticItems = pgTable('cosmetic_items', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  look: jsonb('look').$type<Record<string, unknown>>().notNull(),
  acquire: jsonb('acquire').$type<Record<string, unknown>>().notNull(),
  /** Cena v obchodě; prázdná = nelze koupit. */
  price: integer('price'),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  availableUntil: timestamp('available_until', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(true),
  builtin: boolean('builtin').notNull().default(false),
  createdAt: createdAt(),
});

/** Předměty hráče; `equipped` = právě nosí. */
export const playerCosmetics = pgTable(
  'player_cosmetics',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull().references(() => cosmeticItems.key, { onDelete: 'cascade' }),
    /** level | rank | achievement | season | shop | grant */
    source: text('source').notNull(),
    paid: integer('paid').notNull().default(0),
    equipped: boolean('equipped').notNull().default(false),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemKey] }), index('player_cosmetics_user_idx').on(t.userId)],
);

// ---------- napojení ven ----------

/** Adresy odchozích webhooků. Prázdný seznam událostí = všechny nehlučné. */
export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  events: jsonb('events').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
});

/** Log doručení webhooků a Discordu (target: `endpoint:<id>` nebo `discord`). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    target: text('target').notNull(),
    endpointId: uuid('endpoint_id').references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** pending | ok | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    responseCode: integer('response_code'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt), index('webhook_deliveries_created_idx').on(t.createdAt)],
);

// ---------- osobní přístupové tokeny (REST API) ----------

/** Token se ukládá jen jako otisk; celá hodnota se ukáže jednou při vytvoření. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Prvních pár znaků pro poznání tokenu v seznamu. */
    hint: text('hint').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_hash_idx').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
);

// ---------- vlastní šablony nastavení (cash i turnaje) ----------

/** Vlastní šablona správce: kompletní sada hodnot pro vrstvu „šablona“. Vestavěné šablony jsou v kódu. */
export const settingsTemplates = pgTable('settings_templates', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  values: jsonb('values').$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

/** Uložené struktury blindů (pojmenované), které jde vybrat při zakládání turnaje a přepočítat na jiný stack. */
export const blindStructures = pgTable('blind_structures', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Zápis levelů „25/50, 50/100/10…“. */
  levels: text('levels').notNull(),
  /** Stack, pro který byla struktura navržena (podle něj se přepočítává). */
  startingStack: integer('starting_stack').notNull(),
  levelMinutes: integer('level_minutes').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

// ---------- veřejné přehledy (statistiky na sdíleném odkazu) ----------

/** Veřejný přehled hráčů (žebříček, zisk, zkušenosti…) dostupný bez přihlášení přes tajný odkaz (`token`). */
export const publicBoards = pgTable(
  'public_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Tajná část odkazu; jde vyměnit, čímž starý odkaz přestane fungovat. */
    token: text('token').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Sloupce, řazení, období, počet řádků, skrytí hráčů… (viz `PublicBoardConfig`). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('public_boards_token_uq').on(t.token)],
);

// ---------- AI asistent a MCP ----------

/** Historie konverzace s asistentem (jen vlastní uživatel ji vidí). */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    context: text('context').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    proposalIds: jsonb('proposal_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('assistant_messages_user_idx').on(t.userId, t.createdAt)],
);

/** Návrh změn, který čeká na potvrzení (nebo už byl vyřízen). */
export const assistantProposals = pgTable(
  'assistant_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** assistant | mcp */
    source: text('source').notNull(),
    requestText: text('request_text').notNull().default(''),
    actions: jsonb('actions').$type<unknown[]>().notNull(),
    diff: jsonb('diff').$type<unknown[]>().notNull(),
    summary: text('summary').notNull().default(''),
    status: text('status').notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('assistant_proposals_user_idx').on(t.userId, t.createdAt)],
);

/** Verze upravených promptů; `isDefault` = návrat k výchozímu textu. */
export const assistantPromptVersions = pgTable(
  'assistant_prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    text: text('text').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('assistant_prompt_versions_key_idx').on(t.key, t.version)],
);

/** Spotřeba za den a hráče. */
export const assistantUsage = pgTable(
  'assistant_usage',
  {
    day: text('day').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    requests: integer('requests').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.userId] })],
);

/** Log volání MCP serveru. */
export const mcpCalls = pgTable(
  'mcp_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id'),
    tool: text('tool').notNull(),
    ok: boolean('ok').notNull(),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('mcp_calls_created_idx').on(t.createdAt)],
);
