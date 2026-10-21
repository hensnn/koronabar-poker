import { useEffect, useState } from 'react';
import { LOGIN_BACKGROUNDS, LOGIN_DEFAULTS, LOGIN_PLACEMENTS, LOGIN_PLATES, LOGIN_POSITIONS, LOGIN_TONES, LOGIN_WIDTHS, loginLayoutOf, t } from '@kb/shared';
import { del, errorText, post } from '../../api';
import { BrandMark, refreshBrand, useBrand } from '../../brand';
import { saveGlobalSetting, useSettings } from '../../settings';
import { Button, Card, Notice, NumInput, Select, TextInput } from '../../ui';
import { LoginFrame } from '../login-frame';

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
  const darkMode = String(settings.values['branding.darkLogoMode'] ?? 'invert');
  const headerMode = String(settings.values['branding.headerMode'] ?? 'logo');
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
          <Select label={t('settings.branding.darkLogoMode.label')} value={darkMode} disabled={busy} onChange={(e) => void save('branding.darkLogoMode', e.target.value)}>
            {(['invert', 'plate', 'none'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`settings.branding.darkLogoMode.option.${m}`)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">{t('settings.branding.darkLogoMode.help')}</p>
          <Select label={t('settings.branding.headerMode.label')} value={headerMode} disabled={busy} onChange={(e) => void save('branding.headerMode', e.target.value)}>
            {(['logo', 'name', 'none'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`settings.branding.headerMode.option.${m}`)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">{t('settings.branding.headerMode.help')}</p>
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
      <LoginSettingsCard busy={busy} run={run} save={save} />
    </div>
  );
}

type Save = (key: string, value: string | number | boolean) => Promise<void>;

const optionLabel = (key: string, v: string): string => t(`settings.${key}.option.${v}`);

/** Vzhled přihlašovací stránky: samostatná nastavení (velikost a umístění loga, pozadí, poloha a šířka karty, uvítací text) a živý náhled. */
function LoginSettingsCard({ busy, run, save }: { busy: boolean; run: (fn: () => Promise<void>, ok: string) => Promise<void>; save: Save }) {
  const settings = useSettings();
  const brand = useBrand();
  const v = settings.values;
  const layout = loginLayoutOf(v);
  const [tagline, setTagline] = useState(layout.tagline);
  useEffect(() => setTagline(layout.tagline), [layout.tagline]);
  const select = (key: string, list: readonly string[], value: string, label?: string) => (
    <Select label={label ?? t(`settings.${key}.label`)} value={value} disabled={busy} onChange={(e) => void save(key, e.target.value)}>
      {list.map((m) => (
        <option key={m} value={m}>
          {optionLabel(key, m)}
        </option>
      ))}
    </Select>
  );
  const slider = (key: string, value: number, min: number, max: number, step: number, unit: string) => (
    <label className="flex flex-col gap-1 text-sm">
      {t(`settings.${key}.label`)}
      <div className="flex items-center gap-2">
        <input type="range" aria-label={t(`settings.${key}.label`)} min={min} max={max} step={step} value={value} disabled={busy} onChange={(e) => void save(key, Number(e.target.value))} className="flex-1" />
        <NumInput className="w-20" min={min} max={max} value={value} onChange={(n) => void save(key, Math.min(max, Math.max(min, n)))} />
        <span className="text-muted">{unit}</span>
      </div>
    </label>
  );
  const image = layout.background === 'image';
  return (
    <Card title={t('logo.loginSection')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('logo.loginSectionHelp')}</p>
        <div aria-label={t('logo.loginPreview')}>
          <LoginFrame preview layout={layout} bgImage={brand?.loginBg ?? null} title={t('logo.loginPreviewTitle')}>
            <div className="flex flex-col gap-2">
              <TextInput label={t('auth.nickname')} readOnly tabIndex={-1} value="" />
              <TextInput label={t('auth.password')} readOnly tabIndex={-1} type="password" value="" />
            </div>
          </LoginFrame>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {select('branding.loginBackground', LOGIN_BACKGROUNDS, layout.background)}
          {layout.background !== 'plain' && layout.background !== 'image' && select('login.bgTone', LOGIN_TONES, layout.bgTone)}
          {select('login.logoPlacement', LOGIN_PLACEMENTS, layout.logoPlacement)}
          {select('login.logoPlate', LOGIN_PLATES, layout.logoPlate)}
          {select('login.cardPosition', LOGIN_POSITIONS, layout.cardPosition)}
          {select('login.cardWidth', LOGIN_WIDTHS, layout.cardWidth)}
        </div>
        {image && <AssetSlot settingKey="branding.loginBgAssetId" title={t('logo.slotBg')} present={!!brand?.loginBg} run={run} busy={busy} />}
        {image && (
          <div className="grid gap-3 sm:grid-cols-2">
            {slider('login.bgOverlayPercent', layout.bgOverlayPercent, 0, 90, 5, '%')}
            {slider('login.bgBlur', layout.bgBlur, 0, 20, 1, '')}
          </div>
        )}
        {layout.logoPlacement !== 'none' && slider('login.logoSizePercent', layout.logoSizePercent, 40, 400, 10, '%')}
        {layout.logoPlacement !== 'none' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={layout.showName} disabled={busy} onChange={(e) => void save('login.showName', e.target.checked)} />
            {t('settings.login.showName.label')}
          </label>
        )}
        <TextInput
          label={t('settings.login.tagline.label')}
          hint={t('settings.login.tagline.help')}
          value={tagline}
          maxLength={120}
          onChange={(e) => setTagline(e.target.value)}
          onBlur={() => tagline.trim() !== layout.tagline && void save('login.tagline', tagline.trim())}
        />
        <div>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const d = LOGIN_DEFAULTS;
                const pairs: [string, string | number | boolean][] = [['branding.loginBackground', d.background], ['login.logoSizePercent', d.logoSizePercent], ['login.logoPlacement', d.logoPlacement], ['login.showName', d.showName], ['login.logoPlate', d.logoPlate], ['login.bgTone', d.bgTone], ['login.bgOverlayPercent', d.bgOverlayPercent], ['login.bgBlur', d.bgBlur], ['login.cardPosition', d.cardPosition], ['login.cardWidth', d.cardWidth], ['login.tagline', d.tagline]];
                for (const [k, val] of pairs) await saveGlobalSetting(k, val);
                setTagline(d.tagline);
              }, t('logo.saved'))
            }
          >
            {t('logo.loginReset')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
