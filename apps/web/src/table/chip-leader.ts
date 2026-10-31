/** Chipleader: jediný hráč s nejvíc žetony mezi těmi, kdo ještě hrají; při méně než třech hráčích nebo shodě se nikdo neoznačuje. */
export function chipLeaderOf(standings: { userId: string; chips: number | null; status: string }[] | undefined): string | null {
  const alive = (standings ?? []).filter((p) => (p.status === 'playing' || p.status === 'deciding') && p.chips !== null && p.chips > 0);
  if (alive.length < 3) return null;
  const top = Math.max(...alive.map((p) => p.chips!));
  const leaders = alive.filter((p) => p.chips === top);
  return leaders.length === 1 ? leaders[0]!.userId : null;
}
