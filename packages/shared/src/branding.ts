/**
 * Vzhled přihlašovací a registrační stránky: velikost a umístění loga, pozadí, poloha a šířka karty a krátký uvítací text.
 * Čisté funkce sdílené serverem (veřejný endpoint) i klientem (živý náhled ve správě).
 */

export const LOGIN_PLACEMENTS = ['above', 'inside', 'side', 'none'] as const;
export const LOGIN_BACKGROUNDS = ['felt', 'plain', 'gradient', 'suits', 'image'] as const;
export const LOGIN_TONES = ['primary', 'secondary', 'accent', 'info'] as const;
export const LOGIN_POSITIONS = ['center', 'left', 'right'] as const;
export const LOGIN_WIDTHS = ['narrow', 'normal', 'wide'] as const;
export const LOGIN_PLATES = ['card', 'none'] as const;

export interface LoginLayout {
  logoSizePercent: number;
  logoPlacement: (typeof LOGIN_PLACEMENTS)[number];
  showName: boolean;
  logoPlate: (typeof LOGIN_PLATES)[number];
  background: (typeof LOGIN_BACKGROUNDS)[number];
  bgTone: (typeof LOGIN_TONES)[number];
  /** Ztmavení obrázku pozadí (0 až 90 %), aby byl formulář čitelný. */
  bgOverlayPercent: number;
  /** Rozostření obrázku pozadí (0 až 20, desetiny rem). */
  bgBlur: number;
  cardPosition: (typeof LOGIN_POSITIONS)[number];
  cardWidth: (typeof LOGIN_WIDTHS)[number];
  tagline: string;
}

export const LOGIN_DEFAULTS: LoginLayout = {
  logoSizePercent: 100,
  logoPlacement: 'above',
  showName: true,
  logoPlate: 'card',
  background: 'felt',
  bgTone: 'primary',
  bgOverlayPercent: 30,
  bgBlur: 0,
  cardPosition: 'center',
  cardWidth: 'normal',
  tagline: '',
};

const pick = <T extends string>(list: readonly T[], v: unknown, def: T): T => (list.includes(v as T) ? (v as T) : def);
const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** Složí vzhled přihlašovací stránky z hodnot nastavení; neplatné hodnoty nahradí výchozími. `login.*` je nové, `branding.loginBackground` zůstává kvůli zpětné kompatibilitě. */
export function loginLayoutOf(values: Record<string, unknown>): LoginLayout {
  const d = LOGIN_DEFAULTS;
  return {
    logoSizePercent: num(values['login.logoSizePercent'], d.logoSizePercent, 40, 400),
    logoPlacement: pick(LOGIN_PLACEMENTS, values['login.logoPlacement'], d.logoPlacement),
    showName: values['login.showName'] !== false,
    logoPlate: pick(LOGIN_PLATES, values['login.logoPlate'], d.logoPlate),
    background: pick(LOGIN_BACKGROUNDS, values['branding.loginBackground'], d.background),
    bgTone: pick(LOGIN_TONES, values['login.bgTone'], d.bgTone),
    bgOverlayPercent: num(values['login.bgOverlayPercent'], d.bgOverlayPercent, 0, 90),
    bgBlur: num(values['login.bgBlur'], d.bgBlur, 0, 20),
    cardPosition: pick(LOGIN_POSITIONS, values['login.cardPosition'], d.cardPosition),
    cardWidth: pick(LOGIN_WIDTHS, values['login.cardWidth'], d.cardWidth),
    tagline: String(values['login.tagline'] ?? '').trim().slice(0, 120),
  };
}
