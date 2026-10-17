/**
 * Katalog oprávnění a základní typy. Oprávnění je nejmenší jednotka přístupu; každé má český název
 * a popis v překladech (`perm.<klíč>.name`, `perm.<klíč>.desc`) a kategorii. Nová funkce si
 * oprávnění přidává sem (nebo přes `registerPermission` z modulu).
 */
export interface PermissionDef {
  key: string;
  /** Kategorie (záložka v editoru rolí). */
  category: string;
  /** Lze udělit jen pro konkrétní sérii, turnaj, stůl nebo kanál. */
  scopable?: boolean;
  /** Podporované limity (např. maxPerOperation, maxPerDay). */
  limits?: readonly LimitKey[];
  /** Smí se nastavit „vyžaduje schválení druhou osobou“. */
  approvalCapable?: boolean;
  /** Citlivá akce (volitelně se u ní vyžaduje znovuzadání hesla). */
  sensitive?: boolean;
}

export type LimitKey = 'maxPerOperation' | 'maxPerDay' | 'maxConcurrent' | 'maxBuyIn' | 'maxDurationHours';

const p = (key: string, category: string, extra: Partial<PermissionDef> = {}): PermissionDef => ({ key, category, ...extra });

export const PERMISSIONS: PermissionDef[] = [
  // stůl a hraní
  p('stul.zobrazit', 'stul', { scopable: true }),
  p('stul.hrat', 'stul', { scopable: true }),
  p('stul.chat', 'stul', { scopable: true }),
  p('prihlizet.zobrazit', 'prihlizeni', { scopable: true }),
  p('prihlizet.videt_karty_se_zpozdenim', 'prihlizeni', { scopable: true }),
  // uživatelé a pozvánky
  p('uzivatel.zobrazit', 'uzivatele'),
  p('uzivatel.pozvat', 'uzivatele', { limits: ['maxPerDay'] }),
  p('uzivatel.upravit', 'uzivatele', { sensitive: true }),
  p('uzivatel.blokovat', 'uzivatele', { sensitive: true }),
  p('uzivatel.smazat', 'uzivatele', { sensitive: true, approvalCapable: true }),
  p('uzivatel.overit_email', 'uzivatele'),
  p('uzivatel.vynutit_zmenu_hesla', 'uzivatele', { sensitive: true }),
  p('uzivatel.zobrazit_jako', 'uzivatele', { sensitive: true }),
  // role
  p('role.zobrazit', 'role'),
  p('role.vytvorit', 'role', { sensitive: true, approvalCapable: true }),
  p('role.upravit', 'role', { sensitive: true, approvalCapable: true }),
  p('role.smazat', 'role', { sensitive: true, approvalCapable: true }),
  p('role.prirazovat', 'role', { scopable: true, sensitive: true, approvalCapable: true }),
  p('role.exportovat', 'role'),
  // měna a účetní kniha
  p('mena.zobrazit_knihu', 'mena'),
  p('mena.zobrazit_dum', 'mena'),
  p('mena.dobit', 'mena', { limits: ['maxPerOperation', 'maxPerDay'], approvalCapable: true, sensitive: true }),
  p('mena.strhnout', 'mena', { limits: ['maxPerOperation', 'maxPerDay'], approvalCapable: true, sensitive: true }),
  p('mena.upravit_knihu', 'mena', { approvalCapable: true, sensitive: true }),
  p('mena.vyridit_zadost', 'mena', { limits: ['maxPerOperation'] }),
  p('mena.vyuctovani', 'mena'),
  p('zadost.vytvorit', 'mena'),
  // cash hry
  p('cash.vytvorit_vlastni', 'cash', { limits: ['maxConcurrent', 'maxBuyIn'] }),
  p('cash.upravit_vlastni', 'cash'),
  p('cash.upravit_vse', 'cash'),
  p('cash.zrusit_vlastni', 'cash'),
  p('cash.zrusit_vse', 'cash'),
  // turnaje (podrobnosti ve fázi 3 a 5)
  p('turnaj.hrat', 'turnaje'),
  p('turnaj.vytvorit', 'turnaje', { limits: ['maxConcurrent', 'maxBuyIn'] }),
  p('turnaj.naplanovat', 'turnaje', { scopable: true }),
  p('turnaj.upravit_vlastni', 'turnaje', { scopable: true }),
  p('turnaj.upravit_vse', 'turnaje', { scopable: true }),
  p('turnaj.zrusit_vlastni', 'turnaje', { scopable: true }),
  p('turnaj.zrusit_vse', 'turnaje', { scopable: true }),
  // živá hra (skutečné karty u stolu)
  p('zivahra.rizeni', 'turnaje', { scopable: true }),
  // sázky a odměny na hlavu
  p('sazky.sazet', 'sazky'),
  p('sazky.zalozit', 'sazky'),
  p('sazky.hlava', 'sazky'),
  p('sazky.rozhodnout', 'sazky', { scopable: true }),
  // AI asistent a MCP
  p('asistent.pouzivat', 'asistent'),
  p('asistent.spravovat', 'asistent'),
  p('asistent.mcp', 'asistent'),
  // přístupové tokeny a REST API
  p('api.tokeny', 'api'),
  p('api.spravovat', 'api'),
  // napojení ven (Home Assistant, webhooky, Discord)
  p('integrace.spravovat', 'integrace'),
  // kosmetika a obchod
  p('obchod.nakupovat', 'obchod'),
  p('obchod.spravovat', 'obchod'),
  // zásahy do běžící hry
  p('zasah.pauza', 'zasahy', { scopable: true }),
  p('zasah.upravit_nastaveni', 'zasahy', { scopable: true }),
  p('zasah.vyradit_hrace', 'zasahy', { scopable: true }),
  p('zasah.opravit_stack', 'zasahy', { scopable: true, approvalCapable: true, sensitive: true }),
  p('zasah.rozhodnout_spor', 'zasahy', { scopable: true }),
  // chat
  p('chat.psat', 'chat', { scopable: true }),
  p('chat.mazat_zpravy', 'chat', { scopable: true }),
  p('chat.ztlumit', 'chat', { scopable: true, limits: ['maxDurationHours'] }),
  p('chat.pripinat', 'chat', { scopable: true }),
  p('chat.spravovat_kanaly', 'chat'),
  p('chat.vytvorit_kanal', 'chat'),
  // obsah
  p('emotikon.nahrat', 'obsah'),
  p('emotikon.schvalit', 'obsah'),
  p('emotikon.spravovat', 'obsah'),
  p('motiv.vytvorit', 'obsah'),
  p('motiv.schvalit', 'obsah'),
  p('motiv.zamknout_prvky', 'obsah'),
  // ankety
  p('anketa.vytvorit', 'anketa'),
  p('anketa.spravovat', 'anketa'),
  p('anketa.akce', 'anketa'),
  // statistiky
  p('statistiky.sezony', 'statistiky'),
  p('statistiky.exportovat', 'statistiky'),
  p('statistiky.uspechy', 'statistiky'),
  // nastavení a šablony
  p('nastaveni.hra.upravit', 'nastaveni'),
  p('nastaveni.sablony.sprava', 'nastaveni'),
  p('nastaveni.globalni', 'nastaveni', { sensitive: true }),
  // e-mail
  p('email.spravovat_smtp', 'email', { sensitive: true }),
  p('email.sablony', 'email'),
  p('email.fronta', 'email'),
  // systém
  p('system.tajne_udaje', 'system', { sensitive: true }),
  p('system.kryptovani_klic', 'system', { sensitive: true }),
  p('system.zalohy', 'system', { sensitive: true }),
  p('audit.zobrazit', 'system'),
  p('tv.spravovat', 'system'),
  p('hlasatel.spravovat', 'system'),
  p('vecer.spravovat', 'turnaje', { scopable: true }),
  // schvalování (princip čtyř očí)
  p('schvalovani.rozhodovat', 'schvalovani', { sensitive: true }),
];

