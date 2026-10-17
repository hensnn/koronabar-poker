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
