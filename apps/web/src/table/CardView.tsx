import type { Card } from '@kb/game-core';

const SUIT: Record<string, { sym: string; cls: string }> = {
  s: { sym: '♠', cls: 'tk-suit-s' },
  h: { sym: '♥', cls: 'tk-suit-h' },
  d: { sym: '♦', cls: 'tk-suit-d' },
  c: { sym: '♣', cls: 'tk-suit-c' },
};

/** Karta (líc) nebo rub, když je `card` null. Vzhled (styl, barvy barev, rub, zaoblení, stín) určují tokeny motivu. */
/** Styl rozdání: vlastní zpoždění a odkud karta letí (počítá se mimo JSX, styl nemá obsahovat pevné hodnoty). */
function cardStyle(delayMs?: number, fly?: { dx: number; dy: number }): Record<string, string> | undefined {
  if (!delayMs && !fly) return undefined;
  const style: Record<string, string> = {};
  if (delayMs) style.animationDelay = `${delayMs}ms`;
  if (fly) {
    style['--deal-dx'] = `${fly.dx}cqw`;
    style['--deal-dy'] = `calc(${fly.dy}cqw / var(--tk-table-aspect))`;
  }
  return style;
}

const DELAY = ['', 'tk-delay-1', 'tk-delay-2', 'tk-delay-3', 'tk-delay-4'];

export function CardView({ card, small, delay = 0, delayMs, still, fly, reveal, shown }: { card: Card | null; /** Karta se právě dobrovolně ukazuje: ukazující ji zvedne a zazáří, soupeř ji vidí otočit se se záři. */ shown?: 'self' | 'other'; small?: boolean; delay?: number; /** Vlastní zpoždění rozdání v ms (postupné rozdávání více běhů). */ delayMs?: number; /** Karta už na stole byla: bez animace rozdání. */ still?: boolean; /** Karta doletí od rozdávajícího (posun v % šířky stolu). */ fly?: { dx: number; dy: number }; /** Karta se právě odkrývá (showdown, dobrovolné ukázání): místo rozdání se otočí. */ reveal?: boolean }) {
  const scale = (small ? '[--card-scale:0.7] ' : '') + (DELAY[delay] ?? '') + (shown ? ' tk-card-shown-' + shown : reveal ? ' tk-card-flip' : '') + (still ? ' tk-card-still' : '') + (fly ? ' tk-card-fly' : '');
  const style = cardStyle(delayMs, fly);
  if (!card) {
    return <span aria-label="rub karty" style={style} className={`tk-card tk-card-back inline-block border border-line ${scale}`} />;
  }
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUIT[card[1] ?? ''] ?? { sym: '?', cls: 'tk-suit-s' };
  return (
    <span role="img" aria-label={`${rank} ${suit.sym}`} style={style} className={`tk-card inline-flex flex-col items-center justify-center border border-line bg-card-face font-mono font-bold leading-none ${suit.cls} ${scale}`}>
      <span className="tk-card-rank">{rank}</span>
      <span className="tk-card-suit">{suit.sym}</span>
    </span>
  );
}
