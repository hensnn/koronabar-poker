import { useDensity } from '../density';
import { useEffect, useMemo, useState } from 'react';
import { Button, NumInput } from '../ui';
import {
  categoryKey,
  groupOf,
  SPECIAL_GROUPS,
  helpKey,
  isVisible,
  labelKey,
  buyInInCurrency,
  optionKey,
  t,
  type Origin,
  type SettingDef,
  type SettingValue,
  type SettingValues,
  type SettingsRegistry,
  type ValidationIssue,
} from '@kb/shared';

interface Props {
  registry: SettingsRegistry;
  /** Efektivní hodnoty včetně zděděných. */
  values: SettingValues;
  origins: Record<string, Origin>;
  /** Do které vrstvy se právě upravuje (hodnota pochází „odsud“, pokud origins[key] === editScope). */
  editScope: string;
  onChange: (key: string, value: SettingValue) => void;
  onReset: (key: string) => void;
  issues: ValidationIssue[];
  /** Jen parametry, které smí tato vrstva přepsat. */
  allowedKeys: (def: SettingDef) => boolean;
  /** Klíče změněné, ale ještě neuložené (ukáže se štítek „Neuloženo“). */
  pendingKeys?: string[];
  gameKind?: 'cash' | 'tournament' | 'live';
}

const field =
  'rounded-sm border border-line bg-surface px-2 py-1 text-text';

/** Barva skupiny nastavení: každá kategorie má svůj odstín, aby se jednotlivé skupiny (Stůl, Časovač tahu, Turnaj…) neslévaly. Třídy jsou zapsané celé kvůli Tailwindu. */
const TONES = [
  { dot: 'bg-success', tab: 'border-l-success', box: 'border-success', row: 'border-l-success', head: 'text-success' },
  { dot: 'bg-info', tab: 'border-l-info', box: 'border-info', row: 'border-l-info', head: 'text-info' },
  { dot: 'bg-warning', tab: 'border-l-warning', box: 'border-warning', row: 'border-l-warning', head: 'text-warning' },
  { dot: 'bg-accent', tab: 'border-l-accent', box: 'border-accent', row: 'border-l-accent', head: 'text-accent' },
  { dot: 'bg-secondary', tab: 'border-l-secondary', box: 'border-secondary', row: 'border-l-secondary', head: 'text-secondary' },
] as const;
/** Odstín všech turnajových skupin. */
const TOURNAMENT_TONE = 3;

/** Kdy se změna projeví: barevný štítek (zelená = kdykoli, žlutá = od další handy, červená = jen před startem). Třídy jsou celé kvůli Tailwindu. */
const WHEN: Record<string, { cls: string; icon: string }> = {
  anytime: { cls: 'border-success text-success', icon: '⚡' },
  betweenHands: { cls: 'border-warning text-warning', icon: '⏭' },
  beforeStart: { cls: 'border-danger text-danger', icon: '🔒' },
  adminOnly: { cls: 'border-line text-muted', icon: '🛡' },
};

/** Malá písmena bez diakritiky, aby „sazka“ našlo i „sázka“. */
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

