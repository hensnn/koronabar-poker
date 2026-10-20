import { useEffect, useMemo, useState } from 'react';
import { categoryKey, currencyFormsOf, formatCurrency, isVisible, labelKey, optionKey, scopeAllowed, t, type SettingDef, type SettingValue, type SettingValues } from '@kb/shared';
import { EstimateLine, LevelsTable, levelsFor } from './structure-editor';
import { errorText, get } from '../api';
import { registry } from '../settings';
import { Button, Modal, Notice, Spinner, Tabs } from '../ui';

interface Details {
  name: string;
  values: SettingValues;
}

/** Čitelná hodnota parametru: ano/ne, název možnosti, číslo s jednotkou. */
/** Buy-in je v násobcích velkého blindu; vedle něj se ukáže i částka v měně (BB × velký blind ÷ žetonů na jednotku měny). */
function buyInInCurrency(def: SettingDef, v: SettingValue, values: SettingValues): string {
  if (def.key !== 'cash.minBuyInBb' && def.key !== 'cash.maxBuyInBb') return '';
  const chips = Number(v) * Number(values['table.bigBlind']);
  const rate = Number(values['cash.chipsPerCurrencyUnit']) || 1;
  const cur = Math.round(chips / rate);
  return Number.isFinite(cur) ? ` (${formatCurrency(cur, currencyFormsOf(values))})` : '';
}

function formatValue(def: SettingDef, v: SettingValue, values: SettingValues): string {
  switch (def.type) {
    case 'bool':
      return t(v ? 'common.yes' : 'common.no');
    case 'enum':
      return t(optionKey(def.key, String(v)));
    case 'int':
      // Částky ve virtuální měně jsou bez jednotky (symbol se u stolu nezobrazuje).
      return `${v}${def.unit && def.unit !== 'currency' ? ` ${t(`unit.${def.unit}`)}` : ''}${buyInInCurrency(def, v, values)}`;
    default:
      return String(v ?? '');
  }
}

/** Tabulka levelů turnaje (jako „Levels & Blinds“); bez zadané struktury ukáže tu, která vznikne automaticky. */
function LevelsTab({ values }: { values: SettingValues }) {
  const players = Math.max(2, Math.min(Number(values['table.seats']), Number(values['tournament.minPlayers']) + 3));
  const { levels, generated, error } = useMemo(() => levelsFor(values, players), [values, players]);
  const byTime = values['tournament.levelMode'] !== 'hands';
  const length = byTime ? `${values['tournament.levelMinutes']} ${t('unit.min')}` : `${values['tournament.levelHands']} ${t('unit.hand')}`;
  const breakEvery = Number(values['tournament.breakEveryLevels'] ?? 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        {t('rules.levelLength')}: {length}
        {breakEvery > 0 && ` · ${t('rules.breaks', { n: breakEvery, min: Number(values['tournament.breakMinutes'] ?? 0) })}`}
      </p>
      <p>
        <EstimateLine values={values} players={players} />
      </p>
      {error ? <p className="text-danger">{error}</p> : (
        <>
          {generated && <p className="text-sm text-muted">{t('structure.generatedNote', { n: players })}</p>}
          <LevelsTable levels={levels} breakEvery={breakEvery} />
        </>
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
                      <dd className="text-right font-mono">{formatValue(def, values[def.key] as SettingValue, values)}</dd>
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
