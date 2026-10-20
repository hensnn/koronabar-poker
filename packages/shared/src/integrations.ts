/**
 * Události, které aplikace posílá ven (MQTT pro Home Assistant, webhooky, Discord). Tělo události nikdy
 * neobsahuje skrytá herní data (cizí karty, balíček): jen to, co se dozví každý u stolu nebo v chatu.
 */
export const INTEGRATION_EVENTS = [
  'tournament.registration',
  'tournament.started',
  'tournament.level',
  'tournament.break',
  'tournament.breakEnd',
  'tournament.finished',
  'player.eliminated',
  'player.allIn',
  'hand.bigPot',
  'hand.badBeat',
  'chat.message',
  'poll.created',
  'evening.closed',
] as const;
export type IntegrationEvent = (typeof INTEGRATION_EVENTS)[number];

export const isIntegrationEvent = (e: string): e is IntegrationEvent => (INTEGRATION_EVENTS as readonly string[]).includes(e);

/** Hodnoty v těle události jsou jen jednoduché, aby je šlo dosadit do textu a do MQTT bez překvapení. */
export type EventData = Record<string, string | number | boolean | null>;

export interface IntegrationPayload {
  /** Verze tvaru těla. */
  version: 1;
  event: IntegrationEvent;
  at: number;
  data: EventData;
}

/** Události, které se ve výchozím nastavení neposílají (hodně častá nebo soukromější). */
export const NOISY_EVENTS: readonly IntegrationEvent[] = ['chat.message', 'player.allIn'];

/** Seznam událostí z textu oddělených čárkou; neznámé se zahodí. */
export function parseEventList(text: string | undefined | null): IntegrationEvent[] {
  const out = new Set<IntegrationEvent>();
  for (const part of String(text ?? '').split(/[\s,;]+/)) if (isIntegrationEvent(part)) out.add(part);
  return [...out];
}

export const DEFAULT_EVENT_LIST = INTEGRATION_EVENTS.filter((e) => !NOISY_EVENTS.includes(e)).join(',');

/** Discord kanály: pevné sloty 1 až 4, každý s vlastním webhookem (tajný údaj), názvem, vypínačem a událostmi. */
export const DISCORD_SLOTS = [1, 2, 3, 4] as const;
export type DiscordSlot = (typeof DISCORD_SLOTS)[number];

export interface DiscordSlotKeys {
  slot: DiscordSlot;
  /** Cíl v logu doručení (slot 1 zůstává „discord“ kvůli zpětné kompatibilitě). */
  target: string;
  secret: string;
  enabled: string;
  name: string;
  events: string;
}

export const discordSlotKeys = (slot: DiscordSlot): DiscordSlotKeys =>
  slot === 1
    ? { slot, target: 'discord', secret: 'discord.webhookUrl', enabled: 'integrations.discordEnabled', name: 'integrations.discordName', events: 'integrations.discordEvents' }
    : { slot, target: `discord${slot}`, secret: `discord.webhookUrl${slot}`, enabled: `integrations.discord${slot}Enabled`, name: `integrations.discord${slot}Name`, events: `integrations.discord${slot}Events` };

/** Slot podle cíle doručení (`discord`, `discord2`…), jinak undefined. */
export const discordSlotOfTarget = (target: string): DiscordSlot | undefined => DISCORD_SLOTS.find((s) => discordSlotKeys(s).target === target);
