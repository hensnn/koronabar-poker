import type { SettingsRegistry } from './registry.js';
import { scopeAllowed } from './resolve.js';

/**
 * Sady osobního nastavení: skupiny parametrů, které se dají samostatně obnovit na výchozí, sdílet s ostatními a převzít od nich.
 * Sady stolu jsou dvě, zvlášť pro počítač a pro telefon (každý druh zařízení má u hráče vlastní vrstvu hodnot); ostatní platí pro všechna zařízení.
 */
export const SETTING_SETS = [
  { id: 'tableDesktop', kind: 'desktop' },
  { id: 'tablePhone', kind: 'phone' },
  { id: 'sounds', kind: null },
  { id: 'look', kind: null },
  { id: 'notify', kind: null },
] as const;

export type SettingSetId = (typeof SETTING_SETS)[number]['id'];
export type DeviceKind = 'phone' | 'desktop';

const TABLE = /^(ui\.(table|size|betChips|compactHeader|show|rotateToMe|hideMyCards|winImpact|chipLeaderCrown|quickBets|dealAnimation|eventAnimations|dealCardMs|warnSeconds|noteWindow|hotkey|plan|runItResponse|autoJoin|autoRebuy|autoReenter|autoAddon|timeoutNotice|tournamentWait|mobile)|chat\.show)/;
const MOBILE = /^ui\.mobile/;
const SOUNDS = /^(ui\.(sfx|sound|vibrate)|sounds\.|announcer\.)/;
const LOOK = /^ui\.(colorMode|density|themeId|fontScalePercent|reducedMotion|foldState)$/;
const NOTIFY = /^(email\.notify|push\.|chat\.digest)/;

export function setById(id: string): (typeof SETTING_SETS)[number] | undefined {
  return SETTING_SETS.find((s) => s.id === id);
}

/** Klíče osobních parametrů, které do sady patří. */
export function keysOfSet(reg: SettingsRegistry, id: string): string[] {
  const match = (key: string): boolean => {
    switch (id) {
      case 'tableDesktop':
        return TABLE.test(key) && !MOBILE.test(key);
      case 'tablePhone':
        return TABLE.test(key);
      case 'sounds':
        return SOUNDS.test(key);
      case 'look':
        return LOOK.test(key);
      case 'notify':
        return NOTIFY.test(key);
      default:
        return false;
    }
  };
  return reg.all().filter((d) => !d.secret && scopeAllowed(d.scopes, 'user') && match(d.key)).map((d) => d.key);
}

/** Parametry, které se na daném druhu zařízení nikdy neprojeví (panely a zkratky u stolu telefon nemá; mobilní rozložení čte vždy profil telefonu). */
const PHONE_UNUSED = /^ui\.(tablePanel|tableSide|tableChatHeight|tableLayout|tableArea|tableFitWindow|tableHeightPercent|hotkey|sizePerDisplay|sizeProfiles)/;
const DESKTOP_UNUSED = /^ui\.mobile/;
/** Starší zaškrtávátka pásu pod stolem; dnes jen výchozí rozmístění (viz `ui.mobileOrder`), proto se nenabízejí. */
const LEGACY = /^ui\.mobile(Best|Events|TimerBar|Sounds|AllIcons)$/;

/** Má parametr smysl nastavovat pro daný druh zařízení? */
export function usefulOnKind(kind: DeviceKind, key: string): boolean {
  return !LEGACY.test(key) && !(kind === 'phone' ? PHONE_UNUSED : DESKTOP_UNUSED).test(key);
}

/** Starší volba, která už nemá vlastní ovládání. */
export const isLegacyMobileKey = (key: string): boolean => LEGACY.test(key);
