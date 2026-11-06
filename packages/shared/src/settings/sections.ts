import { groupOf, SPECIAL_GROUPS } from './groups.js';

/**
 * Uspořádání formuláře nastavení do tří úrovní: oddíl (postranní panel) → kategorie (rozbalovací panel) → podskupina (vnořený panel).
 * Vše se odvozuje z klíčů a kategorií v registru, takže nový parametr se jen zařadí sem a formulář zůstává vygenerovaný.
 */

export const SECTIONS = [
  { id: 'table', categories: ['table', 'time', 'timing', 'cash', 'rake', 'odds', 'live', 'special'] },
  { id: 'tournaments', categories: ['tournament', 'tournamentSchedule', 'tournamentFees', 'tournamentPayout', 'evening'] },
  { id: 'money', categories: ['economy', 'limits', 'rating', 'xp', 'stats', 'cosmetics'] },
  { id: 'look', categories: ['ui', 'theme', 'tv'] },
  { id: 'comms', categories: ['chat', 'poll', 'hands', 'sounds', 'announcer', 'email', 'assistant'] },
  { id: 'system', categories: ['system', 'integrations', 'api'] },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/** Oddíl, do kterého kategorie patří; neznámá kategorie spadne do oddílu „other“ (test hlídá, že žádná taková není). */
export function sectionOf(category: string): SectionId | 'other' {
  return SECTIONS.find((s) => (s.categories as readonly string[]).includes(category))?.id ?? 'other';
}

/** Pořadí kategorie uvnitř svého oddílu (neznámé až na konec). */
export function categoryRank(category: string): number {
  const s = SECTIONS.find((x) => (x.categories as readonly string[]).includes(category));
  return s ? (s.categories as readonly string[]).indexOf(category) : 999;
}

type Rule = [id: string, re: RegExp];

/**
 * Podskupiny velkých kategorií. Pořadí pravidel je pořadí panelů, platí první shoda a nezařazená položka spadne do „Ostatní“.
 * Kategorie bez pravidel (malé) podskupiny nemají. Speciální prvky mají vlastní, starší dělení v `groups.ts`.
 */
export const SUBGROUP_RULES: Record<string, Rule[]> = {
  ui: [
    ['ui.look', /^ui\.(colorMode|density|themeId|fontScalePercent|reducedMotion)$/],
    ['ui.chat', /^ui.chat(List|TablesWithChannels|HideEmpty)$/],
    ['ui.scale', /^ui\.scaleLock/],
    ['ui.layout', /^ui\.(tablePanel|sizePerDisplay|sizeProfiles|tableLayout|foldState|statsSeason|statsCompare|adminLast|tableSide|noteWindow|tableArea|tableFitWindow|tableHeightPercent|tableChat|compactHeader)/],
    ['ui.show', /^(ui\.(showPlayerNotes|showSymbol|showChipLabel|rotateToMe|hideMyCards|chipLeaderCrown|winImpact|betChips|tableWaitInfo|tournamentWaitBanner|tableNotices|timeoutNotice|showSystem|showPlayers|showInBb)|chat\.show)/],
    ['ui.showdown', /^ui\.(showdown|runItResponse)/],
    ['ui.actions', /^ui\.(auto|quickBets|plan)/],
    ['ui.animations', /^ui\.(dealAnimation|dealCardMs|eventAnimations|warnSeconds|warnFinalSeconds)$/],
    ['ui.hotkeys', /^ui\.hotkey/],
    ['ui.sfx', /^ui\.(sfx|vibrate)/],
    ['ui.mobile', /^ui\.mobile/],
  ],
  rating: [
    ['rating.basic', /^rating\.(enabled|tournamentsEnabled|cashEnabled|showNumbers)$/],
    ['rating.model', /^rating\.(mu0|sigma0Hundredths|k|scale|base|provisionalGames)$/],
    ['rating.tournament', /^rating\.(knockout|minPlayers|fullField|lengthRef|lengthMin|rebuyPenalty)/],
    ['rating.cash', /^rating\.(cashWeightPercent|cashMinHands|cashProvisionalGames)$/],
    ['rating.ev', /^rating\.(evShare|equity)/],
    ['rating.season', /^rating\.(inactivity|seasonReset)/],
    ['rating.abuse', /^rating\.(pairFlag|flag|dump|pairWindow|pairDecay)/],
    ['rating.divisions', /^rating\.division/],
  ],
  assistant: [
    ['assistant.basic', /^assistant\.(enabled|suggestEnabled|voice)/],
    ['assistant.models', /^assistant\.(provider|baseUrl|model|temperature|maxTokens)/],
    ['assistant.limits', /^assistant\.(timeout|retries|totalTimeout|perMinute|perUserDaily|globalDaily|usageWarn)/],
    ['assistant.tools', /^(mcp\.|assistant\.(localFirst|toolResultChars|historySize|maxToolSteps|disabledTools|proposalMinutes|autoKeys))/],
  ],
  integrations: [
    ['integrations.general', /^integrations\.(enabled|logDays|bigPotBb|allowPrivateUrls)$/],
    ['integrations.webhooks', /^integrations\.webhook/],
    ['integrations.discord', /^integrations\.discord/],
    ['integrations.mqtt', /^integrations\.mqtt/],
  ],
  theme: [
    ['theme.branding', /^branding\./],
    ['theme.login', /^login\./],
    ['theme.themes', /^theme\./],
  ],
  limits: [
    ['limits.general', /^limits\.(enabled|loosen|maxBreakDays|sessionGap)/],
    ['limits.show', /^limits\.show\./],
    ['limits.global', /^limits\.global\./],
  ],
  sounds: [
    ['sounds.player', /^sounds\.(enabled|play|mentionSound|hotkeys|volume|mode)$/],
    ['sounds.library', /^sounds.(formats|maxFileKb|maxSeconds|maxPerUser|requireApproval|storageQuotaMb|loudnessTarget|ffmpegTimeoutSeconds)$/],
    ['sounds.limits', /^sounds\.(userCooldownSeconds|soundCooldownSeconds|perMinuteLimit)$/],
    ['sounds.jingles', /^sounds\.(jingle|joinJingle|winJingle)/],
  ],
  table: [
    ['table.basic', /^table\.(seats|variant|bettingLimit|limitMaxBets|smallBlind|bigBlind|ante|bbAnte|deadButton|deadBlindBb|newPlayerRule)$/],
    ['table.straddle', /^table\.straddle/],
    ['table.ready', /^table\.ready/],
    ['table.display', /^table\.(winImpact|showChipLabel|chipLabel)/],
  ],
  email: [
    ['email.server', /^email\.(enabled|smtp|from|replyTo|dailyLimit|maxAttempts)/],
    ['email.rules', /^email\.(disabledKinds|recipient|blockList|allowUserOptOut)/],
    ['email.notify', /^email\.notify/],
  ],
  xp: [
    ['xp.general', /^xp\.(enabled|announceLevelUp|showAtTable|showInChat)$/],
    ['xp.earn', /^xp\.(perHand|showdownWin|cashSession|tournament|placementPerBeaten|itm|knockout|first|series|dailyCap|minHumanPlayers)/],
    ['xp.levels', /^xp\.(level|ranks)/],
  ],
  poll: [
    ['poll.general', /^poll\.(enabled|notify|pushNotify|maxNotified|reminderMinutes)$/],
    ['poll.defaults', /^poll\.(default|minDuration|maxDuration|maxOpen|tieExtend)/],
    ['poll.pause', /^poll\.pauseVote/],
  ],
  chat: [
    ['chat.general', /^chat\.(enabled|mainChannelName|maxLength|messagesPerMinute|historyDays|editWindowMinutes|playerChannels|groupsEnabled|spectatorChat|wordFilter|autoTournamentMessages|emojiList)$/],
    ['chat.images', /^chat\.image/],
    ['chat.notify', /^(chat\.digest|push\.chat)/],
  ],
  tournament: [
    ['tournament.basic', /^tournament\.(buyIn|fee|startingStack|minPlayers|maxTables|balanceMaxDiff|handForHand|autoStartWhenFull)$/],
    ['tournament.levels', /^tournament\.(level|targetMinutes|structure)/],
    ['tournament.breaks', /^tournament\.(break|lateReg)/],
  ],
  system: [
    ['system.access', /^system\.(passwordMin|session|emailVerification|verifyLink|resetLink|login|mailRequests|inviteDefault|terms)/],
    ['system.server', /^(system\.(rateLimit|publicUrl|timezone|profiles|maxSockets|announceRooms|uploadMax)|templates\.|liveCash\.|pwa\.)/],
  ],
  economy: [
    ['economy.currency', /^economy\.(currency|decimals)/],
    ['economy.balance', /^(economy\.(starting|negative|credit|topup|debit)|finance\.)/],
    ['economy.transfer', /^economy\.transfer/],
  ],
  time: [
    ['time.turn', /^time\.(turnSeconds|expiryAction|timeoutsToSitOut|minTurnSeconds|disconnectGrace|callClock)/],
    ['time.bank', /^time\.(timeBank|bank|timeChip|increment)/],
  ],
  timing: [
    ['timing.reveal', /^time\.(deal|betweenHands|showCards|flopReveal|turnReveal|riverReveal)/],
    ['timing.allin', /^time\.(allIn|showdown|runIt)/],
    ['timing.misc', /^time\.(potToWinner|animation|autoAnswer)/],
  ],
  announcer: [
    ['announcer.main', /^announcer\.(enabled|source|tvSource|allowUserChoice|ratePercent|volumePercent|countdownSeconds)$/],
    ['announcer.voices', /^announcer\.(piper|google|cache)/],
    ['announcer.user', /^announcer\.(mute|user)/],
  ],
};

/** Podskupina jedné položky v kategorii s pravidly (jinak null); co se nikam nehodí, patří do „other“. Speciální prvky řeší `groupOf`. */
export function subgroupOf(key: string, category: string): string | null {
  const rules = SUBGROUP_RULES[category];
  if (!rules) return null;
  return rules.find(([, re]) => re.test(key))?.[0] ?? 'other';
}

/** Podskupiny kategorie v pořadí zobrazení (včetně „other“ na konci); prázdné pole = kategorie podskupiny nemá. */
export function subgroupIds(category: string): string[] {
  const rules = SUBGROUP_RULES[category];
  return rules ? [...rules.map(([id]) => id), 'other'] : [];
}

/** Podskupina položky pro formulář: u Speciálních prvků starší dělení, jinde pravidla výše. */
export function panelGroupOf(key: string, category: string): string | null {
  return category === 'special' ? groupOf(key, category) : subgroupOf(key, category);
}

/** Podskupiny kategorie v pořadí zobrazení pro formulář. */
export function panelGroupIds(category: string): string[] {
  return category === 'special' ? [...SPECIAL_GROUPS] : subgroupIds(category);
}
