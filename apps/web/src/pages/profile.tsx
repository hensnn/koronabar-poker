import { useMemo, useState } from 'react';
import { Link } from '../router';
import { SoundLibrary } from './sounds';
import { checkContrast, resolveTokens } from '@kb/tokens';
import { useThemes } from '../theme/ThemeProvider';
import { t, type SettingValue } from '@kb/shared';
import { errorText, post } from '../api';
import { logout, useSession } from '../session';
import { deviceId, deviceKindOverride, setDeviceKindOverride, registry, resetUserSetting, saveUserSetting, useSettings } from '../settings';
import { SettingsForm } from '../settings/SettingsForm';
import { Button, Card, Notice, Tabs, TextArea, TextInput } from '../ui';
import { Guide } from './guide';
import { LimitsSection } from './limits';
import { useFeatures } from '../features';
import { NotesSection } from './notes';
import { TokensSection } from './tokens';
import { InstallCard } from '../pwa';
import { SettingsShare } from '../settings-share';
import { LookTitle, Trophies } from '../cosmetics-client';

export function ProfilePage() {
  const { me } = useSession();
  const features = useFeatures();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [mail, setMail] = useState({ password: '', email: '' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string; where: 'pw' | 'mail' } | null>(null);
  if (!me) return null;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('profile.title')}</h1>
      <Card>
        <p>
          <strong>{me.user.nickname}</strong> <LookTitle userId={me.user.id} /> <Trophies userId={me.user.id} /> · {me.user.email}
        </p>
        <p className="text-sm text-muted">{me.user.emailVerified ? t('profile.verified') : t('profile.unverified')}</p>
      </Card>
      {features.limits && <LimitsSection />}
      <NotesSection />
      <Card title={t('pwa.install')}>
        <InstallCard />
      </Card>
      <TokensSection />
      <Card title={t('profile.changePassword')}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/change-password', pw);
              setPw({ current: '', next: '' });
              setMsg({ kind: 'success', text: t('profile.passwordChanged'), where: 'pw' });
            } catch (er) {
              setMsg({ kind: 'error', text: errorText(er), where: 'pw' });
            }
          }}
        >
          <TextInput label={t('profile.currentPassword')} type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required />
          <TextInput label={t('auth.newPassword')} type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" required />
          {msg?.where === 'pw' && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <Button variant="primary" type="submit">
            {t('profile.changePassword')}
          </Button>
        </form>
      </Card>
      <Card title={t('profile.changeEmail')}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/change-email', mail);
              setMail({ password: '', email: '' });
              setMsg({ kind: 'success', text: t('profile.emailRequested'), where: 'mail' });
            } catch (er) {
              setMsg({ kind: 'error', text: errorText(er), where: 'mail' });
            }
          }}
        >
          <TextInput label={t('auth.email')} type="email" value={mail.email} onChange={(e) => setMail({ ...mail, email: e.target.value })} required />
          <TextInput label={t('profile.currentPassword')} type="password" value={mail.password} onChange={(e) => setMail({ ...mail, password: e.target.value })} required />
          {msg?.where === 'mail' && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <Button variant="primary" type="submit">
            {t('profile.changeEmail')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const [view, setView] = useState<'settings' | 'guide'>('settings');
  const settings = useSettings();
  const [target, setTarget] = useState<'user' | 'device'>('user');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [json, setJson] = useState('');
  const editScope = target === 'user' ? 'user' : 'userDevice';
  const layer = target === 'user' ? settings.user : settings.device;
  const userKeys = useMemo(() => registry.all().filter((d) => d.scopes?.includes('user')), []);

  const resetAll = async () => {
    if (!confirm(t('settings.resetAllConfirm'))) return;
    for (const k of Object.keys(layer)) await resetUserSetting(k, target === 'device').catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('settings.personal.title')}</h1>
        <Button className="ml-auto" onClick={() => void logout()}>
          {t('nav.logout')}
        </Button>
      </div>
      <Tabs tabs={[{ id: 'settings', label: t('guide.tab.settings') }, { id: 'guide', label: `📖 ${t('guide.tab.guide')}` }]} value={view} onChange={setView} />
      {view === 'guide' ? (
        <Guide />
      ) : (
        <>
      <Notice>{t('settings.personal.sync')}</Notice>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        {t('settings.personal.deviceKind')}
        <select className="rounded-sm border border-line bg-surface px-2 py-1" value={deviceKindOverride()} onChange={(e) => setDeviceKindOverride(e.target.value as 'auto' | 'phone' | 'desktop')}>
          <option value="auto">{t('settings.personal.kind.auto')}</option>
          <option value="phone">{t('settings.personal.kind.phone')}</option>
          <option value="desktop">{t('settings.personal.kind.desktop')}</option>
        </select>
      </label>
      <Tabs tabs={[{ id: 'user', label: t('settings.personal.all') }, { id: 'device', label: t('settings.personal.device', { kind: t(`settings.personal.kind.${deviceId()}`) }) }]} value={target} onChange={setTarget} />
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <ThemeChooser onPick={(id) => void saveUserSetting('ui.themeId', id, target === 'device').catch((e) => setMsg({ kind: 'error', text: errorText(e) }))} current={String(settings.values['ui.themeId'])} />
      <SettingsForm
        registry={registry}
        values={settings.values}
        origins={settings.origins}
        editScope={editScope}
        onChange={(k, v: SettingValue) => void saveUserSetting(k, v, target === 'device').catch((e) => setMsg({ kind: 'error', text: errorText(e) }))}
        onReset={(k) => void resetUserSetting(k, target === 'device').catch((e) => setMsg({ kind: 'error', text: errorText(e) }))}
        issues={[]}
        allowedKeys={(d) => userKeys.some((x) => x.key === d.key)}
      />
      <SoundLibrary />
      <SettingsShare />
        </>
      )}
    </div>
  );
}

function ThemeChooser({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const { themes } = useThemes();
  return (
    <Card title={t('app.theme.choose')} actions={<Link to="/vzhled" className="rounded-md border border-line bg-surface px-3 py-1">{t('editor.open')}</Link>}>
      <div className="flex flex-wrap gap-2">
        {themes.map((th) => {
          const problems = (['light', 'dark'] as const).flatMap((m) => checkContrast(resolveTokens(th, m)));
          return (
            <Button key={th.id} variant={th.id === current ? 'primary' : 'secondary'} onClick={() => onPick(th.id)} aria-pressed={th.id === current}>
              {th.builtin ? t(th.name) : th.name}
              {problems.length > 0 ? ' ⚠' : ''}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}
