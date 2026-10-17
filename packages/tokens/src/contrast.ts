/** Relativní jasnost podle WCAG 2.x. Přijímá #RGB, #RRGGBB, #RRGGBBAA (alfa se ignoruje). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`Neplatná barva: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Dvojice token popředí / pozadí a minimální poměr kontrastu (AA: 4.5 pro text). */
export const CONTRAST_PAIRS: { fg: string; bg: string; min: number }[] = [
  { fg: 'color.text', bg: 'color.bg', min: 4.5 },
  { fg: 'color.text', bg: 'color.surface', min: 4.5 },
  { fg: 'color.textMuted', bg: 'color.surface', min: 4.5 },
  { fg: 'color.onPrimary', bg: 'color.primary', min: 4.5 },
  { fg: 'color.onAction', bg: 'color.actionFold', min: 4.5 },
  { fg: 'color.onAction', bg: 'color.actionCheck', min: 4.5 },
  { fg: 'color.onAction', bg: 'color.actionCall', min: 4.5 },
  { fg: 'color.onAction', bg: 'color.actionRaise', min: 4.5 },
  { fg: 'color.cardInk', bg: 'color.cardFace', min: 4.5 },
  { fg: 'color.suitRed', bg: 'color.cardFace', min: 4.5 },
  { fg: 'color.suitHeart', bg: 'color.cardFace', min: 4.5 },
  { fg: 'color.suitDiamond', bg: 'color.cardFace', min: 4.5 },
  { fg: 'color.suitClub', bg: 'color.cardFace', min: 4.5 },
  { fg: 'color.suitSpade', bg: 'color.cardFace', min: 4.5 },
];

export interface ContrastIssue {
  fg: string;
  bg: string;
  ratio: number;
  min: number;
}

export function checkContrast(tokens: Record<string, string>): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const p of CONTRAST_PAIRS) {
    const fg = tokens[p.fg];
    const bg = tokens[p.bg];
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < p.min) issues.push({ fg: p.fg, bg: p.bg, ratio, min: p.min });
  }
  return issues;
}
