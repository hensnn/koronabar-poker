import { useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import {
  BUILTIN_THEMES,
  COLOR_BLIND_MATRIX,
  CONTRAST_PAIRS,
  THEME_SCHEMA_VERSION,
  TOKEN_DEFS,
  checkContrast,
  cssVarName,
  exportTheme,
  fixContrast,
  generateVariant,
  importTheme,
  resolveTokens,
  type ColorBlindKind,
  type Mode,
  type Theme,
  type TokenCategory,
  type TokenDef,
} from '@kb/tokens';
import { errorText } from '../api';
import { can, useSession } from '../session';
import { Link } from '../router';
import { setThemePreview } from '../theme/preview';
import { createTheme, deleteTheme, lockTokens, shareTheme, updateTheme, useThemeStore } from '../theme/themes-client';
import { HARMONIES, TokenField, harmony, useHistory } from '../theme/fields';
import { ThemePreview } from '../theme/ThemePreview';
import { ThemeGallery } from './theme-gallery';
import { Badge, Button, Card, Modal, Notice, Select, Tabs, TextInput } from '../ui';

const CATEGORIES: TokenCategory[] = ['colors', 'table', 'cards', 'chips', 'players', 'buttons', 'typography', 'shape', 'animation'];
const CB_KINDS: ColorBlindKind[] = ['protanopia', 'deuteranopia', 'tritanopia'];

const emptyTheme = (base: Theme): Theme => ({ ...base, builtin: false, schemaVersion: THEME_SCHEMA_VERSION, light: { ...base.light }, dark: { ...base.dark } });

/** SVG filtry pro simulaci barvosleposti (použije je CSS třída \`tk-cb-…\`). */
function ColorBlindFilters() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute">
      <defs>
        {CB_KINDS.map((k) => {
          const m = COLOR_BLIND_MATRIX[k];
          const v = `${m[0]} ${m[1]} ${m[2]} 0 0  ${m[3]} ${m[4]} ${m[5]} 0 0  ${m[6]} ${m[7]} ${m[8]} 0 0  0 0 0 1 0`;
          return (
            <filter key={k} id={`tk-cb-${k}`} colorInterpolationFilters="linearRGB">
              <feColorMatrix type="matrix" values={v} />
            </filter>
          );
        })}
      </defs>
    </svg>
  );
}

