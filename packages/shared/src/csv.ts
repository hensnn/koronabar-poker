import { t } from './i18n/cs.js';

/** Buňka CSV (oddělovač středník, jako českému Excelu vyhovuje): uvozovky se zdvojí a text začínající znakem vzorce dostane apostrof, aby ho tabulka nespustila. */
export function csvCell(x: string | number): string {
  const raw = String(x);
  const safe = typeof x === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface TournamentCsvRow {
  place: number;
  name: string;
  entries: number;
  entryAmount: number;
  rebuys: number;
  rebuyAmount: number;
  addons: number;
  addonAmount: number;
  spent: number;
  payout: number;
  bounty: number;
  profit: number;
}

/** CSV výsledků turnaje s náklady: buy-in, rebuye, add-ony, zaplaceno, výhra, bounty a zisk (s BOM pro Excel, řádky CRLF). */
export function tournamentCsv(tournamentName: string, rows: TournamentCsvRow[]): string {
  const head = ['place', 'player', 'entries', 'entryAmount', 'rebuys', 'rebuyAmount', 'addons', 'addonAmount', 'spent', 'payout', 'bounty', 'profit'].map((k) => csvCell(t(`tournament.csv.${k}`)));
  const lines = [[csvCell(t('tournament.csv.tournament')), csvCell(tournamentName)].join(';'), head.join(';')];
  for (const r of rows) lines.push([r.place, r.name, r.entries, r.entryAmount, r.rebuys, r.rebuyAmount, r.addons, r.addonAmount, r.spent, r.payout, r.bounty, r.profit].map(csvCell).join(';'));
  const total = (k: 'entryAmount' | 'rebuyAmount' | 'addonAmount' | 'spent' | 'payout' | 'bounty' | 'profit') => rows.reduce((n, r) => n + r[k], 0);
  lines.push(['', t('tournament.csv.total'), '', total('entryAmount'), '', total('rebuyAmount'), '', total('addonAmount'), total('spent'), total('payout'), total('bounty'), total('profit')].map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export interface LedgerCsvRow {
  id: number;
  at: number;
  kind: string;
  note: string;
  entries: { account: string; amount: number }[];
}

/** CSV účetní knihy: číslo pohybu, datum a čas (UTC, ISO), druh, největší částka, záznamy „účet: částka“ a poznámka (s BOM, CRLF). */
export function ledgerCsv(rows: LedgerCsvRow[]): string {
  const head = ['id', 'at', 'kind', 'amount', 'entries', 'note'].map((k) => csvCell(t(`cashier.ledger.csv.${k}`)));
  const lines = [head.join(';')];
  for (const r of rows) {
    const label = t(`ledger.kind.${r.kind}`);
    lines.push([r.id, new Date(r.at).toISOString(), label === `ledger.kind.${r.kind}` ? r.kind : label, Math.max(0, ...r.entries.map((e) => Math.abs(e.amount))), r.entries.map((e) => `${e.account}: ${e.amount > 0 ? '+' : ''}${e.amount}`).join(' | '), r.note].map(csvCell).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
