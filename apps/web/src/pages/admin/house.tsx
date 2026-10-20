import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { Button, Card, DataTable, Notice, NumInput, Select, Td, TextInput } from '../../ui';

interface Report {
  house: number;
  categories: string[];
  expenses: { id: number; category: string; amount: number; note: string; at: number }[];
  month: { total: number; byCategory: Record<string, number> };
  year: { total: number; byCategory: Record<string, number> };
  income: { month: number; year: number };
}

const catLabel = (c: string): string => (t(`finance.cat.${c}`) === `finance.cat.${c}` ? c : t(`finance.cat.${c}`));
const num = (n: number) => n.toLocaleString('cs-CZ');

/** Účet domu: zůstatek, vklad (počáteční vklad, doplnění), výdaje podle kategorií a přehled za měsíc a rok. */
export function HouseCard({ onChange }: { onChange: () => void }) {
  const [rep, setRep] = useState<Report | null>(null);
  const [depAmount, setDepAmount] = useState(0);
  const [depNote, setDepNote] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(() => {
    get<Report>('/api/admin/house/report')
      .then((r) => {
        setRep(r);
        setCategory((c) => (r.categories.includes(c) ? c : (r.categories[0] ?? '')));
      })
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<{ done: boolean }>, ok: string) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ kind: 'success', text: t(r.done ? ok : 'finance.housePending') });
      load();
      onChange();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  if (!rep) return <Card title={t('finance.house')}>{msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}</Card>;
  const cats = [...new Set([...rep.categories, ...Object.keys(rep.year.byCategory)])];
  return (
    <Card title={t('finance.house')}>
      <p className="font-mono text-2xl">{num(rep.house)}</p>
      <p className="mt-2 text-sm text-muted">{t('finance.houseHelp')}</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="font-bold">{t('finance.houseIn')}</h3>
        <label className="flex flex-col gap-1 text-sm">
          {t('finance.houseAmount')}
          <NumInput value={depAmount} min={0} onChange={setDepAmount} />
        </label>
        <TextInput label={t('finance.houseReason')} value={depNote} onChange={(e) => setDepNote(e.target.value)} maxLength={300} />
        <div>
          <Button
            variant="primary"
            disabled={depAmount <= 0 || !depNote.trim()}
            onClick={() =>
              void run(async () => {
                const r = await post<{ done: boolean }>('/api/admin/wallet/house', { amount: depAmount, reason: depNote });
                if (r.done) {
                  setDepAmount(0);
                  setDepNote('');
                }
                return r;
              }, 'finance.houseDone')
            }
          >
            {t('finance.houseIn')}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="font-bold">{t('finance.expenseTitle')}</h3>
        <Select label={t('finance.expenseCategory')} value={category} onChange={(e) => setCategory(e.target.value)}>
          {rep.categories.map((c) => (
            <option key={c} value={c}>
              {catLabel(c)}
            </option>
          ))}
        </Select>
        <label className="flex flex-col gap-1 text-sm">
          {t('finance.houseAmount')}
          <NumInput value={amount} min={0} onChange={setAmount} />
        </label>
        <TextInput label={t('finance.expenseNote')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <div>
          <Button
            disabled={amount <= 0 || !note.trim() || !category || amount > rep.house}
            onClick={() =>
              void run(async () => {
                const r = await post<{ done: boolean }>('/api/admin/house/expense', { category, amount, note });
                if (r.done) {
                  setAmount(0);
                  setNote('');
                }
                return r;
              }, 'finance.expenseSaved')
            }
          >
            {t('finance.houseOut')}
          </Button>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto border-t border-line pt-3">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-2 py-1" />
              <th className="px-2 py-1 text-right">{t('finance.expenseMonth')}</th>
              <th className="px-2 py-1 text-right">{t('finance.expenseYear')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line">
              <td className="px-2 py-1">{t('finance.expenseIncome')}</td>
              <td className="px-2 py-1 text-right font-mono text-success">+{num(rep.income.month)}</td>
              <td className="px-2 py-1 text-right font-mono text-success">+{num(rep.income.year)}</td>
            </tr>
            {cats.map((c) => (
              <tr key={c} className="border-t border-line">
                <td className="px-2 py-1">{t('finance.expenseSpent')}: {catLabel(c)}</td>
                <td className="px-2 py-1 text-right font-mono">{rep.month.byCategory[c] ? `-${num(rep.month.byCategory[c]!)}` : '0'}</td>
                <td className="px-2 py-1 text-right font-mono">{rep.year.byCategory[c] ? `-${num(rep.year.byCategory[c]!)}` : '0'}</td>
              </tr>
            ))}
            <tr className="border-t border-line font-bold">
              <td className="px-2 py-1">{t('finance.expenseBalance')}</td>
              <td className="px-2 py-1 text-right font-mono">{num(rep.income.month - rep.month.total)}</td>
              <td className="px-2 py-1 text-right font-mono">{num(rep.income.year - rep.year.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {rep.expenses.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t('finance.expenseNone')}</p>
      ) : (
        <div className="mt-3">
          <DataTable head={[t('finance.expenseWhen'), t('finance.expenseCategory'), t('finance.expenseAmount'), t('finance.expenseNote')]}>
            {rep.expenses.map((x) => (
              <tr key={x.id}>
                <Td>{new Date(x.at).toLocaleDateString('cs-CZ')}</Td>
                <Td>{catLabel(x.category)}</Td>
                <Td className="font-mono">-{num(x.amount)}</Td>
                <Td>{x.note}</Td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  );
}