/** Formulář vygenerovaný z registru nastavení: žádný parametr se nepíše ručně. */
export function SettingsForm(p: Props) {
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const cats = useMemo(
    () => p.registry.categories().filter((c) => p.registry.all().some((d) => d.category === c && p.allowedKeys(d) && isVisible(p.registry, d.key, p.values, p.gameKind))),
    [p.registry, p.allowedKeys, p.values, p.gameKind],
  );
  const changedBy = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of p.registry.all()) if (p.allowedKeys(d) && isVisible(p.registry, d.key, p.values, p.gameKind) && p.origins[d.key] === p.editScope) out[d.category] = (out[d.category] ?? 0) + 1;
    return out;
  }, [p.registry, p.allowedKeys, p.values, p.origins, p.editScope, p.gameKind]);
  const changedTotal = Object.values(changedBy).reduce((a, b) => a + b, 0);
  const [active, setActive] = useState(cats[0] ?? '');
  const current = cats.includes(active) ? active : cats[0];
  const q = fold(query);
  const allCats = useMemo(() => p.registry.categories(), [p.registry]);
  // Příbuzné skupiny (všechny „Turnaj: …“) mají stejný odstín, ostatní se střídají.
  const tone = (c: string) => {
    if (c.startsWith('tournament')) return TONES[TOURNAMENT_TONE]!;
    const others = allCats.filter((x) => !x.startsWith('tournament'));
    const free = TONES.filter((_, i) => i !== TOURNAMENT_TONE);
    return free[Math.max(0, others.indexOf(c)) % free.length]!;
  };

  // Fulltext: všechna slova dotazu se musí najít v názvu, nápovědě, klíči, kategorii nebo názvech možností.
  const words = q.split(/\s+/).filter(Boolean);
  const matches = (d: SettingDef) => {
    const hay = fold([t(labelKey(d.key)), t(helpKey(d.key)), d.key, t(categoryKey(d.category)), ...(d.type === 'enum' ? d.options.map((o) => t(optionKey(d.key, o))) : [])].join(' '));
    return words.every((w) => hay.includes(w));
  };
  const defs = p.registry
    .all()
    .filter((d) => p.allowedKeys(d))
    .filter((d) => (q ? matches(d) : onlyChanged || d.category === current))
    .filter((d) => !onlyChanged || p.origins[d.key] === p.editScope)
    .filter((d) => isVisible(p.registry, d.key, p.values, p.gameKind));
  // Uvnitř Speciálních prvků se nastavení řadí podle podskupin (stabilní řazení drží původní pořadí uvnitř skupiny).
  const groupIdx = (d: SettingDef) => {
    const g = groupOf(d.key, d.category);
    return g ? SPECIAL_GROUPS.indexOf(g) : -1;
  };
  if (!q && !onlyChanged) defs.sort((a, b) => groupIdx(a) - groupIdx(b));

  return (
    <div className="flex flex-col gap-4">
      <input
        className={field}
        type="search"
        placeholder={t('settings.search')}
        aria-label={t('settings.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" role="switch" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
        {t('settings.onlyChanged', { n: changedTotal })}
      </label>
      {!q && !onlyChanged && (
        <div role="tablist" className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === current}
              onClick={() => setActive(c)}
              className={`flex items-center gap-2 rounded-md border px-3 py-1 border-l-4 ${tone(c).tab} ${
                c === current ? `${tone(c).box} bg-raised font-semibold text-text` : 'border-line bg-surface text-text'
              }`}
            >
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${tone(c).dot}`} />
              {t(categoryKey(c))}
              {(changedBy[c] ?? 0) > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-xs text-on-act" title={t('settings.changedInCategory', { n: changedBy[c] ?? 0 })}>
                  {changedBy[c]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className={`flex flex-col gap-3 rounded-md border-2 p-3 ${q ? 'border-line' : tone(current ?? '').box}`}>
        {!q && !onlyChanged && current && (
          <h3 className={`flex items-center gap-2 text-lg font-bold ${tone(current).head}`}>
            <span aria-hidden="true" className={`inline-block h-3 w-3 rounded-full ${tone(current).dot}`} />
            {t(categoryKey(current))}
          </h3>
        )}
        {defs.map((d, i) => (
          <div key={d.key} className="flex flex-col gap-1">
            {!q && !onlyChanged && groupOf(d.key, d.category) && (i === 0 || groupOf(defs[i - 1]!.key, defs[i - 1]!.category) !== groupOf(d.key, d.category)) && (
              <h4 className="mt-3 border-b border-line pb-1 font-heading text-base font-bold text-text">{t(`settings.group.${groupOf(d.key, d.category)}`)}</h4>
            )}
            {(q || onlyChanged) && (i === 0 || defs[i - 1]!.category !== d.category) && (
              <h3 className={`mt-2 flex items-center gap-2 text-sm font-bold ${tone(d.category).head}`}>
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${tone(d.category).dot}`} />
                {t(categoryKey(d.category))}
              </h3>
            )}
            <Row def={d} {...p} rowClass={`border-l-4 ${tone(d.category).row}`} />
          </div>
        ))}
        {defs.length === 0 && <p className="text-muted">{q ? t('settings.searchNone') : t('settings.nothing')}</p>}
      </div>
    </div>
  );
}

