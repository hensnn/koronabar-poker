import { useState } from 'react';
import { currencyFormsOf, formatCurrency, t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { can, useSession } from '../../session';
import { useSettings } from '../../settings';
import { Badge, Button, DataTable, Fold, Modal, Notice, Td } from '../../ui';
import { payoutFixPlan, type PayoutProblem } from './payout-recheck-plan';

const KIND_TONE = { fixable: 'danger', mismatch: 'warning', uncertain: 'muted' } as const;

/**
 * Pokladník: přepočet výplat odehraných turnajů. Ukáže podrobně, kde se vyplacené částky liší od přepočtu,
 * a opravu (převod rozdílu mezi hráči přes účetní knihu) zapíše až po výslovném potvrzení.
 */
export function PayoutRecheckCard() {
  const { me } = useSession();
  const forms = currencyFormsOf(useSettings().values);
  const money = (n: number) => formatCurrency(n, forms);
  const signed = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0));
  const [list, setList] = useState<PayoutProblem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [confirm, setConfirm] = useState<PayoutProblem | null>(null);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setList((await get<{ tournaments: PayoutProblem[] }>('/api/admin/consistency/payouts')).tournaments);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (p: PayoutProblem) => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ moved: number; credit: number }>('/api/admin/consistency/repair-payouts', { id: p.id });
      setDone(t(r.credit > 0 ? 'payoutFix.doneCredit' : 'payoutFix.done', { name: p.name, moved: money(r.moved), credit: money(r.credit) }));
      setConfirm(null);
      await run();
    } catch (e) {
      setError(errorText(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };
  const transfers = (p: PayoutProblem) => payoutFixPlan(p).moves.map((m) => `${m.name} ${signed(m.amount)}`).join(', ');

  return (
    <Fold title={t('payoutFix.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('payoutFix.help')}</p>
        <div>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {t('payoutFix.run')}
          </Button>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {done && <Notice kind="success">{done}</Notice>}
        {list && list.length === 0 && <Notice kind="success">{t('payoutFix.allOk')}</Notice>}
        {list && list.length > 0 && <Notice kind="warning">{t('payoutFix.found', { n: list.length })}</Notice>}
        {list?.map((p) => {
          const plan = payoutFixPlan(p);
          return (
            <section key={p.id} className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3">
              <h3 className="flex flex-wrap items-center gap-2 font-medium">
                {p.name} <Badge tone={KIND_TONE[p.kind]}>{t(`payoutFix.kind.${p.kind}`)}</Badge>
              </h3>
              <p className="text-sm text-muted">
                {t('payoutFix.meta', { date: p.finishedAt ? new Date(p.finishedAt).toLocaleString('cs-CZ') : '?', pool: money(p.pool), places: p.paidPlaces })}
              </p>
              <p className="text-sm">{t(`payoutFix.kindHelp.${p.kind}`)}</p>
              <DataTable sortable={false} head={[t('payoutFix.col.place'), t('payoutFix.col.player'), t('payoutFix.col.paid'), t('payoutFix.col.correct'), t('payoutFix.col.diff'), t('payoutFix.col.balance')]}>
                {p.rows.map((r) => {
                  const diff = r.correct - r.paid;
                  return (
                    <tr key={r.userId} className={r.flagged ? 'bg-surface font-semibold' : ''}>
                      <Td className="font-mono">{r.place}.</Td>
                      <Td>{r.name}</Td>
                      <Td className="font-mono whitespace-nowrap">{money(r.paid)}</Td>
                      <Td className="font-mono whitespace-nowrap">{money(r.correct)}</Td>
                      <Td className={`font-mono whitespace-nowrap ${diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-muted'}`}>{diff === 0 ? '—' : signed(diff)}</Td>
                      <Td className="font-mono whitespace-nowrap text-muted">{money(r.balance)}</Td>
                    </tr>
                  );
                })}
              </DataTable>
              {p.kind === 'fixable' && (
                <>
                  <p className="text-sm">{t('payoutFix.transfers', { list: transfers(p) })}</p>
                  {plan.credit.map((x) => (
                    <Notice key={x.userId} kind="warning">
                      {t('payoutFix.fromCredit', { name: x.name, has: money(x.has), owes: money(x.owes), amount: money(x.amount) })}
                    </Notice>
                  ))}
                  {plan.short.map((x) => (
                    <Notice key={x.userId} kind="error">
                      {t(x.credit > 0 ? 'payoutFix.shortCredit' : 'payoutFix.short', { name: x.name, has: money(x.has), owes: money(x.owes), credit: money(x.credit), missing: money(x.owes - x.has - x.credit) })}
                    </Notice>
                  ))}
                  {can(me, 'mena.upravit_knihu') && (
                    <div>
                      <Button variant="primary" disabled={busy || plan.short.length > 0} onClick={() => setConfirm(p)}>
                        {t('payoutFix.apply')}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
      {confirm && (
        <Modal title={t('payoutFix.confirmTitle')} onClose={() => setConfirm(null)}>
          <div className="flex flex-col gap-3">
            <p>{t('payoutFix.confirmText', { name: confirm.name })}</p>
            <ul className="flex flex-col gap-1 rounded-md border border-line bg-raised p-2 font-mono text-sm">
              {payoutFixPlan(confirm).moves.map((m) => (
                <li key={m.userId} className="flex justify-between gap-3">
                  <span>{m.name}</span>
                  <span className={m.amount > 0 ? 'text-success' : 'text-danger'}>{signed(m.amount)}</span>
                </li>
              ))}
            </ul>
            {payoutFixPlan(confirm).credit.map((x) => (
              <Notice key={x.userId} kind="warning">
                {t('payoutFix.confirmCredit', { name: x.name, amount: money(x.amount), wallet: money(x.has) })}
              </Notice>
            ))}
            <p className="text-sm text-muted">{t('payoutFix.confirmNote')}</p>
            <div className="flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                {t('payoutFix.cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void apply(confirm)}>
                {t('payoutFix.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Fold>
  );
}
