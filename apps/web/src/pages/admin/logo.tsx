import { useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, post } from '../../api';
import { BrandMark, refreshBrand, useBrand } from '../../brand';
import { saveGlobalSetting, useSettings } from '../../settings';
import { Button, Card, NumInput, Notice } from '../../ui';

const toBase64 = (buf: ArrayBuffer) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Správa → Logo aplikace: nahrání loga, které je hlavním prvkem hlavičky a přihlašovací stránky, a jeho velikost. */
export function LogoAdminPage() {
  const settings = useSettings();
  const brand = useBrand();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const current = String(settings.values['branding.logoAssetId'] ?? '');
  const percent = Number(settings.values['branding.logoHeightPercent'] ?? 100);
  const showName = settings.values['branding.showName'] !== false;
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await refreshBrand();
      setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File) =>
    run(async () => {
      const r = await post<{ id: string }>('/api/theme-assets', { kind: 'brand', data: toBase64(await file.arrayBuffer()) });
      const old = current;
      await saveGlobalSetting('branding.logoAssetId', r.id);
      if (old) void del(`/api/theme-assets/${old}`).catch(() => undefined);
    }, t('logo.saved'));
  const remove = () =>
    run(async () => {
      const old = current;
      await saveGlobalSetting('branding.logoAssetId', '');
      if (old) await del(`/api/theme-assets/${old}`).catch(() => undefined);
    }, t('logo.removed'));
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('logo.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('logo.help')}</p>
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <div className="rounded-md border border-line bg-surface p-3" aria-label={t('logo.preview')}>
            <BrandMark link={false} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="cursor-pointer rounded-md border border-line bg-surface px-3 py-1 text-sm">
              {busy ? t('editor.image.uploading') : brand?.logo ? t('logo.replace') : t('logo.upload')}
              <input
                type="file"
                aria-label={t('logo.upload')}
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
            {brand?.logo && (
              <Button disabled={busy} onClick={() => void remove()}>
                {t('logo.remove')}
              </Button>
            )}
          </div>
          <span className="text-xs text-muted">{t('logo.hint')}</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={showName} disabled={busy} onChange={(e) => void run(() => saveGlobalSetting('branding.showName', e.target.checked), t('logo.saved'))} />
            {t('logo.showName')}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('logo.size')}
            <div className="flex items-center gap-2">
              <input type="range" aria-label={t('logo.size')} min={40} max={400} step={10} value={percent} disabled={busy} onChange={(e) => void run(() => saveGlobalSetting('branding.logoHeightPercent', Number(e.target.value)), t('logo.saved'))} className="flex-1" />
              <NumInput className="w-24" min={40} max={400} value={percent} onChange={(n) => void run(() => saveGlobalSetting('branding.logoHeightPercent', Math.min(400, Math.max(40, n))), t('logo.saved'))} />
              <span className="text-muted">%</span>
            </div>
          </label>
        </div>
      </Card>
    </div>
  );
}
