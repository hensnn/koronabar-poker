import { useCallback, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { FONT_STACKS, RADIUS_ROUND, RADIUS_SQUARE, SHADOW_PRESETS, harmony, hexToHsl, hslToHex, isHexColor, parseColor, parsePx, rgbToHex, toPx, type HarmonyKind, type TokenDef } from '@kb/tokens';
import { del, errorText, post } from '../api';
import { Button, Notice, Select } from '../ui';

// ---------- historie změn (undo / redo) ----------

export interface History<T> {
  value: T;
  set: (v: T, group?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: (v: T) => void;
}

/** Zásobník změn; po sobě jdoucí úpravy téhož prvku do 700 ms se slučují do jednoho kroku. */
export function useHistory<T>(initial: T): History<T> {
  const [stack, setStack] = useState<{ items: T[]; index: number }>({ items: [initial], index: 0 });
  const last = useRef<{ group: string; at: number } | null>(null);
  const set = useCallback((v: T, group = '') => {
    const now = Date.now();
    setStack((s) => {
      const merge = group !== '' && last.current?.group === group && now - last.current.at < 700;
      last.current = { group, at: now };
      const items = s.items.slice(0, s.index + 1);
      if (merge) items[items.length - 1] = v;
      else items.push(v);
      const trimmed = items.slice(-100);
      return { items: trimmed, index: trimmed.length - 1 };
    });
  }, []);
  const undo = useCallback(() => {
    last.current = null;
    setStack((s) => ({ ...s, index: Math.max(0, s.index - 1) }));
  }, []);
  const redo = useCallback(() => {
    last.current = null;
    setStack((s) => ({ ...s, index: Math.min(s.items.length - 1, s.index + 1) }));
  }, []);
  const reset = useCallback((v: T) => {
    last.current = null;
    setStack({ items: [v], index: 0 });
  }, []);
  return { value: stack.items[stack.index]!, set, undo, redo, canUndo: stack.index > 0, canRedo: stack.index < stack.items.length - 1, reset };
}

// ---------- pole pro barvu ----------

const rgb6 = (hex: string) => {
  const { rgb } = parseColor(hex);
  return rgbToHex(rgb);
};

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

/** Výběr barvy: vzorník, HEX, průhlednost, RGB a HSL, kapátko (kde ho prohlížeč umí). */
export function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [hexText, setHexText] = useState(value);
  const parsed = (() => {
    try {
      return parseColor(value);
    } catch {
      return { rgb: { r: 0, g: 0, b: 0 }, alpha: 1 };
    }
  })();
  const hsl = hexToHsl(value);
  const Eye = (typeof window !== 'undefined' ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper : undefined) ?? null;
  const commit = (hex: string) => {
    setHexText(hex);
    onChange(hex);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input type="color" aria-label={label} className="h-9 w-12 cursor-pointer rounded-sm border border-line bg-surface" value={rgb6(value)} onChange={(e) => commit(rgbToHex(parseColor(e.target.value).rgb, parsed.alpha))} />
        <input
          aria-label={`${label} HEX`}
          className="w-28 rounded-sm border border-line bg-surface px-2 py-1 font-mono"
          value={hexText === value ? value : hexText}
          maxLength={9}
          onChange={(e) => {
            setHexText(e.target.value);
            if (isHexColor(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          onBlur={() => setHexText(value)}
        />
        {Eye && (
          <Button
            onClick={async () => {
              try {
                const r = await new Eye().open();
                commit(rgbToHex(parseColor(r.sRGBHex).rgb, parsed.alpha));
              } catch {
                /* zrušeno */
              }
            }}
          >
            {t('editor.eyedropper')}
          </Button>
        )}
        <label className="flex items-center gap-2 text-sm">
          {t('editor.alpha')}
          <input type="range" min={0} max={100} value={Math.round(parsed.alpha * 100)} onChange={(e) => commit(rgbToHex(parsed.rgb, Number(e.target.value) / 100))} />
        </label>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-muted">{t('editor.moreNotations')}</summary>
        <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
          {(['r', 'g', 'b'] as const).map((k) => (
            <label key={k} className="flex flex-col">
              {k.toUpperCase()}
              <input type="number" min={0} max={255} className="rounded-sm border border-line bg-surface px-2 py-1" value={parsed.rgb[k]} onChange={(e) => commit(rgbToHex({ ...parsed.rgb, [k]: Number(e.target.value) }, parsed.alpha))} />
            </label>
          ))}
          <label className="flex flex-col">
            H {Math.round(hsl.h)}°
            <input type="range" min={0} max={360} value={Math.round(hsl.h)} onChange={(e) => commit(hslToHex({ ...hsl, h: Number(e.target.value) }, parsed.alpha))} />
          </label>
          <label className="flex flex-col">
            S {Math.round(hsl.s)} %
            <input type="range" min={0} max={100} value={Math.round(hsl.s)} onChange={(e) => commit(hslToHex({ ...hsl, s: Number(e.target.value) }, parsed.alpha))} />
          </label>
          <label className="flex flex-col">
            L {Math.round(hsl.l)} %
            <input type="range" min={0} max={100} value={Math.round(hsl.l)} onChange={(e) => commit(hslToHex({ ...hsl, l: Number(e.target.value) }, parsed.alpha))} />
          </label>
        </div>
      </details>
    </div>
  );
}

// ---------- pole podle typu tokenu ----------

/** Vstup pro jeden token podle jeho typu (barva, délka, číslo, výčet, písmo, stín, text). */
export function TokenField({ def, value, onChange }: { def: TokenDef; value: string; onChange: (v: string) => void }) {
  const label = t(`token.${def.key}`);
  switch (def.type) {
    case 'color':
      return <ColorField value={value} onChange={onChange} label={label} />;
    case 'enum':
      return (
        <Select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          {def.options!.map((o) => (
            <option key={o} value={o}>
              {t(`token.${def.key}.option.${o}`)}
            </option>
          ))}
        </Select>
      );
    case 'number':
      return (
        <div className="flex items-center gap-2">
          <input type="range" aria-label={label} min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => onChange(String(Number(e.target.value)))} />
          <input type="number" aria-label={label} className="w-24 rounded-sm border border-line bg-surface px-2 py-1 font-mono" min={def.min} max={def.max} step={def.step} value={value} onChange={(e) => e.target.value !== '' && onChange(String(Number(e.target.value)))} />
        </div>
      );
    case 'length': {
      const px = parsePx(value);
      return (
        <div className="flex flex-wrap items-center gap-2">
          {px !== null && px <= 96 && <input type="range" aria-label={label} min={0} max={96} value={px} onChange={(e) => onChange(toPx(e.target.value))} />}
          <input aria-label={label} className="w-28 rounded-sm border border-line bg-surface px-2 py-1 font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
          {def.key.endsWith('adius') && (
            <>
              <Button onClick={() => onChange(RADIUS_SQUARE)}>{t('editor.radius.square')}</Button>
              <Button onClick={() => onChange(RADIUS_ROUND)}>{t('editor.radius.round')}</Button>
            </>
          )}
        </div>
      );
    }
    case 'font': {
      const known = FONT_STACKS.find((f) => f.value === value);
      return (
        <div className="flex flex-col gap-1">
          <Select label={label} value={known?.id ?? 'custom'} onChange={(e) => onChange(FONT_STACKS.find((f) => f.id === e.target.value)?.value ?? value)}>
            {FONT_STACKS.map((f) => (
              <option key={f.id} value={f.id}>
                {t(f.label)}
              </option>
            ))}
            {!known && <option value="custom">{t('editor.font.custom')}</option>}
          </Select>
        </div>
      );
    }
    case 'shadow': {
      const known = SHADOW_PRESETS.find((s) => s.value === value);
      return (
        <Select label={label} value={known ? known.value : 'custom'} onChange={(e) => e.target.value !== 'custom' && onChange(e.target.value)}>
          {SHADOW_PRESETS.map((s) => (
            <option key={s.value} value={s.value}>
              {t(s.label)}
            </option>
          ))}
          {!known && <option value="custom">{value}</option>}
        </Select>
      );
    }
    case 'text':
      return <input aria-label={label} className="w-full rounded-sm border border-line bg-surface px-2 py-1" maxLength={60} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'image':
      return <ImageField def={def} value={value} onChange={onChange} label={label} />;
  }
}

// ---------- pole pro obrázek ----------

const toBase64 = (buf: ArrayBuffer) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Nahrání obrázku motivu; hodnota tokenu je `asset:<id>`, obsah kontroluje server. */
function ImageField({ def, value, onChange, label }: { def: TokenDef; value: string; onChange: (v: string) => void; label: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const kind = def.key.replace('image.', '');
  const id = value.startsWith('asset:') ? value.slice(6) : '';
  const upload = async (file: File) => {
    setBusy(true);
    setErr('');
    try {
      const r = await post<{ id: string }>('/api/theme-assets', { kind, data: toBase64(await file.arrayBuffer()) });
      onChange(`asset:${r.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {id ? <img src={`/api/theme-assets/${id}`} alt={label} className="max-h-24 max-w-48 rounded-sm border border-line object-contain" /> : <span className="text-sm text-muted">{t('editor.image.none')}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-line bg-surface px-3 py-1 text-sm">
          {busy ? t('editor.image.uploading') : t('editor.image.upload')}
          <input
            type="file"
            aria-label={label}
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </label>
        {id && (
          <Button
            onClick={() => {
              onChange('none');
              void del(`/api/theme-assets/${id}`).catch(() => undefined);
            }}
          >
            {t('editor.image.remove')}
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">{t('editor.image.hint')}</span>
      {err && <Notice kind="error">{err}</Notice>}
    </div>
  );
}

export const HARMONIES: HarmonyKind[] = ['complementary', 'analogous', 'triadic', 'splitComplementary', 'tetradic'];
export { harmony };
