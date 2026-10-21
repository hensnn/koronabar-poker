import { useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, post } from '../../api';
import { BrandMark, refreshBrand, useBrand } from '../../brand';
import { saveGlobalSetting, useSettings } from '../../settings';
import { Button, Card, Notice, NumInput, Select } from '../../ui';

const toBase64 = (buf: ArrayBuffer) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

type AssetKey = 'branding.logoAssetId' | 'branding.logoDarkAssetId' | 'branding.loginBgAssetId';

/** Jedno místo pro nahraný obrázek (logo, logo pro tmavý režim, pozadí přihlášení): nahrát, nahradit, odebrat. */
function AssetSlot({ settingKey, title, help, present, run, busy }: { settingKey: AssetKey; title: string; help?: string; present: boolean; run: (fn: () => Promise<void>, ok: string) => Promise<void>; busy: boolean }) {
  const settings = useSettings();
  const current = String(settings.values[settingKey] ?? '');
  const upload = (file: File) =>
    run(async () => {
      const r = await post<{ id: string }>('/api/theme-assets', { kind: 'brand', data: toBase64(await file.arrayBuffer()) });
      await saveGlobalSetting(settingKey, r.id);
      if (current) void del(`/api/theme-assets/${current}`).catch(() => undefined);
    }, t('logo.saved'));
  const remove = () =>
    run(async () => {
      await saveGlobalSetting(settingKey, '');
      if (current) await del(`/api/theme-assets/${current}`).catch(() => undefined);
    }, t('logo.removed'));
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-bold">{title}</h3>
      {help && <p className="text-sm text-muted">{help}</p>}
      {present && <img src={`/api/theme-assets/${current}`} alt={title} className="max-h-24 max-w-64 rounded-sm border border-line bg-surface object-contain" />}
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-line bg-surface px-3 py-1 text-sm">
          {busy ? t('editor.image.uploading') : present ? t('logo.replace') : t('logo.upload')}
          <input
            type="file"
            aria-label={title}
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
        {present && (
          <Button disabled={busy} onClick={() => void remove()}>
            {t('logo.remove')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Správa → Logo aplikace: logo (hlavní prvek hlavičky a přihlašovací stránky), varianta pro tmavý režim, velikost a pozadí přihlášení. */
export function LogoAdminPage() {
  const settings = useSettings();
  const brand = useBrand();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const percent = Number(settings.values['branding.logoHeightPercent'] ?? 100);
  const showName = settings.values['branding.showName'] !== false;
  const plate = settings.values['branding.darkPlate'] !== false;
  const bgMode = String(settings.values['branding.loginBackground'] ?? 'felt');
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
  const save = (key: string, value: string | number | boolean) => run(() => saveGlobalSetting(key, value), t('logo.saved'));
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('logo.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('logo.help')}</p>
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <div className="flex flex-wrap gap-3">
            <div className="rounded-md border border-line bg-surface p-3" aria-label={t('logo.preview')}>
              <BrandMark link={false} />
            </div>
            <div data-mode="dark" className="rounded-md border border-line bg-bg p-3 text-text" aria-label={t('logo.previewDark')}>
              <BrandMark link={false} />
            </div>
          </div>
          <AssetSlot settingKey="branding.logoAssetId" title={t('logo.slotMain')} present={!!brand?.logo} run={run} busy={busy} />
          <span className="text-xs text-muted">{t('logo.hint')}</span>
          <AssetSlot settingKey="branding.logoDarkAssetId" title={t('logo.slotDark')} help={t('logo.slotDarkHelp')} present={!!brand?.logoDark} run={run} busy={busy} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={plate} disabled={busy} onChange={(e) => void save('branding.darkPlate', e.target.checked)} />
            {t('logo.darkPlate')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={showName} disabled={busy} onChange={(e) => void save('branding.showName', e.target.checked)} />
            {t('logo.showName')}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('logo.size')}
            <div className="flex items-center gap-2">
              <input type="range" aria-label={t('logo.size')} min={40} max={400} step={10} value={percent} disabled={busy} onChange={(e) => void save('branding.logoHeightPercent', Number(e.target.value))} className="flex-1" />
              <NumInput className="w-24" min={40} max={400} value={percent} onChange={(n) => void save('branding.logoHeightPercent', Math.min(400, Math.max(40, n)))} />
              <span className="text-muted">%</span>
            </div>
          </label>
        </div>
      </Card>
      <Card title={t('logo.loginTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('logo.loginHelp')}</p>
          <Select label={t('logo.loginMode')} value={bgMode} disabled={busy} onChange={(e) => void save('branding.loginBackground', e.target.value)}>
            {(['felt', 'plain', 'image'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`settings.branding.loginBackground.option.${m}`)}
              </option>
            ))}
          </Select>
          {bgMode === 'image' && <AssetSlot settingKey="branding.loginBgAssetId" title={t('logo.slotBg')} present={!!brand?.loginBg} run={run} busy={busy} />}
        </div>
      </Card>
    </div>
  );
}
