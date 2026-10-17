import { and, eq, inArray } from 'drizzle-orm';
import { accounts, LedgerError, type Ledger } from '@kb/ledger';
import {
  BUILTIN_COSMETICS,
  parseRanks,
  t,
  validateCosmetic,
  type CosmeticAcquire,
  type CosmeticInput,
  type CosmeticKind,
  type CosmeticLook,
  type PermissionChecker,
  type PublicLook,
  type SettingValues,
} from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type CosmeticErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'DISABLED' | 'OWNED' | 'NOT_OWNED' | 'NOT_FOR_SALE' | 'NOT_AVAILABLE' | 'INSUFFICIENT_FUNDS' | 'LIMIT';

export class CosmeticError extends Error {
  constructor(
    public code: CosmeticErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  ledger: Ledger;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  levelOf: (userId: string) => Promise<number>;
  /** Pořadí hráčů v uzavřených sezónách (nejlepší první). */
  seasonPlacements: () => Promise<{ seasonId: string; order: string[] }[]>;
  onWallet?: (userId: string) => void;
  onGranted?: (userId: string, item: { key: string; name: string; kind: string }, source: string) => void;
  onLookChanged?: (userId: string) => void;
}

type Item = typeof schema.cosmeticItems.$inferSelect;
type Meta = { ip?: string | null };

class Serial {
  private q: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.q.then(fn, fn);
    this.q = next.catch(() => undefined);
    return next;
  }
}

export interface CosmeticDto {
  key: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  look: CosmeticLook;
  acquire: CosmeticAcquire;
  /** Cena po slevě (prázdná = nelze koupit). */
  price: number | null;
  basePrice: number | null;
  buyable: boolean;
  availableUntil: number | null;
  enabled: boolean;
  builtin: boolean;
  owned: boolean;
  equipped: boolean;
  source: string | null;
}

/**
 * Kosmetické předměty a obchod. Předměty se získávají hrou (level, hodnost, úspěch, umístění v sezóně), nákupem
 * za virtuální měnu (peníze jdou domu) nebo je přidělí správce. Nic z toho neovlivní hru.
 */
export class CosmeticService {
  private serial = new Serial();

  constructor(private deps: Deps) {}

  idle(): Promise<void> {
    return this.serial.run(async () => undefined);
  }

  private s() {
    return this.deps.settings();
  }

  private enabled(): void {
    if (!this.s()['cosmetics.enabled']) throw new CosmeticError('DISABLED');
  }

