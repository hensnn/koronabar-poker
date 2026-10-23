import { useThemeToken } from '../theme/ThemeProvider';

const TIERS = [
  { value: 500, cls: 'bg-chip-black' },
  { value: 100, cls: 'bg-chip-blue' },
  { value: 25, cls: 'bg-chip-green' },
  { value: 5, cls: 'bg-chip-red' },
  { value: 1, cls: 'bg-chip-white' },
];

/** Rozloží částku na žetony (od nejvyšší hodnoty), nejvýš `max` žetonů. */
export function chipsFor(amount: number, max = 6): string[] {
  const out: string[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const t of TIERS) {
    while (left >= t.value && out.length < max) {
      out.push(t.cls);
      left -= t.value;
    }
  }
  return out;
}

/** Hromádka žetonů podle částky; barvy hodnot jsou v tokenech. */
export function ChipPile({ amount }: { amount: number }) {
  const chips = chipsFor(amount);
  if (chips.length === 0) return null;
  return (
    <span className="inline-flex -space-x-2" aria-hidden>
      {chips.map((c, i) => (
        <span key={i} className={`tk-chip ${c}`} />
      ))}
    </span>
  );
}

/** Částka podle tokenu `chips.display`: jen číslo, jen žetony, nebo obojí. */
export function Amount({ amount, text, className = '' }: { amount: number; text: string; className?: string }) {
  const mode = useThemeToken('chips.display');
  if (mode === 'chips')
    return (
      <span className={`inline-flex items-center ${className}`} title={text} aria-label={text}>
        <ChipPile amount={amount} />
      </span>
    );
  if (mode === 'both')
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        <ChipPile amount={amount} />
        <span className="font-mono">{text}</span>
      </span>
    );
  return <span className={`font-mono ${className}`}>{text}</span>;
}

/** Žetony podle hodnot v násobcích základní jednotky stolu (malý blind): bílý 1×, červený 5×, zelený 25×, modrý 100×, černý 500×. */
const STACK_TIERS = [
  { ratio: 500, cls: 'bg-chip-black' },
  { ratio: 100, cls: 'bg-chip-blue' },
  { ratio: 25, cls: 'bg-chip-green' },
  { ratio: 5, cls: 'bg-chip-red' },
  { ratio: 1, cls: 'bg-chip-white' },
];

/** Rozklad částky na sloupce žetonů (od nejvyšší hodnoty); nejvýš `maxChips` žetonů celkem, aspoň jeden, když je částka kladná. */
export function chipColumns(amount: number, unit: number, maxChips = 14): { cls: string; count: number }[] {
  const u = Math.max(1, unit);
  let left = Math.max(0, Math.floor(amount / u));
  const cols: { cls: string; count: number }[] = [];
  let used = 0;
  for (const tier of STACK_TIERS) {
    const n = Math.min(Math.floor(left / tier.ratio), maxChips - used);
    if (n > 0) {
      cols.push({ cls: tier.cls, count: n });
      left -= n * tier.ratio;
      used += n;
    }
  }
  if (cols.length === 0 && amount > 0) cols.push({ cls: STACK_TIERS[STACK_TIERS.length - 1]!.cls, count: 1 });
  return cols;
}

/** Sloupečky žetonů z boku (sázka nebo pot na stole); nové žetony po sobě „spadnou“ s malou prodlevou. */
export function ChipStack({ amount, unit }: { amount: number; unit: number }) {
  const cols = chipColumns(amount, unit);
  if (cols.length === 0) return null;
  let n = 0;
  return (
    <span className="tk-chipstack" aria-hidden>
      {cols.map((col, ci) => (
        <span key={ci} className="tk-chipcol">
          {Array.from({ length: col.count }, (_, i) => (
            <span key={i} className={`tk-disc ${col.cls}`} style={{ ['--tk-disc-i' as string]: n++ }} />
          ))}
        </span>
      ))}
    </span>
  );
}
