import { useState } from 'react';
import { YEAR_CHANNELS, YEAR_FIELDS, parseYearFields, serializeYearFields, t, type YearChannel, type YearField } from '@kb/shared';
import { errorText } from '../../api';
import { saveGlobalSetting, useSettings } from '../../settings';
import { Card, Notice } from '../../ui';

const KEY: Record<YearChannel, string> = { web: 'stats.yearFieldsWeb', email: 'stats.yearFieldsEmail', api: 'stats.yearFieldsApi' };

/** Správa → Roční statistika: které údaje „výdělku v roce“ se ukážou na webu, pošlou e-mailem a vrátí API. */
export function YearAdminPage() {
  const settings = useSettings();
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const current = (c: YearChannel): YearField[] => parseYearFields(settings.values[KEY[c]], c);
  const toggle = async (c: YearChannel, f: YearField, on: boolean) => {
    const now = current(c);
    const next = on ? [...now, f] : now.filter((x) => x !== f);
    setMsg(null);
    try {
      await saveGlobalSetting(KEY[c], serializeYearFields(next));
      setMsg({ kind: 'success', text: t('year.admin.saved') });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('year.admin.title')}>
        <p className="mb-2 text-sm text-muted">{t('year.admin.intro')}</p>
        {settings.values['stats.yearEnabled'] === false && <Notice kind="error">{t('year.admin.off')}</Notice>}
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-2 py-1">{t('year.admin.field')}</th>
                {YEAR_CHANNELS.map((c) => (
                  <th key={c} className="px-2 py-1 text-center">{t(`year.admin.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {YEAR_FIELDS.map((f) => (
                <tr key={f} className="border-t border-line">
                  <td className="px-2 py-1">
                    <div>{t(`year.field.${f}`)}</div>
                    {t(`year.field.${f}.help`) !== `year.field.${f}.help` && <div className="text-xs text-muted">{t(`year.field.${f}.help`)}</div>}
                  </td>
                  {YEAR_CHANNELS.map((c) => (
                    <td key={c} className="px-2 py-1 text-center">
                      <input type="checkbox" aria-label={`${t(`year.field.${f}`)} – ${t(`year.admin.${c}`)}`} checked={current(c).includes(f)} onChange={(e) => void toggle(c, f, e.target.checked)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