  private manage(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'obchod.spravovat').allowed) throw new CosmeticError('FORBIDDEN');
  }

  /** Doplní vestavěné předměty, které v databázi ještě nejsou (upravené hodnoty kurátora zůstanou). */
  async init(): Promise<void> {
    const have = new Set((await this.deps.db.select({ k: schema.cosmeticItems.key }).from(schema.cosmeticItems)).map((r) => r.k));
    for (const b of BUILTIN_COSMETICS) {
      if (have.has(b.key)) continue;
      await this.deps.db
        .insert(schema.cosmeticItems)
        .values({ key: b.key, kind: b.kind, name: t(`cosmetic.item.${b.key}.name`), description: t(`cosmetic.item.${b.key}.desc`), look: b.look as Record<string, unknown>, acquire: b.acquire as Record<string, unknown>, price: b.price, builtin: true })
        .onConflictDoNothing();
    }
  }

  private price(base: number | null): number | null {
    if (base === null) return null;
    const off = Number(this.s()['cosmetics.discountPercent']);
    return Math.max(0, Math.floor((base * (100 - off)) / 100));
  }

  private inWindow(i: Item): boolean {
    const now = this.deps.now();
    return (!i.availableFrom || i.availableFrom.getTime() <= now) && (!i.availableUntil || i.availableUntil.getTime() > now);
  }

  // ---------- získávání hrou ----------

  /** Udělí hráči předměty, jejichž podmínka je splněná. Vrací klíče nově získaných. */
  async sync(userId: string): Promise<string[]> {
    if (!this.s()['cosmetics.enabled']) return [];
    return this.serial.run(() => this.syncNow(userId));
  }

  private async syncNow(userId: string, placements?: { seasonId: string; order: string[] }[]): Promise<string[]> {
    const db = this.deps.db;
    const items = (await db.select().from(schema.cosmeticItems).where(eq(schema.cosmeticItems.enabled, true))).filter((i) => this.inWindow(i));
    const rules = items.filter((i) => Object.keys(i.acquire).length > 0);
    if (rules.length === 0) return [];
    const owned = new Set((await db.select({ k: schema.playerCosmetics.itemKey }).from(schema.playerCosmetics).where(eq(schema.playerCosmetics.userId, userId))).map((r) => r.k));
    const todo = rules.filter((i) => !owned.has(i.key));
    if (todo.length === 0) return [];
    const level = await this.deps.levelOf(userId);
    const ranks = parseRanks(String(this.s()['xp.ranks'])).ranks;
    const achieved = new Set((await db.select({ k: schema.playerAchievements.key }).from(schema.playerAchievements).where(eq(schema.playerAchievements.userId, userId))).map((r) => r.k));
    const seasons = placements ?? (todo.some((i) => (i.acquire as CosmeticAcquire).season) ? await this.deps.seasonPlacements() : []);
    const got: string[] = [];
    for (const i of todo) {
      const a = i.acquire as CosmeticAcquire;
      let source: string | null = null;
      if (a.level !== undefined && level >= a.level) source = 'level';
      else if (a.rank !== undefined && ranks.find((r) => r.name === a.rank) && level >= ranks.find((r) => r.name === a.rank)!.minLevel) source = 'rank';
      else if (a.achievement !== undefined && achieved.has(a.achievement)) source = 'achievement';
      else if (a.season && seasons.some((s) => (!a.season!.seasonId || a.season!.seasonId === s.seasonId) && s.order.slice(0, a.season!.place).includes(userId))) source = 'season';
      if (!source) continue;
      const ins = await db.insert(schema.playerCosmetics).values({ userId, itemKey: i.key, source }).onConflictDoNothing().returning({ k: schema.playerCosmetics.itemKey });
      if (ins.length === 0) continue;
      got.push(i.key);
      this.deps.onGranted?.(userId, { key: i.key, name: i.name, kind: i.kind }, source);
    }
    return got;
  }

  /** Projde všechny hráče (konec sezóny, nové předměty v katalogu). */
  async syncAll(): Promise<number> {
    if (!this.s()['cosmetics.enabled']) return 0;
    return this.serial.run(async () => {
      const ids = await this.deps.db.select({ id: schema.users.id }).from(schema.users);
      const placements = await this.deps.seasonPlacements();
      let n = 0;
      for (const u of ids) n += (await this.syncNow(u.id, placements)).length;
      return n;
    });
  }

  // ---------- čtení ----------

  private dto(i: Item, mine: { source: string; equipped: boolean } | undefined): CosmeticDto {
    const base = i.price;
    const buyable = base !== null && !!this.s()['cosmetics.shopEnabled'] && i.enabled && this.inWindow(i);
    return {
      key: i.key,
      kind: i.kind as CosmeticKind,
      name: i.name,
      description: i.description,
      look: i.look as CosmeticLook,
      acquire: i.acquire as CosmeticAcquire,
      price: this.price(base),
      basePrice: base,
      buyable,
      availableUntil: i.availableUntil?.getTime() ?? null,
      enabled: i.enabled,
      builtin: i.builtin,
      owned: !!mine,
      equipped: mine?.equipped ?? false,
      source: mine?.source ?? null,
    };
  }

  /** Katalog z pohledu hráče: neprodejné a stažené předměty vidí jen, když je vlastní. Kurátor vidí vše. */
  async catalog(userId: string): Promise<{ items: CosmeticDto[]; canManage: boolean; maxTrophies: number; extraSlots: number }> {
    this.enabled();
    await this.sync(userId);
    const canManage = this.deps.perms.can(userId, 'obchod.spravovat').allowed;
    const items = await this.deps.db.select().from(schema.cosmeticItems);
    const mine = new Map((await this.deps.db.select().from(schema.playerCosmetics).where(eq(schema.playerCosmetics.userId, userId))).map((r) => [r.itemKey, r]));
    const out = items
      .filter((i) => canManage || mine.has(i.key) || (i.enabled && this.inWindow(i)))
      .map((i) => this.dto(i, mine.get(i.key)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.basePrice ?? 0) - (b.basePrice ?? 0) || a.name.localeCompare(b.name));
    return { items: out, canManage, maxTrophies: Number(this.s()['cosmetics.maxTrophies']), extraSlots: await this.extraSoundSlots(userId) };
  }

  /** Vzhled hráčů pro stůl, chat a profil (jen vybavené předměty). */
  async looks(userIds: string[]): Promise<PublicLook[]> {
    const ids = [...new Set(userIds)].slice(0, 100);
    if (ids.length === 0) return [];
    const on = !!this.s()['cosmetics.enabled'];
    const rows = on
      ? await this.deps.db
          .select({ userId: schema.playerCosmetics.userId, item: schema.cosmeticItems })
          .from(schema.playerCosmetics)
          .innerJoin(schema.cosmeticItems, eq(schema.cosmeticItems.key, schema.playerCosmetics.itemKey))
          .where(and(inArray(schema.playerCosmetics.userId, ids), eq(schema.playerCosmetics.equipped, true)))
      : [];
    return ids.map((userId) => {
      const mine = rows.filter((r) => r.userId === userId).map((r) => r.item);
      const one = (k: CosmeticKind) => mine.find((i) => i.kind === k);
      const look = (i: Item | undefined) => (i ? (i.look as CosmeticLook) : undefined);
      const fr = look(one('frame'));
      const fx = look(one('effect'));
      const title = one('title');
      return {
        userId,
        frame: fr ? { color: fr.color ?? 'primary', style: fr.style ?? 'solid' } : null,
        effect: fx ? { color: fx.color ?? 'primary', style: fx.style ?? 'glow' } : null,
        nameColor: look(one('nameColor'))?.color ?? null,
        title: title ? { name: title.name, color: look(title)?.color ?? 'muted' } : null,
        trophies: mine.filter((i) => i.kind === 'trophy').map((i) => ({ key: i.key, name: i.name, icon: look(i)?.icon ?? '🏆' })),
      };
    });
  }

  /** Rub karet a plsť, které hráč nosí (vidí je jen on sám). */
  async mineTable(userId: string): Promise<{ cardBack: { color: string; style: string } | null; felt: string | null }> {
    if (!this.s()['cosmetics.enabled']) return { cardBack: null, felt: null };
    const rows = await this.deps.db
      .select({ item: schema.cosmeticItems })
      .from(schema.playerCosmetics)
      .innerJoin(schema.cosmeticItems, eq(schema.cosmeticItems.key, schema.playerCosmetics.itemKey))
      .where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.playerCosmetics.equipped, true)));
    const back = rows.find((r) => r.item.kind === 'cardBack')?.item;
    const felt = rows.find((r) => r.item.kind === 'felt')?.item;
    const bl = back?.look as CosmeticLook | undefined;
    return { cardBack: bl ? { color: bl.color ?? 'primary', style: bl.style ?? 'solid' } : null, felt: (felt?.look as CosmeticLook | undefined)?.color ?? null };
  }

  /** Sloty pro zvuky navíc z vlastněných předmětů. */
  async extraSoundSlots(userId: string): Promise<number> {
    if (!this.s()['cosmetics.enabled']) return 0;
    const rows = await this.deps.db
      .select({ look: schema.cosmeticItems.look })
      .from(schema.playerCosmetics)
      .innerJoin(schema.cosmeticItems, eq(schema.cosmeticItems.key, schema.playerCosmetics.itemKey))
      .where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.cosmeticItems.kind, 'soundSlots')));
    return rows.reduce((n, r) => n + Number((r.look as CosmeticLook).extra ?? 0), 0);
  }

  // ---------- nákup a nošení ----------

  private async item(key: string): Promise<Item> {
    const [i] = await this.deps.db.select().from(schema.cosmeticItems).where(eq(schema.cosmeticItems.key, key));
    if (!i) throw new CosmeticError('NOT_FOUND');
    return i;
  }

  /** Koupí předmět: jedna transakce knihy peněženka → dům, idempotentní. */
  async buy(userId: string, key: string, meta: Meta = {}): Promise<void> {
    this.enabled();
    if (!this.s()['cosmetics.shopEnabled']) throw new CosmeticError('DISABLED');
    if (!this.deps.perms.can(userId, 'obchod.nakupovat').allowed) throw new CosmeticError('FORBIDDEN');
    await this.serial.run(async () => {
      const i = await this.item(key);
      if (!i.enabled || !this.inWindow(i)) throw new CosmeticError('NOT_AVAILABLE');
      if (i.price === null) throw new CosmeticError('NOT_FOR_SALE');
      const [have] = await this.deps.db.select().from(schema.playerCosmetics).where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.playerCosmetics.itemKey, key)));
      if (have) throw new CosmeticError('OWNED');
      const price = this.price(i.price)!;
      if (price > 0) {
        try {
          this.deps.ledger.post({ kind: 'shop_purchase', idempotencyKey: `shop:${userId}:${key}`, createdBy: userId, entries: [{ account: accounts.wallet(userId), amount: -price }, { account: accounts.house(), amount: price }], note: `nákup: ${i.name}` });
        } catch (e) {
          if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new CosmeticError('INSUFFICIENT_FUNDS', { price });
          throw e;
        }
      }
      await this.deps.db.insert(schema.playerCosmetics).values({ userId, itemKey: key, source: 'shop', paid: price });
      await this.deps.audit.log({ actorId: userId, action: 'obchod.koupit', targetType: 'cosmetic', targetId: key, after: { price }, ...meta });
      this.deps.onWallet?.(userId);
    });
  }

  /** Nasadí, nebo sundá předmět. Z každého druhu se nosí jeden, trofejí víc (do limitu). */
  async equip(userId: string, key: string, on: boolean): Promise<void> {
    this.enabled();
    await this.serial.run(async () => {
      const i = await this.item(key);
      if (i.kind === 'soundSlots') throw new CosmeticError('INVALID', { field: 'kind' });
      const db = this.deps.db;
      const [have] = await db.select().from(schema.playerCosmetics).where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.playerCosmetics.itemKey, key)));
      if (!have) throw new CosmeticError('NOT_OWNED');
      if (on) {
        const same = await db
          .select({ key: schema.playerCosmetics.itemKey })
          .from(schema.playerCosmetics)
          .innerJoin(schema.cosmeticItems, eq(schema.cosmeticItems.key, schema.playerCosmetics.itemKey))
          .where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.playerCosmetics.equipped, true), eq(schema.cosmeticItems.kind, i.kind)));
        if (i.kind === 'trophy') {
          const max = Number(this.s()['cosmetics.maxTrophies']);
          if (!have.equipped && same.length >= max) throw new CosmeticError('LIMIT', { max });
        } else if (same.length > 0) {
          await db.update(schema.playerCosmetics).set({ equipped: false }).where(and(eq(schema.playerCosmetics.userId, userId), inArray(schema.playerCosmetics.itemKey, same.map((x) => x.key))));
        }
      }
      await db.update(schema.playerCosmetics).set({ equipped: on }).where(and(eq(schema.playerCosmetics.userId, userId), eq(schema.playerCosmetics.itemKey, key)));
      this.deps.onLookChanged?.(userId);
    });
  }

  // ---------- správa katalogu (kurátor) ----------

  async create(actorId: string, input: CosmeticInput, meta: Meta = {}): Promise<string> {
    this.manage(actorId);
    const bad = validateCosmetic(input);
    if (bad) throw new CosmeticError('INVALID', { field: bad });
    const key = `custom_${crypto.randomUUID().slice(0, 8)}`;
    await this.deps.db.insert(schema.cosmeticItems).values({
      key,
      kind: input.kind,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      look: input.look as Record<string, unknown>,
      acquire: input.acquire as Record<string, unknown>,
      price: input.price,
      availableFrom: input.availableFrom != null ? new Date(input.availableFrom) : null,
      availableUntil: input.availableUntil != null ? new Date(input.availableUntil) : null,
      enabled: input.enabled ?? true,
    });
    await this.deps.audit.log({ actorId, action: 'obchod.vytvorit', targetType: 'cosmetic', targetId: key, after: { kind: input.kind, name: input.name, price: input.price }, ...meta });
    return key;
  }

  /** Změní předmět. Druh se měnit nesmí (hráči by ho nosili na špatném místě). */
  async update(actorId: string, key: string, input: Partial<CosmeticInput>, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const cur = await this.item(key);
    if (input.kind && input.kind !== cur.kind) throw new CosmeticError('INVALID', { field: 'kind' });
    const merged: CosmeticInput = {
      kind: cur.kind as CosmeticKind,
      name: input.name ?? cur.name,
      description: input.description ?? cur.description,
      look: input.look ?? (cur.look as CosmeticLook),
      acquire: input.acquire ?? (cur.acquire as CosmeticAcquire),
      price: input.price !== undefined ? input.price : cur.price,
      availableFrom: input.availableFrom !== undefined ? input.availableFrom : (cur.availableFrom?.getTime() ?? null),
      availableUntil: input.availableUntil !== undefined ? input.availableUntil : (cur.availableUntil?.getTime() ?? null),
      enabled: input.enabled ?? cur.enabled,
    };
    const bad = validateCosmetic(merged);
    if (bad) throw new CosmeticError('INVALID', { field: bad });
    await this.deps.db
      .update(schema.cosmeticItems)
      .set({
        name: merged.name.trim(),
        description: (merged.description ?? '').trim(),
        look: merged.look as Record<string, unknown>,
        acquire: merged.acquire as Record<string, unknown>,
        price: merged.price,
        availableFrom: merged.availableFrom != null ? new Date(merged.availableFrom) : null,
        availableUntil: merged.availableUntil != null ? new Date(merged.availableUntil) : null,
        enabled: merged.enabled ?? true,
      })
      .where(eq(schema.cosmeticItems.key, key));
    await this.deps.audit.log({ actorId, action: 'obchod.upravit', targetType: 'cosmetic', targetId: key, after: { price: merged.price, enabled: merged.enabled }, ...meta });
  }

  /** Smaže předmět, který nikdo nevlastní; jinak ho jen stáhne z prodeje (vlastníci ho nosí dál). */
  async remove(actorId: string, key: string, meta: Meta = {}): Promise<{ deleted: boolean }> {
    this.manage(actorId);
    const cur = await this.item(key);
    const owners = await this.deps.db.select({ u: schema.playerCosmetics.userId }).from(schema.playerCosmetics).where(eq(schema.playerCosmetics.itemKey, key));
    if (owners.length > 0 || cur.builtin) {
      await this.deps.db.update(schema.cosmeticItems).set({ enabled: false }).where(eq(schema.cosmeticItems.key, key));
      await this.deps.audit.log({ actorId, action: 'obchod.stahnout', targetType: 'cosmetic', targetId: key, ...meta });
      return { deleted: false };
    }
    await this.deps.db.delete(schema.cosmeticItems).where(eq(schema.cosmeticItems.key, key));
    await this.deps.audit.log({ actorId, action: 'obchod.smazat', targetType: 'cosmetic', targetId: key, ...meta });
    return { deleted: true };
  }

  /** Správce hráči předmět přidělí (dárek, odměna za akci). */
  async grant(actorId: string, userId: string, key: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const i = await this.item(key);
    const ins = await this.deps.db.insert(schema.playerCosmetics).values({ userId, itemKey: key, source: 'grant' }).onConflictDoNothing().returning({ k: schema.playerCosmetics.itemKey });
    if (ins.length === 0) throw new CosmeticError('OWNED');
    await this.deps.audit.log({ actorId, action: 'obchod.pridelit', targetType: 'cosmetic', targetId: key, after: { userId }, ...meta });
    this.deps.onGranted?.(userId, { key, name: i.name, kind: i.kind }, 'grant');
  }
}