/** Editor vzhledu: záložky podle kategorií, živý náhled, kontrola kontrastu, simulace barvosleposti, undo / redo. */
export function ThemeEditorPage() {
  const { me } = useSession();
  const store = useThemeStore();
  const mine = store.themes.filter((x) => x.mine);
  const [current, setCurrent] = useState<{ id: string | null; name: string; base: Theme; status: string }>({ id: null, name: '', base: BUILTIN_THEMES[0]!, status: 'private' });
  const hist = useHistory<Theme>(emptyTheme(BUILTIN_THEMES[0]!));
  const draft = hist.value;
  const [mode, setMode] = useState<Mode>('light');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [cb, setCb] = useState<'none' | ColorBlindKind>('none');
  const [compare, setCompare] = useState(false);
  const [tab, setTab] = useState<TokenCategory | 'contrast' | 'palette' | 'admin'>('colors');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const manageLocks = can(me, 'motiv.zamknout_prvky');
  const locked = new Set(store.locked);

  const dirty = JSON.stringify([draft.light, draft.dark]) !== JSON.stringify([current.base.light, current.base.dark]);

  // živý náhled v celé aplikaci
  useEffect(() => {
    setThemePreview(compare ? current.base : draft, mode);
  }, [draft, mode, compare, current.base]);
  useEffect(() => () => setThemePreview(null, null), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        hist.undo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        hist.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hist]);

  const value = (d: TokenDef): string => (d.shared ? draft.light[d.key] : draft[mode][d.key]) ?? d[mode];
  const setValue = (d: TokenDef, v: string) => {
    const next = emptyTheme(draft);
    if (d.shared) {
      next.light[d.key] = v;
      next.dark[d.key] = v;
    } else next[mode][d.key] = v;
    hist.set(next, d.key);
  };
  const baseValue = (d: TokenDef): string | undefined => (d.shared ? current.base.light[d.key] : current.base[mode][d.key]);
  const resetToken = (d: TokenDef) => {
    const next = emptyTheme(draft);
    const restore = (m: 'light' | 'dark') => {
      const b = current.base[m][d.key];
      if (b === undefined) delete next[m][d.key];
      else next[m][d.key] = b;
    };
    if (d.shared) (['light', 'dark'] as const).forEach(restore);
    else restore(mode);
    hist.set(next);
  };
  const resetCategory = (cat: TokenCategory) => {
    const next = emptyTheme(draft);
    for (const d of TOKEN_DEFS.filter((x) => x.category === cat)) for (const m of ['light', 'dark'] as const) {
      const b = current.base[m][d.key];
      if (b === undefined) delete next[m][d.key];
      else next[m][d.key] = b;
    }
    hist.set(next);
  };

  /** Načte cizí (sdílený nebo čekající) motiv jako kopii k úpravě. */
  const loadCustom = (th: { name: string; theme: Theme }) => {
    const base = emptyTheme(th.theme);
    setCurrent({ id: null, name: `${t('editor.copyOf')} ${th.name}`, base, status: 'private' });
    hist.reset(emptyTheme(base));
    setMsg(null);
  };

  const load = (id: string) => {
    const custom = store.themes.find((x) => x.id === id);
    const builtin = BUILTIN_THEMES.find((x) => x.id === id);
    const src = custom?.theme ?? builtin;
    if (!src) return;
    const base = emptyTheme(src);
    // vestavěný motiv jde jen číst: úpravy se ukládají jako nový motiv
    setCurrent({ id: custom && custom.mine ? custom.id : null, name: custom && custom.mine ? custom.name : `${t('editor.copyOf')} ${builtin ? t(builtin.name) : (custom?.name ?? '')}`, base, status: custom?.status ?? 'private' });
    hist.reset(emptyTheme(base));
    setMsg(null);
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };

  const save = () =>
    run(async () => {
      const payload = { light: draft.light, dark: draft.dark, schemaVersion: THEME_SCHEMA_VERSION };
      if (current.id) {
        const r = await updateTheme(current.id, { name: current.name, theme: payload });
        setCurrent({ ...current, base: emptyTheme(draft) });
        if (r.dropped.length) setMsg({ kind: 'error', text: t('editor.importDropped', { n: r.dropped.length }) });
      } else {
        const name = current.name.trim() || t('editor.newName');
        const r = await createTheme(name, payload);
        setCurrent({ ...current, id: r.id, name, base: emptyTheme(draft) });
        if (r.dropped.length) setMsg({ kind: 'error', text: t('editor.importDropped', { n: r.dropped.length }) });
      }
    }, t('editor.saved'));

  const issues = useMemo(() => {
    const list: { mode: Mode; fg: string; bg: string; ratio: number; min: number }[] = [];
    for (const m of ['light', 'dark'] as const) for (const i of checkContrast(resolveTokens(draft, m))) list.push({ mode: m, ...i });
    return list;
  }, [draft]);

  // ovládací prvky editoru mají vždy čitelný vestavěný vzhled, ať se rozpracovaný motiv vypadá jakkoli
  const chromeStyle = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolveTokens(BUILTIN_THEMES[0]!, mode))) {
      const d = TOKEN_DEFS.find((x) => x.key === k)!;
      if (d.type !== 'text' && d.type !== 'image') out[cssVarName(k)] = v;
    }
    return out;
  }, [mode]);
  const Chrome = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
    <div style={chromeStyle} className={`rounded-md bg-bg p-2 text-text ${className}`}>
      {children}
    </div>
  );

  const visible = TOKEN_DEFS.filter((d) => d.type !== 'image').filter((d) => (query.trim() ? t(`token.${d.key}`).toLowerCase().includes(query.trim().toLowerCase()) : tab === d.category));

  return (
    <main className="flex flex-col gap-3">
      <ColorBlindFilters />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-heading text-2xl font-bold">{t('editor.title')}</h1>
        <Link to="/nastaveni" className="underline">
          {t('editor.back')}
        </Link>
      </div>
      <Notice>{t('editor.safeNote')}</Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <Chrome>
      <Card title={t('editor.theme')}>
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label={t('editor.load')} value="" onChange={(e) => e.target.value && load(e.target.value)}>
              <option value="">–</option>
              <optgroup label={t('editor.builtin')}>
                {BUILTIN_THEMES.map((th) => (
                  <option key={th.id} value={th.id}>
                    {t(th.name)}
                  </option>
                ))}
              </optgroup>
              {mine.length > 0 && (
                <optgroup label={t('editor.mine')}>
                  {mine.map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {store.themes.some((x) => !x.mine) && (
                <optgroup label={t('editor.shared')}>
                  {store.themes
                    .filter((x) => !x.mine)
                    .map((th) => (
                      <option key={th.id} value={th.id}>
                        {th.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </Select>
            <TextInput label={t('editor.name')} value={current.name} maxLength={60} onChange={(e) => setCurrent({ ...current, name: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!can(me, 'motiv.vytvorit') || !current.name.trim()} onClick={() => void save()}>
              {current.id ? t('editor.save') : t('editor.saveNew')}
            </Button>
            <Button disabled={!hist.canUndo} onClick={hist.undo} title="Ctrl+Z">
              ↶ {t('editor.undo')}
            </Button>
            <Button disabled={!hist.canRedo} onClick={hist.redo} title="Ctrl+Y">
              ↷ {t('editor.redo')}
            </Button>
            <Button aria-pressed={compare} onMouseDown={() => setCompare(true)} onMouseUp={() => setCompare(false)} onMouseLeave={() => setCompare(false)} onClick={() => setCompare((c) => !c)}>
              {t('editor.compare')}
            </Button>
            <Button onClick={() => confirm(t('editor.resetAllConfirm')) && hist.set(emptyTheme(current.base))}>{t('editor.resetAll')}</Button>
            <Button
              onClick={() => {
                const other: Mode = mode === 'light' ? 'dark' : 'light';
                const gen = generateVariant(resolveTokens(draft, mode), mode, other);
                const next = emptyTheme(draft);
                Object.assign(next[other], gen);
                hist.set(next);
                setMode(other);
                setMsg({ kind: 'success', text: t('editor.variantDone', { mode: t(`editor.mode.${other}`) }) });
              }}
            >
              {t('editor.genVariant', { mode: t(`editor.mode.${mode === 'light' ? 'dark' : 'light'}`) })}
            </Button>
            <Button onClick={() => navigator.clipboard?.writeText(exportTheme({ ...draft, name: current.name || draft.name })).then(() => setMsg({ kind: 'success', text: t('editor.copied') })).catch(() => undefined)}>{t('editor.export')}</Button>
            <Button onClick={() => setImportOpen(true)}>{t('editor.import')}</Button>
            {current.id && (
              <>
                <Badge>{t(`editor.status.${current.status}`)}</Badge>
                <Button onClick={() => void run(() => shareTheme(current.id!, current.status === 'private'), undefined).then(() => setCurrent((c) => ({ ...c, status: c.status === 'private' ? (store.themes.find((x) => x.id === c.id)?.status ?? 'pending') : 'private' })))}>
                  {current.status === 'private' ? t('editor.share') : t('editor.unshare')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    confirm(t('editor.deleteConfirm')) &&
                    void run(async () => {
                      await deleteTheme(current.id!);
                      load(BUILTIN_THEMES[0]!.id);
                    })
                  }
                >
                  {t('editor.delete')}
                </Button>
              </>
            )}
            {dirty && <Badge tone="warning">{t('editor.unsaved')}</Badge>}
          </div>
        </div>
      </Card>
      </Chrome>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Chrome className="flex flex-col gap-3">
          <Card>
            <div className="flex flex-col gap-2">
              <Tabs tabs={[{ id: 'light' as Mode, label: t('editor.mode.light') }, { id: 'dark' as Mode, label: t('editor.mode.dark') }]} value={mode} onChange={setMode} />
              <TextInput label={t('editor.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
              {!query && (
                <Tabs
                  tabs={[...CATEGORIES.map((c) => ({ id: c as TokenCategory | 'contrast' | 'palette' | 'admin', label: t(`token.category.${c}`) })), { id: 'palette' as const, label: t('editor.palette') }, { id: 'contrast' as const, label: `${t('editor.contrast')}${issues.length ? ` (${issues.length})` : ''}` }, ...(manageLocks ? [{ id: 'admin' as const, label: t('editor.locks') }] : [])]}
                  value={tab}
                  onChange={setTab}
                />
              )}
            </div>
          </Card>

          {(query || CATEGORIES.includes(tab as TokenCategory)) && (
            <Card
              title={query ? t('editor.results') : t(`token.category.${tab}`)}
              actions={
                !query ? (
                  <Button onClick={() => confirm(t('editor.resetCategoryConfirm')) && resetCategory(tab as TokenCategory)}>{t('editor.resetCategory')}</Button>
                ) : undefined
              }
            >
              <div className="flex flex-col gap-4">
                {visible.length === 0 && <p className="text-muted">{t('editor.noResults')}</p>}
                {visible.map((d) => {
                  const changed = baseValue(d) !== undefined ? value(d) !== baseValue(d) : value(d) !== d[mode];
                  return (
                    <div key={d.key} className="flex flex-col gap-1 border-b border-line pb-3">
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-sm">
                          {t(`token.${d.key}`)} {locked.has(d.key) && <Badge tone="warning">{t('editor.lockedBadge')}</Badge>}
                        </strong>
                        {changed && (
                          <Button onClick={() => resetToken(d)} title={t('editor.resetToken')}>
                            ↺
                          </Button>
                        )}
                      </div>
                      <TokenField def={d} value={value(d)} onChange={(v) => setValue(d, v)} />
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {!query && tab === 'palette' && <PaletteTool onApply={(pairs) => {
            const next = emptyTheme(draft);
            for (const [k, v] of Object.entries(pairs)) next[mode][k] = v;
            hist.set(next);
          }} base={value(TOKEN_DEFS.find((d) => d.key === 'color.primary')!)} />}

          {!query && tab === 'contrast' && (
            <Card title={t('editor.contrast')}>
              {issues.length === 0 ? (
                <p>{t('editor.contrastOk')}</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {issues.map((i, n) => (
                    <li key={n} className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">{t(`editor.mode.${i.mode}`)}</Badge>
                      <span>
                        {t(`token.${i.fg}`)} / {t(`token.${i.bg}`)}: {i.ratio.toFixed(2)} {t('editor.needed', { n: i.min })}
                      </span>
                      <Button
                        onClick={() => {
                          const toks = resolveTokens(draft, i.mode);
                          const shared = i.fg === 'color.onAction' || i.fg === 'color.onPrimary';
                          const next = emptyTheme(draft);
                          if (shared) next[i.mode][i.bg] = fixContrast(toks[i.bg]!, toks[i.fg]!, i.min);
                          else next[i.mode][i.fg] = fixContrast(toks[i.fg]!, toks[i.bg]!, i.min);
                          hist.set(next);
                        }}
                      >
                        {t('editor.fix')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted">{t('editor.contrastPairs', { n: CONTRAST_PAIRS.length })}</p>
            </Card>
          )}

          {!query && tab === 'admin' && manageLocks && <LockPanel />}
        </Chrome>

        <div className="flex flex-col gap-3">
          <Chrome>
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <Tabs tabs={[{ id: 'desktop' as const, label: t('editor.desktop') }, { id: 'mobile' as const, label: t('editor.mobile') }]} value={device} onChange={setDevice} />
              <Select label={t('editor.colorBlind')} value={cb} onChange={(e) => setCb(e.target.value as 'none' | ColorBlindKind)}>
                <option value="none">{t('editor.cb.none')}</option>
                {CB_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`editor.cb.${k}`)}
                  </option>
                ))}
              </Select>
              {compare && <Badge tone="warning">{t('editor.comparing')}</Badge>}
            </div>
          </Card>
          </Chrome>
          <div className={`${device === 'mobile' ? 'mx-auto w-full max-w-sm' : ''} ${cb === 'none' ? '' : `tk-cb-${cb}`} rounded-md border border-line bg-bg p-3 text-text`} aria-label={t('editor.preview')}>
            <ThemePreview />
          </div>
        </div>
      </div>

      <Chrome>
        <ThemeGallery onEdit={(th) => loadCustom(th)} />
      </Chrome>

      {importOpen && (
        <Modal title={t('editor.import')} onClose={() => setImportOpen(false)}>
          <div className="flex flex-col gap-3">
            <textarea className="min-h-48 w-full rounded-sm border border-line bg-surface p-2 font-mono text-sm" aria-label={t('editor.importJson')} value={importText} onChange={(e) => setImportText(e.target.value)} />
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setImportText(await f.text());
              }}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setImportOpen(false)}>{t('table.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const r = importTheme(importText);
                  if (!r.ok) {
                    setMsg({ kind: 'error', text: t('editor.importInvalid') });
                    return;
                  }
                  const base = emptyTheme(r.theme);
                  setCurrent({ id: null, name: r.theme.name, base: emptyTheme({ ...r.theme, light: {}, dark: {} }), status: 'private' });
                  hist.reset(base);
                  setImportOpen(false);
                  setMsg({ kind: 'success', text: r.dropped.length ? t('editor.importDropped', { n: r.dropped.length }) : t('editor.imported') });
                }}
              >
                {t('editor.import')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** Návrh harmonické palety z jedné základní barvy. */
function PaletteTool({ base, onApply }: { base: string; onApply: (pairs: Record<string, string>) => void }) {
  const [kind, setKind] = useState<(typeof HARMONIES)[number]>('triadic');
  const [seed, setSeed] = useState(base);
  const colors = harmony(seed, kind);
  const targets = ['color.primary', 'color.secondary', 'color.accent', 'color.info'];
  return (
    <Card title={t('editor.palette')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('editor.paletteHelp')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm">
            {t('editor.paletteBase')}
            <input type="color" className="h-9 w-14 rounded-sm border border-line" value={seed.slice(0, 7)} onChange={(e) => setSeed(e.target.value)} />
          </label>
          <Select label={t('editor.paletteKind')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {HARMONIES.map((h) => (
              <option key={h} value={h}>
                {t(`editor.harmony.${h}`)}
              </option>
            ))}
          </Select>
        </div>
        <ul className="flex flex-wrap gap-2">
          {colors.map((c, i) => (
            <li key={c + i} className="flex flex-col items-center gap-1 text-xs">
              <span className="block h-12 w-16 rounded-sm border border-line" aria-label={c} ref={(el) => el?.style.setProperty('background-color', c)} />
              <span className="font-mono">{c}</span>
            </li>
          ))}
        </ul>
        <Button onClick={() => onApply(Object.fromEntries(colors.slice(0, targets.length).map((c, i) => [targets[i]!, c])))}>{t('editor.paletteApply')}</Button>
      </div>
    </Card>
  );
}

/** Zamykání prvků vzhledu (jen s oprávněním): zamčené tokeny motivy nepřepíší. */
function LockPanel() {
  const store = useThemeStore();
  const [sel, setSel] = useState<string[]>(store.locked);
  const [msg, setMsg] = useState('');
  return (
    <Card title={t('editor.locks')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('editor.locksHelp')}</p>
        <ul className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
          {TOKEN_DEFS.filter((d) => d.type !== 'image').map((d) => (
            <li key={d.key}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sel.includes(d.key)} onChange={(e) => setSel(e.target.checked ? [...sel, d.key] : sel.filter((x) => x !== d.key))} />
                {t(`token.${d.key}`)}
              </label>
            </li>
          ))}
        </ul>
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await lockTokens(sel);
              setMsg(t('editor.locksSaved'));
            } catch (e) {
              setMsg(errorText(e));
            }
          }}
        >
          {t('editor.save')}
        </Button>
        {msg && <Notice>{msg}</Notice>}
      </div>
    </Card>
  );
}
