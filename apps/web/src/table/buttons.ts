/** Barvy tlačítek akcí u stolu podle významu (jen tokeny motivu): odchod červeně, dokoupení zeleně, sit out žlutě, ukázání karet modře… */
const base = 'rounded-md px-3 py-1 border text-text';
export const actionTone = {
  /** Zdržení nebo pauza (sit out). */
  pause: `${base} border-warning bg-warning/15`,
  /** Přidání žetonů, návrat do hry (dokoupit, rebuy, vrátit se). */
  add: `${base} border-success bg-success/15`,
  /** Odchod od stolu. */
  leave: `${base} border-danger bg-danger/15`,
  /** Ukázání karet. */
  show: `${base} border-info bg-info/15`,
  /** Speciální pravidla (straddle, rabbit hunt, hodiny). */
  special: `${base} border-accent bg-accent/15`,
} as const;
/** Tlačítko, které teď nejde použít: stále na svém místě, ale šedé. */
export const actionOff = 'rounded-md px-3 py-1 border border-line bg-surface text-muted opacity-70';
export const actionOffSm = 'rounded-md px-2 py-0.5 text-sm border border-line bg-surface text-muted opacity-70';
export type ActionTone = keyof typeof actionTone;

/** Totéž menší (tlačítka ve widgetech panelů). */
const small = 'rounded-md px-2 py-0.5 text-sm border text-text';
export const actionToneSm: Record<ActionTone, string> = {
  pause: `${small} border-warning bg-warning/15`,
  add: `${small} border-success bg-success/15`,
  leave: `${small} border-danger bg-danger/15`,
  show: `${small} border-info bg-info/15`,
  special: `${small} border-accent bg-accent/15`,
};
