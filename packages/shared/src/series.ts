/**
 * Série a ligy: body za umístění v jednotlivých turnajích a celkový žebříček série.
 * Vzorec je nastavitelný: tabulka bodů za místo, nebo lineárně podle počtu hráčů; navíc body za účast
 * a započítání jen N nejlepších výsledků.
 */

export interface SeriesConfig {
  mode: 'table' | 'linear';
  /** Body za 1., 2., 3. … místo (režim „table“); dál už jen body za účast. */
  table: number[];
  /** Body za samotnou účast. */
  participation: number;
  /** Režim „linear“: (počet hráčů − místo + 1) × faktor. */
  linearFactor: number;
  /** Do celkového součtu se počítá N nejlepších výsledků (0 = všechny). */
  bestOf: number;
  /** Finálový turnaj pro nejlepších N hráčů (0 = bez finále). */
  finalTopN: number;
}

export const DEFAULT_SERIES: SeriesConfig = { mode: 'table', table: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], participation: 1, linearFactor: 10, bestOf: 0, finalTopN: 0 };

export function pointsFor(cfg: SeriesConfig, place: number, players: number): number {
  const base = cfg.mode === 'linear' ? Math.max(0, players - place + 1) * cfg.linearFactor : (cfg.table[place - 1] ?? 0);
  return base + cfg.participation;
}

export interface SeriesTournament {
  id: string;
  name: string;
  finishedAt: number;
  results: { userId: string; place: number }[];
}

export interface SeriesRow {
  userId: string;
  total: number;
  played: number;
  wins: number;
  bestPlace: number;
  /** Body v jednotlivých turnajích. */
  perTournament: Record<string, number>;
  /** Turnaje, jejichž výsledek se započítal do součtu. */
  counted: string[];
  rank: number;
}

/**
 * Žebříček série. Při stejném počtu bodů rozhoduje víc výher, potom lepší nejlepší umístění,
 * potom víc odehraných turnajů.
 */
export function seriesStandings(cfg: SeriesConfig, tournaments: SeriesTournament[]): SeriesRow[] {
  const rows = new Map<string, SeriesRow>();
  for (const t of tournaments) {
    const players = t.results.length;
    for (const r of t.results) {
      const row = rows.get(r.userId) ?? { userId: r.userId, total: 0, played: 0, wins: 0, bestPlace: Infinity, perTournament: {}, counted: [], rank: 0 };
      row.perTournament[t.id] = pointsFor(cfg, r.place, players);
      row.played++;
      if (r.place === 1) row.wins++;
      row.bestPlace = Math.min(row.bestPlace, r.place);
      rows.set(r.userId, row);
    }
  }
  for (const row of rows.values()) {
    const ranked = Object.entries(row.perTournament).sort((a, b) => b[1] - a[1]);
    const counted = cfg.bestOf > 0 ? ranked.slice(0, cfg.bestOf) : ranked;
    row.counted = counted.map(([id]) => id);
    row.total = counted.reduce((n, [, pts]) => n + pts, 0);
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total || b.wins - a.wins || a.bestPlace - b.bestPlace || b.played - a.played || a.userId.localeCompare(b.userId));
  list.forEach((r, i) => {
    const prev = list[i - 1];
    // Při úplné shodě mají hráči stejné pořadí.
    r.rank = prev && prev.total === r.total && prev.wins === r.wins && prev.bestPlace === r.bestPlace && prev.played === r.played ? prev.rank : i + 1;
  });
  return list;
}

export function validateSeriesConfig(cfg: SeriesConfig): string | null {
  if (cfg.mode !== 'table' && cfg.mode !== 'linear') return 'mode';
  if (!Array.isArray(cfg.table) || cfg.table.length > 100 || cfg.table.some((n) => !Number.isFinite(n) || n < 0)) return 'table';
  if (!Number.isFinite(cfg.participation) || cfg.participation < 0) return 'participation';
  if (!Number.isFinite(cfg.linearFactor) || cfg.linearFactor < 0) return 'linearFactor';
  if (!Number.isInteger(cfg.bestOf) || cfg.bestOf < 0) return 'bestOf';
  if (!Number.isInteger(cfg.finalTopN) || cfg.finalTopN < 0 || cfg.finalTopN > 10) return 'finalTopN';
  return null;
}