const byKey = new Map<string, PermissionDef>(PERMISSIONS.map((d) => [d.key, d]));

/** Nová funkce si registruje vlastní oprávnění; duplicitní klíč je chyba. */
export function registerPermission(def: PermissionDef): void {
  if (byKey.has(def.key)) throw new Error(`Duplicitní oprávnění: ${def.key}`);
  PERMISSIONS.push(def);
  byKey.set(def.key, def);
}
export const permissionDef = (key: string): PermissionDef | undefined => byKey.get(key);
export const permissionKeys = (): string[] => PERMISSIONS.map((d) => d.key);
export const permissionCategories = (): string[] => [...new Set(PERMISSIONS.map((d) => d.category))];

export type ScopeKind = 'global' | 'series' | 'tournament' | 'table' | 'channel';

export interface PermissionContext {
  scopeType?: ScopeKind;
  scopeId?: string;
  /** Částka (u oprávnění s limity). */
  amount?: number;
  /** Akce se týká vlastního zdroje (např. vlastní turnaj). */
  own?: boolean;
}

export interface Decision {
  allowed: boolean;
  /** Překladový klíč důvodu zamítnutí. */
  reasonKey?: string;
  /** Akci musí schválit druhá osoba. */
  needsApproval?: boolean;
  /** Platné limity, pokud nějaké jsou. */
  limits?: Partial<Record<LimitKey, number>>;
}

export interface Actor {
  userId: string;
}

/** Rozhraní, které implementuje serverová služba oprávnění. Brána a služby se ptají jen přes ně. */
export interface PermissionChecker {
  can(userId: string | null, permission: string, ctx?: PermissionContext): Decision;
}
