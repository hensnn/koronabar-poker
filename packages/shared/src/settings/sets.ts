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

const TABLE = /^(ui\.(table|size|betChips|compactHeader|show|rotateToMe|hideMyCards|quickBets|dealAnimation|eventAnimations|dealCardMs|warnSeconds|noteWindow|hotkey|plan|runItResponse|autoJoin|timeoutNotice|tournamentWait|mobile)|chat\.show)/;
const MOBILE = /^ui\.mobile/;
const SOUNDS = /^(ui\.(sfx|sound|vibrate)|sounds\.|announcer\.)/;
const LOOK = /^ui\.(colorMode|density|themeId|fontScalePercent|reducedMotion)$/;
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
