import { useEffect, useMemo, useState } from 'react';
import { categoryKey, isVisible, labelKey, optionKey, parseStructure, scopeAllowed, t, type Level, type SettingDef, type SettingValue, type SettingValues } from '@kb/shared';
import { errorText, get } from '../api';
import { registry } from '../settings';
import { Button, DataTable, Modal, Notice, Spinner, Tabs, Td } from '../ui';

interface Details {
  name: string;
  values: SettingValues;
}

/** Čitelná hodnota parametru: ano/ne, název možnosti, číslo s jednotkou. */
function formatValue(def: SettingDef, v: SettingValue): string {
  switch (def.type) {
    case 'bool':
      return t(v ? 'common.yes' : 'common.no');
    case 'enum':
      return t(optionKey(def.key, String(v)));
    case 'int':
      // Částky ve virtuální měně jsou bez jednotky (symbol se u stolu nezobrazuje).
      return `${v}${def.unit && def.unit !== 'currency' ? ` ${t(`unit.${def.unit}`)}` : ''}`;
    default:
      return String(v ?? '');
  }
}

/** Tabulka levelů turnaje ze struktury blindů (jako „Levels & Blinds“). */
function LevelsTab({ values }: { values: SettingValues }) {
  const levels = useMemo<Level[]>(() => {
    try {
      return parseStructure(String(values['tournament.structure'] ?? ''));
    } catch {
      return [];
    }
  }, [values]);
  const byTime = values['tournament.levelMode'] !== 'hands';
  const length = byTime ? `${values['tournament.levelMinutes']} ${t('unit.min')}` : `${values['tournament.levelHands']} ${t('unit.hand')}`;
  const breakEvery = Number(values['tournament.breakEveryLevels'] ?? 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        {t('rules.levelLength')}: {length}
        {breakEvery > 0 && ` · ${t('rules.breaks', { n: breakEvery, min: Number(values['tournament.breakMinutes'] ?? 0) })}`}
      </p>
      {levels.length === 0 ? (
        <p className="text-muted">{t('rules.noStructure')}</p>
      ) : (
        <DataTable head={['#', t('rules.ante'), t('rules.sb'), t('rules.bb')]}>
          {levels.map((l, i) => (
            <tr key={i} className={breakEvery > 0 && (i + 1) % breakEvery === 0 ? 'border-b-2 border-line' : ''}>
              <Td>{i + 1}</Td>
              <Td className="font-mono">{l.ante || '–'}</Td>
              <Td className="font-mono">{l.smallBlind}</Td>
              <Td className="font-mono">{l.bigBlind}</Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/** Přehled pravidel stolu nebo turnaje: záložky podle kategorií nastavení, jen ke čtení. */
export function RulesDialog({ detailsPath, kind, onClose }: { detailsPath: string; kind: 'cash' | 'tournament'; onClose: () => void }) {
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('');
  useEffect(() => {
    get<Details>(detailsPath).then(setD).catch((e) => setError(errorText(e)));
  }, [detailsPath]);
  const values = d?.values;
  // Kategorie, ve kterých má tato hra aspoň jeden viditelný parametr (bez tajných hodnot).
  const groups = useMemo(() => {
    if (!values) return [];
    const defs = registry.all().filter((x) => scopeAllowed(x.scopes, 'table') && !x.secret && x.key !== 'tournament.structure' && isVisible(registry, x.key, values, kind));
    return registry
      .categories()
      .map((c) => ({ id: c, defs: defs.filter((x) => x.category === c) }))
      .filter((g) => g.defs.length > 0);
  }, [values, kind]);
  const tabs = [...(kind === 'tournament' ? [{ id: 'levels', label: t('rules.levels') }] : []), ...groups.map((g) => ({ id: g.id, label: t(categoryKey(g.id)) }))];
  const current = tabs.some((x) => x.id === tab) ? tab : (tabs[0]?.id ?? '');
  const group = groups.find((g) => g.id === current);
  return (
    <Modal title={d ? t('rules.title', { name: d.name }) : t('lobby.rules')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        {!d && !error && <Spinner label={t('app.loading')} />}
        {values && (
          <>
            <Tabs tabs={tabs} value={current} onChange={setTab} />
            {current === 'levels' ? (
              <LevelsTab values={values} />
            ) : (
              group && (
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
                  {group.defs.map((def) => (
                    <div key={def.key} className="contents">
                      <dt title={t(`settings.${def.key}.help`)}>{t(labelKey(def.key))}</dt>
                      <dd className="text-right font-mono">{formatValue(def, values[def.key] as SettingValue)}</dd>
                    </div>
                  ))}
                </dl>
              )
            )}
          </>
        )}
        <div>
          <Button onClick={onClose}>{t('table.close')}</Button>
        </div>
      </div>
    </Modal>
  );
}
