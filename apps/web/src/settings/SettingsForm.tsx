import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui';
import {
  categoryKey,
  helpKey,
  isVisible,
  labelKey,
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
  const cats = useMemo(
    () => p.registry.categories().filter((c) => p.registry.all().some((d) => d.category === c && p.allowedKeys(d) && isVisible(p.registry, d.key, p.values, p.gameKind))),
    [p.registry, p.allowedKeys, p.values, p.gameKind],
  );
  const [active, setActive] = useState(cats[0] ?? '');
  const current = cats.includes(active) ? active : cats[0];
  const q = fold(query);

  // Fulltext: všechna slova dotazu se musí najít v názvu, nápovědě, klíči, kategorii nebo názvech možností.
  const words = q.split(/\s+/).filter(Boolean);
  const matches = (d: SettingDef) => {
    const hay = fold([t(labelKey(d.key)), t(helpKey(d.key)), d.key, t(categoryKey(d.category)), ...(d.type === 'enum' ? d.options.map((o) => t(optionKey(d.key, o))) : [])].join(' '));
    return words.every((w) => hay.includes(w));
  };
  const defs = p.registry
    .all()
    .filter((d) => p.allowedKeys(d))
    .filter((d) => (q ? matches(d) : d.category === current))
    .filter((d) => isVisible(p.registry, d.key, p.values, p.gameKind));

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
      {!q && (
        <div role="tablist" className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === current}
              onClick={() => setActive(c)}
              className={`rounded-md border border-line px-3 py-1 ${
                c === current ? 'bg-primary text-on-primary' : 'bg-surface text-text'
              }`}
            >
              {t(categoryKey(c))}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {defs.map((d, i) => (
          <div key={d.key} className="flex flex-col gap-1">
            {q && (i === 0 || defs[i - 1]!.category !== d.category) && <h3 className="mt-2 text-sm font-bold text-muted">{t(categoryKey(d.category))}</h3>}
            <Row def={d} {...p} />
          </div>
        ))}
        {defs.length === 0 && <p className="text-muted">{q ? t('settings.searchNone') : t('settings.nothing')}</p>}
      </div>
    </div>
  );
}

function Row({ def, values, origins, editScope, onChange, onReset, issues, pendingKeys }: Props & { def: SettingDef }) {
  const value = values[def.key] as SettingValue;
  const unsaved = pendingKeys?.includes(def.key) ?? false;
  const origin = origins[def.key] ?? 'default';
  const own = origin === editScope;
  const errs = issues.filter((i) => i.keys.includes(def.key));
  const id = `s-${def.key}`;
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-medium">
          {t(labelKey(def.key))}
        </label>
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
      <p className="text-sm text-muted">
        {t(helpKey(def.key))} <em>({t(`settings.mutability.${def.mutability}`)})</em>
      </p>
      <div className="mt-2">
        <Control def={def} id={id} value={value} onChange={(v) => onChange(def.key, v)} />
      </div>
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
          <input
            id={id}
            type="number"
            className={`${field} w-28 font-mono`}
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            value={Number(value)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
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
export function UnsavedBar({ count, disabled, onSave, onDiscard }: { count: number; disabled?: boolean; onSave: () => void; onDiscard: () => void }) {
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
      <Button variant="primary" disabled={disabled} onClick={onSave}>
        {t('lobby.save')}
      </Button>
      <Button onClick={onDiscard}>{t('settings.discard')}</Button>
    </div>
  );
}
