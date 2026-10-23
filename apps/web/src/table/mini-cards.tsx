const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** Karty jako text s barevnou barvou (červená pro srdce a káry): do historie událostí, kde nejsou velké karty. */
export function InlineCards({ list }: { list: string[] }) {
  return (
    <span className="whitespace-nowrap font-mono font-semibold">
      {list.map((c, i) => (
        <span key={i} className={`mr-1 rounded-sm bg-card-face px-0.5 ${c[1] === 'h' || c[1] === 'd' ? 'text-suit-red' : 'text-text'}`}>
          {c[0] === 'T' ? '10' : c[0]}
          {SUIT[c[1] ?? ''] ?? ''}
        </span>
      ))}
    </span>
  );
}
