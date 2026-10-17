/**
 * Hotové volby pro editor vzhledu (písma, stíny, zaoblení) a pomocné převody CSS hodnot.
 * Jsou tady, ne v komponentách, protože komponenty nesmí obsahovat pevné CSS hodnoty.
 */

export interface FontStack {
  id: string;
  /** Klíč překladu názvu. */
  label: string;
  value: string;
}

export const FONT_STACKS: FontStack[] = [
  { id: 'system', label: 'editor.font.system', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', label: 'editor.font.serif', value: 'Georgia, "Times New Roman", Times, serif' },
  { id: 'mono', label: 'editor.font.mono', value: 'ui-monospace, "Cascadia Mono", Menlo, monospace' },
  { id: 'rounded', label: 'editor.font.rounded', value: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Nunito, system-ui, sans-serif' },
  { id: 'condensed', label: 'editor.font.condensed', value: '"Arial Narrow", "Roboto Condensed", system-ui, sans-serif' },
  { id: 'inter', label: 'editor.font.inter', value: 'Inter, system-ui, sans-serif' },
  { id: 'merriweather', label: 'editor.font.merriweather', value: 'Merriweather, Georgia, serif' },
  { id: 'robotoMono', label: 'editor.font.robotoMono', value: '"Roboto Mono", ui-monospace, monospace' },
];

export const SHADOW_PRESETS: { label: string; value: string }[] = [
  { label: 'editor.shadow.none', value: 'none' },
  { label: 'editor.shadow.soft', value: '0 1px 3px #00000040' },
  { label: 'editor.shadow.medium', value: '0 4px 12px #00000055' },
  { label: 'editor.shadow.strong', value: '0 8px 24px #00000080' },
];

export const RADIUS_SQUARE = '0px';
export const RADIUS_ROUND = '9999px';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const isHexColor = (v: string): boolean => HEX_RE.test(v);

/** Číslo z hodnoty ve pixelech (`12px` → 12), jinak null. */
export function parsePx(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  return m ? Number(m[1]) : null;
}

export const toPx = (n: number | string): string => `${n}px`;
