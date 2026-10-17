import { t } from '@kb/shared';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary border-primary',
  secondary: 'bg-surface text-text border-line',
  danger: 'bg-danger text-on-primary border-danger',
  ghost: 'bg-transparent text-text border-transparent underline',
};

export function Button({ variant = 'secondary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={`rounded-md border px-3 py-1 font-medium disabled:opacity-50 ${VARIANT[variant]} ${className}`} />;
}

export const inputClass = 'w-full rounded-sm border border-line bg-surface px-2 py-1 text-text';

/** Popisek + pole + chyba. Pole je propojené s popiskem a chybou kvůli čtečkám. */
export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const msgId = error || hint ? `${id}-msg` : undefined;
  return (
    <div className="flex flex-col gap-1">
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

export function TextArea({ label, error, hint, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{(id, d) => <textarea id={id} aria-describedby={d} className={`${inputClass} min-h-24`} {...p} />}</Field>;
}

export function Select({ label, error, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string }) {
  return <Field label={label} error={error}>{(id, d) => <select id={id} aria-describedby={d} className={inputClass} {...p}>{children}</select>}</Field>;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="font-heading text-lg font-bold">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success'; children: ReactNode }) {
  const cls = kind === 'error' ? 'border-danger text-danger' : kind === 'success' ? 'border-success text-success' : 'border-line text-text';
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

/** Dialog s ovládáním klávesnicí (Esc zavře) a návratem zaměření. */
export function Modal({ title, onClose, children, dirty = false }: { title: string; onClose: () => void; children: ReactNode; /** Neuložené změny: zavření se potvrzuje. */ dirty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="max-h-full w-full max-w-lg overflow-auto rounded-lg border border-line bg-surface p-4 shadow-lg">
        <h2 className="mb-3 font-heading text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
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

/** Jednoduchá tabulka s hlavičkou; buňky dodá volající. */
export function DataTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-line px-2 py-1 font-medium text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => <td className={`border-b border-line px-2 py-1 align-top ${className}`}>{children}</td>;

/**
 * Číselné pole, které při psaní nevnucuje nulu: dokud je pole prázdné nebo rozepsané, drží si text,
 * hodnotu předá až když je to platné číslo; po opuštění prázdného pole se vrátí poslední hodnota.
 */
export function NumInput({ value, onChange, className = '', ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <input
      {...p}
      type="number"
      className={`${inputClass} font-mono ${className}`}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        p.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        if (text.trim() === '' || !Number.isFinite(Number(text))) setText(String(value));
        p.onBlur?.(e);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (v.trim() !== '' && Number.isFinite(Number(v))) onChange(Number(v));
      }}
    />
  );
}
