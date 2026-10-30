import { PERMISSIONS, type LimitKey } from './permissions.js';

export interface PresetPermission {
  key: string;
  limits?: Partial<Record<LimitKey, number>>;
  needsApproval?: boolean;
}

export interface PresetRole {
  key: string;
  power: number;
  color: string;
  icon: string;
  /** Hlavní administrátor: vždy všechna oprávnění, nejde upravit ani smazat. */
  locked?: boolean;
  permissions: PresetPermission[];
}

const all = (prefixes: string[], except: string[] = []): PresetPermission[] =>
  PERMISSIONS.filter((d) => prefixes.some((x) => d.key.startsWith(x)) && !except.includes(d.key)).map((d) => ({ key: d.key }));
const keys = (...ks: string[]): PresetPermission[] => ks.map((key) => ({ key }));

const PLAYER: PresetPermission[] = keys('stul.zobrazit', 'stul.hrat', 'stul.chat', 'prihlizet.zobrazit', 'chat.psat', 'zadost.vytvorit', 'cash.vytvorit_vlastni', 'cash.upravit_vlastni', 'cash.zrusit_vlastni', 'turnaj.hrat', 'sazky.sazet', 'sazky.zalozit', 'sazky.hlava', 'obchod.nakupovat', 'api.tokeny', 'asistent.pouzivat');

/**
 * Předpřipravené role. Jsou to jen výchozí hodnoty při prvním startu: v GUI jdou upravit,
 * duplikovat, smazat (kromě hlavního administrátora) a doplnit o vlastní.
 */
export const PRESET_ROLES: PresetRole[] = [
  { key: 'main_admin', power: 100, color: 'danger', icon: 'crown', locked: true, permissions: PERMISSIONS.map((d) => ({ key: d.key })) },
  {
    key: 'admin',
    power: 80,
    color: 'accent',
    icon: 'shield',
    permissions: [
      ...all(['uzivatel.', 'role.', 'nastaveni.', 'statistiky.', 'chat.', 'cash.', 'turnaj.', 'zasah.', 'prihlizet.', 'stul.', 'emotikon.', 'motiv.', 'audit.', 'zadost.', 'anketa.', 'sazky.', 'obchod.', 'integrace.', 'api.', 'asistent.', 'historie.'], ['role.smazat']),
      ...keys('email.sablony', 'email.fronta', 'zpravy.odeslat', 'mena.zobrazit_knihu', 'mena.zobrazit_dum', 'mena.vyuctovani', 'schvalovani.rozhodovat'),
    ],
  },
  {
    key: 'pokladnik',
    power: 60,
    color: 'secondary',
    icon: 'coins',
    permissions: [
      ...PLAYER,
      { key: 'mena.dobit', limits: { maxPerOperation: 10000, maxPerDay: 50000 } },
      { key: 'mena.strhnout', limits: { maxPerOperation: 10000, maxPerDay: 50000 } },
      { key: 'mena.vyridit_zadost', limits: { maxPerOperation: 10000 } },
      ...keys('mena.zobrazit_knihu', 'mena.zobrazit_dum', 'mena.vyuctovani', 'schvalovani.rozhodovat'),
      { key: 'mena.upravit_knihu', needsApproval: true },
    ],
  },
  {
    key: 'reditel',
    power: 55,
    color: 'info',
    icon: 'clipboard',
    permissions: [...PLAYER, ...keys('zasah.pauza', 'zasah.upravit_nastaveni', 'zasah.vyradit_hrace', 'zasah.rozhodnout_spor', 'prihlizet.videt_karty_se_zpozdenim', 'turnaj.upravit_vlastni', 'sazky.rozhodnout'), { key: 'zasah.opravit_stack', needsApproval: true }],
  },
  {
    key: 'organizator',
    power: 50,
    color: 'success',
    icon: 'calendar',
    permissions: [
      ...PLAYER,
      { key: 'cash.vytvorit_vlastni', limits: { maxConcurrent: 5, maxBuyIn: 10000 } },
      { key: 'turnaj.vytvorit', limits: { maxConcurrent: 3, maxBuyIn: 5000 } },
      ...keys('turnaj.naplanovat', 'turnaj.upravit_vlastni', 'turnaj.zrusit_vlastni', 'zivahra.rizeni', 'vecer.spravovat', 'nastaveni.sablony.sprava', 'nastaveni.hra.upravit'),
    ],
  },
  {
    key: 'moderator',
    power: 40,
    color: 'warning',
    icon: 'message-circle',
    permissions: [...PLAYER, { key: 'chat.ztlumit', limits: { maxDurationHours: 24 } }, ...keys('chat.mazat_zpravy', 'chat.pripinat', 'chat.spravovat_kanaly', 'chat.vytvorit_kanal', 'anketa.vytvorit', 'anketa.spravovat')],
  },
  { key: 'kurator', power: 35, color: 'info', icon: 'palette', permissions: [...PLAYER, ...keys('emotikon.schvalit', 'emotikon.spravovat', 'motiv.schvalit', 'motiv.zamknout_prvky', 'motiv.vytvorit', 'emotikon.nahrat', 'obchod.spravovat')] },
  { key: 'statistik', power: 30, color: 'success', icon: 'bar-chart', permissions: [...PLAYER, ...keys('statistiky.sezony', 'statistiky.exportovat', 'statistiky.uspechy')] },
  { key: 'hrac', power: 10, color: 'primary', icon: 'user', permissions: [...PLAYER, ...keys('emotikon.nahrat', 'motiv.vytvorit', 'chat.vytvorit_kanal', 'anketa.vytvorit')] },
  { key: 'novacek', power: 5, color: 'muted', icon: 'user-plus', permissions: keys('stul.zobrazit', 'prihlizet.zobrazit', 'chat.psat', 'zadost.vytvorit') },
  { key: 'host', power: 1, color: 'muted', icon: 'eye', permissions: keys('stul.zobrazit', 'prihlizet.zobrazit') },
  { key: 'zablokovany', power: 0, color: 'danger', icon: 'ban', permissions: [] },
];

export const DEFAULT_ROLE_KEY = 'hrac';
export const NEWBIE_ROLE_KEY = 'novacek';
export const MAIN_ADMIN_ROLE_KEY = 'main_admin';