function Row({ def, values, origins, editScope, onChange, onReset, issues, pendingKeys, rowClass = '' }: Props & { def: SettingDef; rowClass?: string }) {
  const value = values[def.key] as SettingValue;
  const unsaved = pendingKeys?.includes(def.key) ?? false;
  const origin = origins[def.key] ?? 'default';
  const own = origin === editScope;
  const errs = issues.filter((i) => i.keys.includes(def.key));
  const id = `s-${def.key}`;
  // „Změněno“ = hodnotu nastavuje právě tato vrstva (globální nastavení, šablona, hra, stůl nebo osobní); jinak se dědí z nižší vrstvy nebo z vestavěné výchozí hodnoty.
  const changed = own;
  const when = WHEN[def.mutability] ?? WHEN.anytime!;
  const isBool = def.type === 'bool';
  // Nápověda je v úsporné hustotě sbalená a rozbalí se klepnutím na „?“; v ostatních hustotách je vidět hned.
  const density = useDensity();
  const [helpOpen, setHelpOpen] = useState(density !== 'compact');
  const badge = (
    <span className={`ml-2 inline-flex items-center gap-1 rounded-full border px-2 text-xs ${when.cls}`}>
      <span aria-hidden="true">{when.icon}</span>
      {t(`settings.mutability.${def.mutability}`)}
    </span>
  );
  return (
    <div className={`kd-row rounded-md border ${def.dependsOn ? 'ml-4' : ''} ${changed ? 'border-accent bg-accent/10' : 'border-line bg-surface'} ${rowClass}`}>
      <div className="flex items-start gap-2">
        {isBool && <input id={id} type="checkbox" role="switch" className="mt-1" checked={Boolean(value)} onChange={(e) => onChange(def.key, e.target.checked)} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={id} className="font-medium">
              {def.dependsOn && <span aria-hidden="true" className="mr-1 text-muted">↳</span>}
              {t(labelKey(def.key))}
              {changed && <span className="ml-2 rounded-sm bg-accent px-1 text-xs font-normal text-on-act">{t('settings.changed')}</span>}
            </label>
            {!helpOpen && (
              <span className={`ml-2 text-xs ${when.cls.split(' ')[1] ?? ''}`} title={t(`settings.mutability.${def.mutability}`)} aria-label={t(`settings.mutability.${def.mutability}`)}>
                {when.icon}
              </span>
            )}
            <button type="button" className="ml-2 rounded-full border border-line px-1.5 text-xs text-muted" aria-expanded={helpOpen} aria-label={t('settings.helpToggle')} title={t('settings.helpToggle')} onClick={() => setHelpOpen((v) => !v)}>
              ?
            </button>
            <span className={`text-sm ${own ? 'text-primary' : 'text-muted'}`}>
              {unsaved && <span className="mr-2 rounded-sm bg-warning px-1 text-xs text-on-primary">{t('settings.unsaved')}</span>}
              {t(`settings.origin.${origin}`)}
              {own && (
                <button className="ml-2 underline" onClick={() => onReset(def.key)}>
                  {t('settings.resetToInherited')}
                </button>
              )}
            </span>
          </div>
          {helpOpen && (
            <p className="text-sm text-muted">
              {t(helpKey(def.key))}
              {badge}
            </p>
          )}
        </div>
      </div>
      {!isBool && (
        <div className="mt-1">
          <Control def={def} id={id} value={value} onChange={(v) => onChange(def.key, v)} />
          {buyInInCurrency(def.key, Number(value), values) && <p className="mt-1 text-sm text-muted">= {buyInInCurrency(def.key, Number(value), values)}</p>}
        </div>
      )}
      {errs.map((e, i) => (
        <p key={i} role="alert" className="mt-1 text-danger">
          {t(e.messageKey, e.params)}
        </p>
      ))}
    </div>
  );
}

function Control({
  def,
  id,
  value,
  onChange,
}: {
  def: SettingDef;
  id: string;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
}) {
  const unit = 'unit' in def && def.unit ? t(`unit.${def.unit}`) : '';
  switch (def.type) {
    case 'int':
      return (
        <div className="flex items-center gap-3">
          {def.max - def.min <= 100000 && (
            <input
              aria-label="posuvník"
              type="range"
              className="flex-1"
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              value={Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          )}
          <NumInput id={id} className="w-28" min={def.min} max={def.max} step={def.step ?? 1} value={Number(value)} onChange={onChange} />
          {unit && <span className="text-muted">{unit}</span>}
        </div>
      );
    case 'bool':
      return (
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'enum':
      return (
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {def.options.map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={value === o}
              onClick={() => onChange(o)}
              className={`rounded-md border border-line px-3 py-1 ${
                value === o ? 'bg-primary text-on-primary' : 'bg-surface text-text'
              }`}
            >
              {t(optionKey(def.key, o))}
            </button>
          ))}
        </div>
      );
    case 'color':
      return <input id={id} type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
    case 'string':
      return (
        <input
          id={id}
          className={field}
          maxLength={def.maxLength}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Přilepená lišta dole: počet neuložených změn, Uložit a Zahodit. Při odchodu ze stránky prohlížeč varuje. */
export function UnsavedBar({ count, disabled, onSave, onDiscard, problems = [] }: { count: number; disabled?: boolean; onSave: () => void; onDiscard: () => void; /** Proč nejde uložit (texty chyb). */ problems?: string[] }) {
  useEffect(() => {
    if (count === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [count]);
  if (count === 0) return null;
  return (
    <div role="status" className="sticky bottom-2 z-30 flex flex-wrap items-center gap-2 rounded-md border border-warning bg-surface p-2 shadow-lg">
      <strong className="flex-1">{t('settings.unsavedCount', { n: count })}</strong>
      {problems.length > 0 && (
        <ul className="w-full text-sm text-danger" role="alert">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <Button variant="primary" disabled={disabled} onClick={onSave}>
        {t('lobby.save')}
      </Button>
      <Button onClick={onDiscard}>{t('settings.discard')}</Button>
    </div>
  );
}

/** Chyby, které brání uložení změněných klíčů (chyby jiných, nezměněných hodnot ukládání neblokují), jako čitelné texty. */
export function blockingIssues(issues: ValidationIssue[], changedKeys: string[]): string[] {
  return issues
    .filter((i) => i.keys.length === 0 || i.keys.some((k) => changedKeys.includes(k)))
    .map((i) => `${i.keys.map((k) => t(labelKey(k))).join(', ')}${i.keys.length ? ': ' : ''}${t(i.messageKey, i.params)}`);
}
