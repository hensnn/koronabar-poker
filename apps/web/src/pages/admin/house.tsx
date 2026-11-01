import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { Button, Card, DataTable, Notice, NumInput, Select, Td, TextInput } from '../../ui';
import { useSort } from '../../sort';

interface Report {
  house: number;
  categories: string[];
  expenses: { id: number; category: string; amount: number; note: string; at: number }[];
  month: { total: number; byCategory: Record<string, number> };
  year: { total: number; byCategory: Record<string, number> };
  income: { month: number; year: number };
  flow?: { month: Flow; year: Flow };
}

interface Flow {
  opening: number;
  income: { kind: string; amount: number }[];
  outflows: { kind: string; amount: number }[];
  expenses: number;
  closing: number;
}

const kindLabel = (k: string): string => (t(`ledger.kind.${k}`) === `ledger.kind.${k}` ? k : t(`ledger.kind.${k}`));

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
  const exp = useSort<Report['expenses'][number], 'at' | 'category' | 'amount' | 'note'>({ key: 'at', dir: 'desc' }, { at: (x) => x.at, category: (x) => catLabel(x.category), amount: (x) => x.amount, note: (x) => x.note });
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

      {rep.flow && <FlowTable rep={rep} cats={cats} />}

      {rep.expenses.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t('finance.expenseNone')}</p>
      ) : (
        <div className="mt-3">
          <DataTable head={[exp.head('at', t('finance.expenseWhen')), exp.head('category', t('finance.expenseCategory')), exp.head('amount', t('finance.expenseAmount')), exp.head('note', t('finance.expenseNote'))]}>
            {exp.sorted(rep.expenses).map((x) => (
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

/** Návaznost zůstatku domu: začátek období + příjmy − ostatní odchody − zapsané výdaje = konec období (každý řádek je součet pohybů z účetní knihy). */
function FlowTable({ rep, cats }: { rep: Report; cats: string[] }) {
  const m = rep.flow!.month;
  const y = rep.flow!.year;
  const inKinds = [...new Set([...m.income, ...y.income].map((x) => x.kind))];
  const outKinds = [...new Set([...m.outflows, ...y.outflows].map((x) => x.kind))];
  const pick = (list: { kind: string; amount: number }[], k: string) => list.find((x) => x.kind === k)?.amount ?? 0;
  const cell = (v: number, sign: '+' | '-') => (v ? `${sign}${num(v)}` : '0');
  const sum = (f: Flow) => f.opening + f.income.reduce((n, x) => n + x.amount, 0) - f.outflows.reduce((n, x) => n + x.amount, 0) - f.expenses;
  return (
    <div className="mt-3 overflow-x-auto border-t border-line pt-3">
      <p className="mb-2 text-sm text-muted">{t('finance.flowHelp')}</p>
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
            <td className="px-2 py-1">{t('finance.flowOpening')}</td>
            <td className="px-2 py-1 text-right font-mono">{num(m.opening)}</td>
            <td className="px-2 py-1 text-right font-mono">{num(y.opening)}</td>
          </tr>
          {inKinds.map((k) => (
            <tr key={`in-${k}`} className="border-t border-line">
              <td className="px-2 py-1">{t('finance.flowIn')}: {kindLabel(k)}</td>
              <td className="px-2 py-1 text-right font-mono text-success">{cell(pick(m.income, k), '+')}</td>
              <td className="px-2 py-1 text-right font-mono text-success">{cell(pick(y.income, k), '+')}</td>
            </tr>
          ))}
          {outKinds.map((k) => (
            <tr key={`out-${k}`} className="border-t border-line">
              <td className="px-2 py-1">{t('finance.flowOut')}: {kindLabel(k)}</td>
              <td className="px-2 py-1 text-right font-mono">{cell(pick(m.outflows, k), '-')}</td>
              <td className="px-2 py-1 text-right font-mono">{cell(pick(y.outflows, k), '-')}</td>
            </tr>
          ))}
          {cats.map((c) => (
            <tr key={`cat-${c}`} className="border-t border-line">
              <td className="px-2 py-1">{t('finance.expenseSpent')}: {catLabel(c)}</td>
              <td className="px-2 py-1 text-right font-mono">{rep.month.byCategory[c] ? `-${num(rep.month.byCategory[c]!)}` : '0'}</td>
              <td className="px-2 py-1 text-right font-mono">{rep.year.byCategory[c] ? `-${num(rep.year.byCategory[c]!)}` : '0'}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-bold">
            <td className="px-2 py-1">{t('finance.flowClosing')}</td>
            <td className="px-2 py-1 text-right font-mono">{num(m.closing)}</td>
            <td className="px-2 py-1 text-right font-mono">{num(y.closing)}</td>
          </tr>
        </tbody>
      </table>
      {(sum(m) !== m.closing || sum(y) !== y.closing) && <p className="mt-1 text-sm text-danger">{t('finance.flowMismatch')}</p>}
    </div>
  );
}
