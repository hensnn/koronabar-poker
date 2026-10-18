import type { Card } from '@kb/game-core';

const SUIT: Record<string, { sym: string; cls: string }> = {
  s: { sym: '♠', cls: 'tk-suit-s' },
  h: { sym: '♥', cls: 'tk-suit-h' },
  d: { sym: '♦', cls: 'tk-suit-d' },
  c: { sym: '♣', cls: 'tk-suit-c' },
};

/** Karta (líc) nebo rub, když je `card` null. Vzhled (styl, barvy barev, rub, zaoblení, stín) určují tokeny motivu. */
const DELAY = ['', 'tk-delay-1', 'tk-delay-2', 'tk-delay-3', 'tk-delay-4'];

export function CardView({ card, small, delay = 0, reveal }: { card: Card | null; small?: boolean; delay?: number; /** Karta se právě odkrývá (showdown, dobrovolné ukázání): místo rozdání se otočí. */ reveal?: boolean }) {
  const scale = (small ? '[--card-scale:0.7] ' : '') + (DELAY[delay] ?? '') + (reveal ? ' tk-card-flip' : '');
  if (!card) {
    return <span aria-label="rub karty" className={`tk-card tk-card-back inline-block border border-line ${scale}`} />;
  }
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUIT[card[1] ?? ''] ?? { sym: '?', cls: 'tk-suit-s' };
  return (
    <span role="img" aria-label={`${rank} ${suit.sym}`} className={`tk-card inline-flex flex-col items-center justify-center border border-line bg-card-face font-mono font-bold leading-none ${suit.cls} ${scale}`}>
      <span className="tk-card-rank">{rank}</span>
      <span className="tk-card-suit">{suit.sym}</span>
    </span>
  );
}
