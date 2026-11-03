import { t } from '@kb/shared';
import { saveUserSetting, useSettings } from './settings';
import { createPortal } from 'react-dom';
import { isNumericColumn, sortTableRows, type SortDir } from './sort';
import { foldScope, useFold } from './fold-state';
import { useLocation } from './router';
import { createContext, Children, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary border-primary',
  secondary: 'bg-surface text-text border-line',
  danger: 'bg-danger text-on-primary border-danger',
  ghost: 'bg-transparent text-text border-transparent underline',
};

export function Button({ variant = 'secondary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={`kd-btn rounded-md border font-medium disabled:opacity-50 ${VARIANT[variant]} ${className}`} />;
}

/**
 * Enter nebo mezerník, který má potvrdit nabídku: ne při psaní do textu, výběru či tlačítka (to má vlastní chování) a ne s modifikátory.
 * Enter se navíc nebere v poli uvnitř formuláře, který se odešle sám.
 */
export function isConfirmKey(e: KeyboardEvent): boolean {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return false;
  if (tag === 'INPUT') {
    if (e.key === ' ' || el?.closest('form')) return false;
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') return false;
  }
  return true;
}

export const inputClass = 'w-full rounded-sm border border-line bg-surface px-2 py-1 text-text';

/** Popisek + pole + chyba. Pole je propojené s popiskem a chybou kvůli čtečkám. */
export function Field({ label, error, hint, fill, children }: { label: string; error?: string; hint?: string; /** Pole vyplní zbytek výšky okna (okno s nastavitelnou velikostí). */ fill?: boolean; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const msgId = error || hint ? `${id}-msg` : undefined;
  return (
    <div className={`flex flex-col gap-1 ${fill ? 'min-h-0 flex-1' : ''}`}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children(id, msgId)}
      {error ? (
        <p id={msgId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, error, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!error} className={inputClass} {...p} />}</Field>;
}

export function TextArea({ label, error, hint, fill, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string; fill?: boolean }) {
  return <Field label={label} error={error} hint={hint} fill={fill}>{(id, d) => <textarea id={id} aria-describedby={d} className={`${inputClass} min-h-24 ${fill ? 'flex-1 resize-none' : ''}`} {...p} />}</Field>;
}

export function Select({ label, error, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string }) {
  return <Field label={label} error={error}>{(id, d) => <select id={id} aria-describedby={d} className={inputClass} {...p}>{children}</select>}</Field>;
}

/** Uvnitř oken (dialogů) se karty nezabalují: okno je krátkodobé a skládá se z jednoho celku. */
const NoFold = createContext(false);

/** Identifikátor zabalitelné karty: stránka + název, nebo výslovně zadaný `foldId` (když se název mění, např. s počtem). */
function useFoldId(title: string | undefined, foldId?: string): string {
  const { path } = useLocation();
  return foldId ?? `${foldScope(path)}|${title ?? ''}`;
}

/**
 * Karta s nadpisem. Karta s nadpisem se dá zabalit klepnutím na nadpis a volba se pamatuje v osobním nastavení
 * (pro typ zařízení). `defaultOpen` je stav, dokud si hráč nezvolí jinak; `summary` se ukazuje v hlavičce zabalené karty.
 */
export function Card({ title, children, actions, foldId, defaultOpen = true, summary, foldable = true }: { title?: string; children: ReactNode; actions?: ReactNode; foldId?: string; defaultOpen?: boolean; summary?: ReactNode; foldable?: boolean }) {
  const inModal = useContext(NoFold);
  const id = useFoldId(title, foldId);
  const [open, setOpen] = useFold(id, defaultOpen);
  const folds = foldable && !!title && !inModal;
  return (
    <section className="kd-card rounded-lg border border-line bg-surface">
      {(title || actions) && (
        <header className={`${folds && !open ? '' : 'mb-3'} flex items-center justify-between gap-2`}>
          {title &&
            (folds ? (
              <h2 className="min-w-0 flex-1 font-heading text-lg font-bold">
                <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left font-heading font-bold">
                  <span aria-hidden="true" className="w-4 shrink-0 text-muted">{open ? '▾' : '▸'}</span>
                  <span>{title}</span>
                  {!open && summary && <span className="min-w-0 text-sm font-normal text-muted">{summary}</span>}
                </button>
              </h2>
            ) : (
              <h2 className="font-heading text-lg font-bold">{title}</h2>
            ))}
          {actions}
        </header>
      )}
      <div hidden={folds && !open}>{children}</div>
    </section>
  );
}

/**
 * Zabalitelný oddíl pro vedlejší obsah (místo prvku `<details>`): volba se pamatuje, výchozí stav je zabaleno.
 * Obsah zůstává v dokumentu i zabalený, takže se nezahodí rozepsaný text.
 */
export function Fold({ title, children, foldId, defaultOpen = false, summary, className = '', small = false }: { title: ReactNode; children: ReactNode; foldId?: string; defaultOpen?: boolean; summary?: ReactNode; className?: string; /** Menší nadpis (vedlejší oddíl uvnitř karty). */ small?: boolean }) {
  const id = useFoldId(typeof title === 'string' ? title : undefined, foldId);
  const [open, setOpen] = useFold(id, defaultOpen);
  return (
    <section className={`rounded-md border border-line bg-surface ${className}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center px-4 py-3 gap-x-3 gap-y-1 text-left">
        <span aria-hidden="true" className="w-4 shrink-0 text-muted">{open ? '▾' : '▸'}</span>
        <span className={small ? 'text-sm font-semibold' : 'font-heading text-lg font-bold'}>{title}</span>
        {!open && summary && <span className="min-w-0 text-sm text-muted">{summary}</span>}
      </button>
      <div hidden={!open} className="px-4 pb-4">
        {children}
      </div>
    </section>
  );
}

/**
 * Chybová hláška nad vším (i nad dialogy): plovoucí lišta dole uprostřed, vykreslená do body, aby ji neschovalo
 * okno přes celou obrazovku. Zavře se křížkem nebo po chvíli.
 */
export function ErrorToast({ message, onClose, seconds = 10 }: { message: string; onClose: () => void; seconds?: number }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => closeRef.current(), seconds * 1000);
    return () => window.clearTimeout(id);
  }, [message, seconds]);
  if (!message) return null;
  return createPortal(
    <div role="alert" className="fixed inset-x-2 bottom-4 z-[70] mx-auto flex max-w-lg items-start gap-2 rounded-md border-2 border-danger bg-surface px-3 py-2 text-danger shadow-lg">
      <span className="flex-1">{message}</span>
      <button type="button" className="rounded-md px-1" aria-label={t('table.close')} onClick={onClose}>
        ✕
      </button>
    </div>,
    document.body,
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const cls = kind === 'error' ? 'border-danger text-danger' : kind === 'success' ? 'border-success text-success' : kind === 'warning' ? 'border-warning text-text' : 'border-line text-text';
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-md border bg-surface px-3 py-2 ${cls}`}>
      {children}
    </p>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'primary' | 'danger' | 'success' | 'warning' }) {
  const cls = { muted: 'bg-raised text-muted', primary: 'bg-primary text-on-primary', danger: 'bg-danger text-on-primary', success: 'bg-success text-on-primary', warning: 'bg-warning text-on-primary' }[tone];
  return <span className={`inline-block rounded-sm px-2 text-xs ${cls}`}>{children}</span>;
}

/** Změnilo se okno od zapamatovaných rozměrů víc než o drobnost (obyčejné klepnutí nic neukládá)? */
const sizeChanged = (el: HTMLElement, from: { w: number; h: number } | null) => !!from && (Math.abs(el.offsetWidth - from.w) > 3 || Math.abs(el.offsetHeight - from.h) > 3);

/** Dialog s ovládáním klávesnicí (Esc zavře) a návratem zaměření. */
/** Rozměry okna z osobního nastavení (mimo JSX, styl nemá obsahovat pevné hodnoty). */
function sizeStyle(w: number, h: number): CSSProperties | undefined {
  if (!(w > 0) && !(h > 0)) return undefined;
  const style: CSSProperties = {};
  if (w > 0) {
    style.width = w + 'px';
    style.maxWidth = '100%';
  }
  if (h > 0) {
    style.height = h + 'px';
    style.maxHeight = '100%';
  }
  return style;
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Tab a Shift+Tab krouží jen po prvcích uvnitř okna (fokus neuteče na stránku pod ním). */
function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && root.contains(active) && active !== root;
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

// Kolik oken je právě otevřených: stránka pod nimi (#root) je pro čtečky i klávesnici neaktivní, dokud se nezavře poslední.
let openModals = 0;

/** Označí aplikaci pod okny jako neaktivní (`inert`); vrací funkci, která ji po zavření okna zase uvolní. */
function inertAppRoot(): () => void {
  const root = document.getElementById('root');
  if (!root || !('inert' in root)) return () => undefined;
  if (++openModals === 1) root.inert = true;
  return () => {
    if (--openModals === 0) root.inert = false;
  };
}

/**
 * Přepínání výběru v oknech s volbou kurzorovými šipkami (Tab funguje sám): šipky vlevo/nahoru a vpravo/dolů posouvají fokus
 * mezi tlačítky uvnitř `ref`. Když v okně zatím nic nemá fokus, první šipka zaměří hlavní (výrazné) tlačítko.
 * Nereaguje při psaní do polí, u posuvníků ani s modifikátory.
 */
export function useArrowChoices(ref: { current: HTMLElement | null }, enabled = true, selector = 'button:not(:disabled)', maxItems = 6): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const root = ref.current;
      if (!root) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const items = [...root.querySelectorAll<HTMLElement>(selector)];
      // Jen okna s malou volbou; velké okna s mnoha tlačítky si šipky nechají pro posouvání.
      if (items.length === 0 || items.length > maxItems) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      let next: HTMLElement | undefined;
      if (at < 0) next = items.find((x) => x.classList.contains('bg-primary')) ?? items[forward ? 0 : items.length - 1];
      else next = items[(at + (forward ? 1 : -1) + items.length) % items.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref, enabled, selector, maxItems]);
}

export function Modal({ title, onClose, children, dirty = false, wide = false, fit = false, page = false, sizeKey }: { title: string; onClose: () => void; children: ReactNode; /** Neuložené změny: zavření se potvrzuje. */ dirty?: boolean; /** Širší okno pro tabulky. */ wide?: boolean; /** Okno se přizpůsobí šířce obsahu (tabulka se vejde bez posuvníku), nejvýš do šířky okna prohlížeče. */ fit?: boolean; /** Místo okna celá obrazovka s tlačítkem Zpět (formuláře nastavení: využijí všechno místo). */ page?: boolean; /** Okno má nastavitelnou velikost (tažení za pravý dolní roh); rozměry se pamatují v osobním nastavení `<klíč>Width` a `<klíč>Height`. */ sizeKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useArrowChoices(ref);
  const values = useSettings().values;
  const storedW = sizeKey ? Number(values[`${sizeKey}Width`] ?? 0) : 0;
  const storedH = sizeKey ? Number(values[`${sizeKey}Height`] ?? 0) : 0;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const close = () => {
    if (dirtyRef.current && !confirm(t('modal.discardConfirm'))) return;
    closeRef.current();
  };
  // onClose bývá nová funkce při každém překreslení; efekt běží jen při otevření, jinak by se okno
  // při každé obnově dat znovu zaměřilo a odrolovalo na začátek (na telefonu „vyhazovalo nahoru“).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const releaseInert = inertAppRoot();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Tab') trapTab(e, ref.current);
      else if (isConfirmKey(e)) {
        // Enter nebo mezerník potvrdí hlavní (výrazné) tlačítko okna, pokud se právě nepíše do pole a nic jiného nemá fokus.
        const ok = ref.current?.querySelector<HTMLButtonElement>('button.bg-primary:not(:disabled)');
        if (ok) {
          e.preventDefault();
          ok.click();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      releaseInert();
      prev?.focus?.();
    };
  }, []);
  // Změna velikosti tažením za roh: po puštění myši se nové rozměry uloží, ale jen když se okno od stisknutí opravdu změnilo
  // (obyčejné klepnutí do okna nic neukládá). U dotyku to pozná pozorovatel velikosti po chvíli klidu.
  const down = useRef<{ w: number; h: number } | null>(null);
  const saveSize = () => {
    const el = ref.current;
    if (!sizeKey || !el) return;
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    void saveUserSetting(`${sizeKey}Width`, w).catch(() => undefined);
    void saveUserSetting(`${sizeKey}Height`, h).catch(() => undefined);
  };
  // Pozorovatel velikosti běží po celou dobu okna; volá vždy aktuální uložení přes ref, ne tu z prvního vykreslení.
  const saveSizeRef = useRef(saveSize);
  saveSizeRef.current = saveSize;
  const changedSince = (from: { w: number; h: number } | null) => !!ref.current && sizeChanged(ref.current, from);
  useEffect(() => {
    const el = ref.current;
    if (!sizeKey || !el || typeof ResizeObserver === 'undefined') return;
    let first = true;
    let timer = 0;
    let base: { w: number; h: number } | null = null;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        base = { w: el.offsetWidth, h: el.offsetHeight };
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (sizeChanged(el, base)) {
          base = { w: el.offsetWidth, h: el.offsetHeight };
          saveSizeRef.current();
        }
      }, 600);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [sizeKey]);
  if (page)
    return createPortal(
      <div className="fixed inset-0 z-50 overflow-auto bg-bg" role="presentation">
        <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="kd-modal mx-auto flex min-h-full w-full max-w-6xl flex-col gap-3 bg-surface">
          <div className="flex items-center gap-3">
            <button type="button" className="rounded-md border border-line bg-surface px-3 py-1" onClick={close}>
              {t('modal.back')}
            </button>
            <h2 className="font-heading text-lg font-bold">{title}</h2>
          </div>
          <NoFold.Provider value={true}>{children}</NoFold.Provider>
        </div>
      </div>,
      document.body,
    );
  // Okno se vykresluje přímo do <body>: uvnitř stolu (kontejner s containment) by `position: fixed` platilo jen vůči stolu a okno by se smrštilo.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onMouseDown={() => (down.current = ref.current ? { w: ref.current.offsetWidth, h: ref.current.offsetHeight } : null)} onMouseUp={() => changedSince(down.current) && saveSize()} style={sizeKey ? sizeStyle(storedW, storedH) : undefined} className={`max-h-full ${sizeKey ? 'w-[32rem] max-w-full' : fit ? 'w-fit max-w-full' : `w-full ${wide ? 'max-w-4xl' : 'max-w-lg'}`} kd-modal overflow-auto rounded-lg border border-line bg-surface shadow-lg ${sizeKey ? 'flex min-h-48 min-w-64 resize flex-col' : ''}`}>
        <h2 className="mb-3 font-heading text-lg font-bold">{title}</h2>
        <NoFold.Provider value={true}>{sizeKey ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}</NoFold.Provider>
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)} className={`rounded-md border border-line px-3 py-1 ${tab.id === value ? 'bg-primary text-on-primary' : 'bg-surface text-text'}`}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p role="status" className="text-muted">
      {label}
    </p>
  );
}

