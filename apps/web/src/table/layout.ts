/**
 * Rozložení widgetů u stolu: dva panely (levý a pravý) sdílejí jednu sadu widgetů. Každý widget může být
 * v kterémkoli panelu, může být skrytý nebo sbalený. Rozložení je osobní nastavení `ui.tableLayout`.
 */

export const LEFT_DEFAULT = ['table', 'plan', 'hand', 'best', 'actions', 'players', 'chat', 'sounds'] as const;
export const RIGHT_DEFAULT = ['info', 'bounties', 'deal', 'tools', 'reveal'] as const;
export const WIDGET_IDS = [...LEFT_DEFAULT, ...RIGHT_DEFAULT] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export type Side = 'left' | 'right';

export interface Layout {
  left: WidgetId[];
  right: WidgetId[];
  hidden: WidgetId[];
  collapsed: WidgetId[];
}

const known = (v: unknown): v is WidgetId => (WIDGET_IDS as readonly string[]).includes(String(v));
const ids = (x: unknown): WidgetId[] => (Array.isArray(x) ? x.filter(known) : []);
const asObject = (raw: unknown): Record<string, unknown> => {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const defaultLayout = (): Layout => ({ left: [...LEFT_DEFAULT], right: [...RIGHT_DEFAULT], hidden: [], collapsed: [] });

/** Widget, který v uloženém rozložení chybí (přidala ho novější verze), se zařadí do svého výchozího panelu za předchozí widget. */
function addMissing(layout: Layout): Layout {
  const left = [...layout.left];
  const right = [...layout.right];
  for (const [side, def, list] of [['left', LEFT_DEFAULT, left], ['right', RIGHT_DEFAULT, right]] as const) {
    void side;
    for (const [i, w] of def.entries()) {
      if (left.includes(w) || right.includes(w)) continue;
      const prev = [...def.slice(0, i)].reverse().find((x) => list.includes(x));
      list.splice(prev ? list.indexOf(prev) + 1 : i === 0 ? 0 : list.length, 0, w);
    }
  }
  return { ...layout, left, right };
}

const dedupe = (list: WidgetId[], seen: Set<WidgetId>): WidgetId[] => list.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

/**
 * Načte rozložení. Když ještě není uložené nové (`ui.tableLayout`), převezme se z dřívějších dvou nastavení
 * levého (`ui.tablePanel`) a pravého (`ui.tableSide`) panelu, aby se nikomu nezměnilo, co si už nastavil.
 */
export function parseLayout(raw: unknown, legacyLeft?: unknown, legacyRight?: unknown): Layout {
  const cur = asObject(raw);
  if (Array.isArray(cur.left) || Array.isArray(cur.right)) {
    const seen = new Set<WidgetId>();
    const left = dedupe(ids(cur.left), seen);
    const right = dedupe(ids(cur.right), seen);
    return addMissing({ left, right, hidden: ids(cur.hidden), collapsed: ids(cur.collapsed) });
  }
  const l = asObject(legacyLeft);
  const r = asObject(legacyRight);
  const seen = new Set<WidgetId>();
  const left = dedupe(ids(l.order).filter((id) => (LEFT_DEFAULT as readonly string[]).includes(id)), seen);
  const right = dedupe(ids(r.order).filter((id) => (RIGHT_DEFAULT as readonly string[]).includes(id)), seen);
  return addMissing({ left, right, hidden: [...new Set([...ids(l.hidden), ...ids(r.hidden)])], collapsed: [...new Set([...ids(l.collapsed), ...ids(r.collapsed)])] });
}

export const sideOf = (layout: Layout, id: WidgetId): Side => (layout.right.includes(id) ? 'right' : 'left');

/** Přesune widget do panelu (na konec, nebo na zadané místo). */
export function moveToSide(layout: Layout, id: WidgetId, side: Side, index?: number): Layout {
  const left = layout.left.filter((x) => x !== id);
  const right = layout.right.filter((x) => x !== id);
  const target = side === 'left' ? left : right;
  target.splice(index === undefined ? target.length : Math.max(0, Math.min(index, target.length)), 0, id);
  return { ...layout, left, right };
}

/** Posun o jedno místo nahoru/dolů v rámci panelu, přeskakuje widgety, které se teď nezobrazují (`skip`). */
export function reorder(layout: Layout, id: WidgetId, dir: -1 | 1, skip: (id: WidgetId) => boolean = () => false): Layout {
  const side = sideOf(layout, id);
  const list = [...layout[side]];
  const i = list.indexOf(id);
  let j = i + dir;
  while (j >= 0 && j < list.length && skip(list[j]!)) j += dir;
  if (i < 0 || j < 0 || j >= list.length) return layout;
  [list[i], list[j]] = [list[j]!, list[i]!];
  return { ...layout, [side]: list };
}

export const toggleHidden = (layout: Layout, id: WidgetId): Layout => ({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] });
export const toggleCollapsed = (layout: Layout, id: WidgetId): Layout => ({ ...layout, collapsed: layout.collapsed.includes(id) ? layout.collapsed.filter((x) => x !== id) : [...layout.collapsed, id] });

/** Na telefonu musí být akce hry vždy po ruce vedle stolu, i kdyby je hráč přesunul do levého panelu (ten je tam schovaný v zásuvce). */
export function forMobile(layout: Layout): Layout {
  let l = layout.left.includes('tools') ? moveToSide(layout, 'tools', 'right', 0) : layout;
  // Ukázání karet má omezený čas, proto je hned pod akcemi.
  if (l.left.includes('reveal')) l = moveToSide(l, 'reveal', 'right', 1);
  return l;
}
