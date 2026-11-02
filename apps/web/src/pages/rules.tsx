import { useEffect, useMemo, useState } from 'react';
import { buyInInCurrency, categoryKey, categoryRank, isVisible, labelKey, optionKey, panelGroupIds, panelGroupOf, scopeAllowed, SECTIONS, sectionOf, t, type SettingDef, type SettingValue, type SettingValues } from '@kb/shared';
import { EstimateLine, LevelsTable, levelsFor } from './structure-editor';
import { errorText, get } from '../api';
import { registry } from '../settings';
import { Panel } from '../settings/SettingsForm';
import { Button, Modal, Notice, Spinner, Tabs } from '../ui';

interface Details {
  name: string;
  values: SettingValues;
}

/** Čitelná hodnota parametru: ano/ne, název možnosti, číslo s jednotkou. */
function formatValue(def: SettingDef, v: SettingValue, values: SettingValues): string {
  switch (def.type) {
    case 'bool':
      return t(v ? 'common.yes' : 'common.no');
    case 'enum':
      return t(optionKey(def.key, String(v)));
    case 'int':
      // Částky ve virtuální měně jsou bez jednotky (symbol se u stolu nezobrazuje).
      return `${v}${def.unit && def.unit !== 'currency' ? ` ${t(`unit.${def.unit}`)}` : ''}${buyInInCurrency(def.key, Number(v), values) ? ` (${buyInInCurrency(def.key, Number(v), values)})` : ''}`;
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
  // Oddíly jako v nastavení; v každém sbalené panely kategorií a podskupin.
  const sections = SECTIONS.map((x) => ({ id: x.id as string, cats: groups.filter((g) => sectionOf(g.id) === x.id).sort((a, b) => categoryRank(a.id) - categoryRank(b.id)) })).filter((x) => x.cats.length > 0);
  const tabs = [...(kind === 'tournament' ? [{ id: 'levels', label: t('rules.levels') }] : []), ...sections.map((x) => ({ id: x.id, label: t(`settings.section.${x.id}`) }))];
  const current = tabs.some((x) => x.id === tab) ? tab : (tabs[0]?.id ?? '');
  const section = sections.find((x) => x.id === current);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const list = (defs: SettingDef[]) => (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
      {defs.map((def) => (
        <div key={def.key} className="contents">
          <dt title={t(`settings.${def.key}.help`)}>{t(labelKey(def.key))}</dt>
          <dd className="text-right font-mono">{formatValue(def, values![def.key] as SettingValue, values!)}</dd>
        </div>
      ))}
    </dl>
  );
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
              <div className="flex flex-col gap-2">
                {section?.cats.map((g) => {
                  const ids = panelGroupIds(g.id);
                  return (
                    <Panel key={g.id} title={t(categoryKey(g.id))} open={Boolean(open[g.id])} onToggle={() => toggle(g.id)} count={g.defs.length} changed={0}>
                      {ids.length === 0
                        ? list(g.defs)
                        : ids.map((sub) => {
                            const inSub = g.defs.filter((x) => panelGroupOf(x.key, g.id) === sub);
                            if (inSub.length === 0) return null;
                            const id = `${g.id}/${sub}`;
                            return (
                              <Panel key={sub} level={2} title={t(`settings.group.${sub}`)} open={Boolean(open[id])} onToggle={() => toggle(id)} count={inSub.length} changed={0}>
                                {list(inSub)}
                              </Panel>
                            );
                          })}
                    </Panel>
                  );
                })}
              </div>
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
