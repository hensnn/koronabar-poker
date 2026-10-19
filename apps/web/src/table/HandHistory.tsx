import { useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import { useSession } from '../session';
import { Button, Modal, Notice, Spinner } from '../ui';
import { fmtDate, HandReplayBody, signed, type HandDetail } from '../pages/hand-replay';
import { ShareHandButton } from '../pages/hand-share';

interface Row {
  id: string;
  handNumber: number;
  playedAt: number;
  net: number;
  pot: number;
  board: string[];
  hole: [string, string] | null;
  chipsPerUnit: number;
  showdown: boolean;
}

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const card = (c: string) => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1] ?? ''] ?? ''}`;
const cards = (cs: string[]) => cs.map(card).join(' ');
const suitClass = (c: string) => (c[1] === 'h' || c[1] === 'd' ? 'text-suit-red' : '');
const unit = (n: number, per: number) => (per > 1 ? Math.round((n / per) * 100) / 100 : n);
const time = (ts: number) => new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

function Cards({ list }: { list: string[] }) {
  return (
    <span className="whitespace-nowrap font-mono">
      {list.map((c, i) => (
        <span key={i} className={`mr-1 ${suitClass(c)}`}>
          {card(c)}
        </span>
      ))}
    </span>
  );
}

/**
 * Historie hand u tohoto stolu: okno stálé velikosti se stručným seznamem (jeden řádek na handu: číslo, čas, moje karty, stůl,
 * pot a výsledek). Podrobný průběh po akcích se otevře klepnutím na řádek, ve stejném okně.
 */
export function HandHistory({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const { me } = useSession();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HandDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get<{ hands: Row[] }>(`/api/stats/hands?tableId=${encodeURIComponent(tableId)}&limit=100`)
      .then((d) => setRows(d.hands))
      .catch((e) => setError(errorText(e)));
  }, [tableId]);
  useEffect(() => {
    if (!openId) return;
    setDetail(null);
    get<HandDetail>(`/api/stats/hands/${openId}`)
      .then(setDetail)
      .catch((e) => setError(errorText(e)));
  }, [openId]);
  const total = useMemo(() => (rows ?? []).reduce((n, r) => n + unit(r.net, r.chipsPerUnit), 0), [rows]);
  const index = rows?.findIndex((r) => r.id === openId) ?? -1;
  return (
    <Modal title={t('table.history')} wide onClose={onClose}>
      {/* Pevná velikost: seznam i detail se uvnitř posouvají, okno se nezvětšuje ani nezmenšuje. */}
      <div className="flex h-[75vh] w-full flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        {rows && rows.length === 0 && <p className="text-muted">{t('table.historyEmpty')}</p>}
        {!openId && rows && rows.length > 0 && (
          <>
            <p className="text-sm text-muted">
              {t('table.historySummary', { n: rows.length })} <strong className={total > 0 ? 'text-success' : total < 0 ? 'text-danger' : ''}>{signed(Math.round(total * 100) / 100)}</strong>
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-raised text-left text-muted">
                  <tr>
                    <th className="px-2 py-1">{t('table.historyHand')}</th>
                    <th className="px-2 py-1">{t('table.historyMyCards')}</th>
                    <th className="px-2 py-1">{t('table.historyBoard')}</th>
                    <th className="px-2 py-1 text-right">{t('table.historyPot')}</th>
                    <th className="px-2 py-1 text-right">{t('table.historyResult')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const net = unit(r.net, r.chipsPerUnit);
                    return (
                      <tr key={r.id} className="cursor-pointer border-t border-line hover:bg-raised" tabIndex={0} onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(r.id)}>
                        <td className="px-2 py-1 whitespace-nowrap">
                          #{r.handNumber} <span className="text-muted">{time(r.playedAt)}</span>
                        </td>
                        <td className="px-2 py-1">{r.hole ? <Cards list={r.hole} /> : '–'}</td>
                        <td className="px-2 py-1">{r.board.length > 0 ? <Cards list={r.board} /> : <span className="text-muted">–</span>}</td>
                        <td className="px-2 py-1 text-right font-mono">{unit(r.pot, r.chipsPerUnit)}</td>
                        <td className={`px-2 py-1 text-right font-mono font-semibold ${net > 0 ? 'text-success' : net < 0 ? 'text-danger' : 'text-muted'}`}>{signed(net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {openId && (
          <>
            <div className="flex items-center gap-2">
              <Button onClick={() => setOpenId(null)}>← {t('table.historyBack')}</Button>
              <span className="flex-1 text-center text-sm">
                {detail && t('stats.handTitle', { n: detail.handNumber, date: fmtDate(detail.playedAt) })}
              </span>
              <Button aria-label={t('table.prev')} disabled={!rows || index >= rows.length - 1} onClick={() => rows && setOpenId(rows[index + 1]!.id)}>
                ←
              </Button>
              <Button aria-label={t('table.next')} disabled={index <= 0} onClick={() => rows && setOpenId(rows[index - 1]!.id)}>
                →
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!detail && !error && <Spinner label={t('app.loading')} />}
              {detail && <HandReplayBody d={detail} me={me?.user.id ?? ''} />}
            </div>
            {detail && (
              <div className="flex gap-2">
                <ShareHandButton handId={detail.id} />
                <Button onClick={onClose}>{t('table.close')}</Button>
              </div>
            )}
          </>
        )}
        {!openId && (
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('table.close')}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