/**
 * Jednoduchá tabulka s hlavičkou; buňky dodá volající. Textové záhlaví jde kliknutím řadit podle sloupce (číselně, podle data nebo česky podle abecedy;
 * druhý klik obrátí směr). Tabulka s pevným pořadím (úrovně, výplaty…) vypne řazení přes `sortable={false}`.
 */
export function DataTable({ head, children, sortable = true }: { head: ReactNode[]; children: ReactNode; sortable?: boolean }) {
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const rowCount = Children.count(children);
  const canSort = sortable && rowCount > 1 && sortTableRows(children, 0, 'asc') !== null;
  const rows = canSort && sort ? (sortTableRows(children, sort.col, sort.dir) ?? children) : children;
  const click = (col: number) => setSort((s) => (s?.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: isNumericColumn(children, col) ? 'desc' : 'asc' }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={typeof h === 'string' ? `${i}:${h}` : i} className="kd-cell border-b border-line font-medium text-muted">
                {canSort && typeof h === 'string' && h.trim() !== '' ? (
                  <button className="underline decoration-dotted" onClick={() => click(i)} aria-label={t('cashier.ledger.sortBy', { col: h })}>
                    {h}
                    {sort?.col === i ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                ) : (
                  h
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className = '', colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => (
  <td className={`kd-cell border-b border-line align-top ${className}`} colSpan={colSpan}>
    {children}
  </td>
);

/**
 * Číselné pole, které při psaní nevnucuje nulu: dokud je pole prázdné nebo rozepsané, drží si text,
 * hodnotu předá až když je to platné číslo; po opuštění prázdného pole se vrátí poslední hodnota.
 * S `min`/`max` se hodnota při opuštění pole ořízne do rozsahu (mimo rozsah se nikdy nepředá dál).
 */
export function NumInput({ value, onChange, className = '', ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const lo = p.min !== undefined && p.min !== '' ? Number(p.min) : -Infinity;
  const hi = p.max !== undefined && p.max !== '' ? Number(p.max) : Infinity;
  const clamp = (n: number) => Math.max(lo, Math.min(hi, n));
  return (
    <input
      {...p}
      type="number"
      // Zadaná šířka (w-24…) nahradí výchozí celou šířku; jinak by obě platily a pole by roztáhlo řádek na úkor posuvníku vedle něj.
      className={`${/(^| )w-/.test(className) ? inputClass.replace('w-full ', '') + ' shrink-0' : inputClass} font-mono ${className}`}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        p.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        const n = Number(text);
        if (text.trim() === '' || !Number.isFinite(n)) setText(String(value));
        else if (clamp(n) !== n) {
          setText(String(clamp(n)));
          onChange(clamp(n));
        }
        p.onBlur?.(e);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (v.trim() !== '' && Number.isFinite(Number(v))) onChange(clamp(Number(v)));
      }}
    />
  );
}
