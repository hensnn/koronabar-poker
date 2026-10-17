import type { TournamentTable } from './tournament.js';
import type { SetTable } from './table-set.js';

/**
 * „Stůl“ živého turnaje: hraje se fyzicky se skutečnými kartami, takže aplikace jen eviduje, kdo sedí na kterém místě.
 * Žetony ani handy neřeší (stack jednotlivce neznáme), turnaj běží jen na hodinách a ručních zápisech ředitele.
 */
export class LiveTable implements TournamentTable, SetTable {
  private seats = new Map<string, { seat: number; name: string }>();

  seatTournamentPlayer(userId: string, name: string, seat: number): void {
    this.seats.set(userId, { seat, name });
  }

  addTournamentChips(): void {
    /* žetony se nesledují */
  }

  removeTournamentPlayer(userId: string): void {
    this.seats.delete(userId);
  }

  chipsOf(): number | null {
    return null;
  }

  hold(): void {
    /* nic se nezastavuje, hodiny řídí turnaj */
  }

  release(): void {
    /* viz hold */
  }

  playersSeated(): { userId: string; name: string; seat: number; chips: number; pendingChips: number; mode: string }[] {
    return [...this.seats].map(([userId, v]) => ({ userId, name: v.name, seat: v.seat, chips: 0, pendingChips: 0, mode: 'in' }));
  }

  seatOf(userId: string): number | null {
    return this.seats.get(userId)?.seat ?? null;
  }

  currentPhase(): string {
    return 'idle';
  }

  viewFor(): { buttonSeat: number | null } {
    return { buttonSeat: null };
  }

  close(): void {
    this.seats.clear();
  }
}
