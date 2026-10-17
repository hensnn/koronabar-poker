import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import { useSession } from '../session';
import { Button, Modal, Notice, Spinner } from '../ui';
import { fmtDate, HandReplayBody, type HandDetail } from '../pages/hand-replay';
import { ShareHandButton } from '../pages/hand-share';

interface Row {
  id: string;
  handNumber: number;
  playedAt: number;
  net: number;
}

/** Historie hand u tohoto stolu: okno s přehrávačem a šipkami pro listování (nejnovější první). */
export function HandHistory({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const { me } = useSession();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [i, setI] = useState(0);
  const [detail, setDetail] = useState<HandDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get<{ hands: Row[] }>(`/api/stats/hands?tableId=${encodeURIComponent(tableId)}&limit=100`)
      .then((d) => setRows(d.hands))
      .catch((e) => setError(errorText(e)));
  }, [tableId]);
  const row = rows?.[i];
  useEffect(() => {
    if (!row) return;
    setDetail(null);
    get<HandDetail>(`/api/stats/hands/${row.id}`)
      .then(setDetail)
      .catch((e) => setError(errorText(e)));
  }, [row]);
  return (
    <Modal title={t('table.history')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        {rows && rows.length === 0 && <p className="text-muted">{t('table.historyEmpty')}</p>}
        {rows && rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Button aria-label={t('table.prev')} disabled={i >= rows.length - 1} onClick={() => setI(i + 1)}>
              ←
            </Button>
            <span className="flex-1 text-center text-sm">
              {row && t('stats.handTitle', { n: row.handNumber, date: fmtDate(row.playedAt) })} <span className="text-muted">({rows.length - i}/{rows.length})</span>
            </span>
            <Button aria-label={t('table.next')} disabled={i <= 0} onClick={() => setI(i - 1)}>
              →
            </Button>
          </div>
        )}
        {row && !detail && !error && <Spinner label={t('app.loading')} />}
        {detail && (
          <>
            <HandReplayBody d={detail} me={me?.user.id ?? ''} />
            <div className="flex gap-2">
              <ShareHandButton handId={detail.id} />
              <Button onClick={onClose}>{t('table.close')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
