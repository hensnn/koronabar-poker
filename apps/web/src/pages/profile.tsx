import { useEffect, useMemo, useState } from 'react';
import { Link } from '../router';
import { SoundLibrary } from './sounds';
import { checkContrast, resolveTokens } from '@kb/tokens';
import { useThemes } from '../theme/ThemeProvider';
import { resolveSettings, t, usefulOnKind, type SettingValue } from '@kb/shared';
import { errorText, post } from '../api';
import { logout, useSession } from '../session';
import { deviceId, deviceKindOverride, loadKindLayers, resetForBoth, resetKindSetting, saveForBoth, saveKindSetting, setDeviceKindOverride, registry, useSettings } from '../settings';
import { SettingsForm } from '../settings/SettingsForm';
import { Button, Card, Notice, Spinner, Tabs, TextInput } from '../ui';
import { Guide } from './guide';
import { MobileOrderEditor } from '../table/MobileOrderEditor';
import { LimitsSection } from './limits';
import { useFeatures } from '../features';
import { NotesSection } from './notes';
import { TokensSection } from './tokens';
import { InstallCard } from '../pwa';
import { SettingsShare } from '../settings-share';
import { Diagnostics } from '../diagnostics';
import { LookTitle, Trophies } from '../cosmetics-client';

/** Pořadí karet v osobním nastavení: Vzhled a ovládání, E-mail, Chat, Hlasatel, Zvukové emotikony; pod formulářem pak Správa nastavení, Zvukové emotikony (knihovna) a Diagnostika. */
const PERSONAL_ORDER = ['ui', 'email', 'chat', 'announcer', 'sounds'];

export function ProfilePage() {
  const { me } = useSession();
  const features = useFeatures();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [mail, setMail] = useState({ password: '', email: '' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string; where: 'pw' | 'mail' } | null>(null);
  const notesOn = useSettings().values['ui.showPlayerNotes'] !== false;
  if (!me) return null;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('profile.title')}</h1>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <p>
            <strong>{me.user.nickname}</strong> <LookTitle userId={me.user.id} /> <Trophies userId={me.user.id} /> · {me.user.email}
            {me.roles && me.roles.length > 0 && (
              <>
                {' '}
                · <span className="text-muted">{t('profile.role')}:</span> {me.roles.join(', ')}
              </>
            )}
          </p>
          <Button className="ml-auto" onClick={() => void logout()}>
            {t('nav.logout')}
          </Button>
        </div>
        <p className="text-sm text-muted">{me.user.emailVerified ? t('profile.verified') : t('profile.unverified')}</p>
      </Card>
      {features.limits && <LimitsSection />}
      {notesOn && <NotesSection />}
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
          <input type="text" name="username" autoComplete="username" defaultValue={me.user.nickname} readOnly tabIndex={-1} aria-hidden className="sr-only" />
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
          <input type="text" name="username" autoComplete="username" defaultValue={me.user.nickname} readOnly tabIndex={-1} aria-hidden className="sr-only" />
          <TextInput label={t('profile.newEmail')} type="email" name="new-email" autoComplete="off" placeholder={me.user.email ?? ''} value={mail.email} onChange={(e) => setMail({ ...mail, email: e.target.value })} required />
          <TextInput label={t('profile.currentPassword')} type="password" autoComplete="current-password" value={mail.password} onChange={(e) => setMail({ ...mail, password: e.target.value })} required />
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
  const [view, setView] = useState<'settings' | 'guide' | 'diagnostics'>('settings');
  const settings = useSettings();
  // Oboje = společné nastavení pro telefon i počítač; Počítač a Telefon = hodnoty jen pro ten druh zařízení (i pro druhý než ten, na kterém právě jsem).
  const [target, setTarget] = useState<'both' | 'desktop' | 'phone'>('both');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const here = deviceId();
  const remote = target !== 'both' && target !== here;
  const [other, setOther] = useState<Record<string, SettingValue> | null>(null);
  useEffect(() => {
    setOther(null);
    if (!remote) return;
    let alive = true;
    loadKindLayers(target as 'phone' | 'desktop')
      .then((l) => alive && setOther(l.device))
      .catch((e) => alive && setMsg({ kind: 'error', text: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [target, remote]);
  const userKeys = useMemo(() => registry.all().filter((d) => d.scopes?.includes('user')), []);
  const remoteResolved = useMemo(() => (remote && other ? resolveSettings(registry, [{ scope: 'global', values: settings.global }, { scope: 'user', values: settings.user }, { scope: 'userDevice', values: other }]) : null), [remote, other, settings.global, settings.user]);
  const values = remote ? (remoteResolved?.values ?? {}) : settings.values;
  const origins = remote ? (remoteResolved?.origins ?? {}) : settings.origins;
  const editScope = target === 'both' ? 'user' : 'userDevice';
  const fail = (e: unknown) => setMsg({ kind: 'error', text: errorText(e) });

  const change = (k: string, v: SettingValue) => {
    if (target === 'both') return void saveForBoth(k, v).catch(fail);
    if (!remote) return void saveKindSetting(target, k, v).catch(fail);
    const before = other;
    setOther((o) => ({ ...(o ?? {}), [k]: v }));
    void saveKindSetting(target, k, v).catch((e) => {
      setOther(before);
      fail(e);
    });
  };
  const reset = (k: string) => {
    if (target === 'both') return void resetForBoth(k).catch(fail);
    if (!remote) return void resetKindSetting(target, k).catch(fail);
    const before = other;
    setOther((o) => Object.fromEntries(Object.entries(o ?? {}).filter(([x]) => x !== k)));
    void resetKindSetting(target, k).catch((e) => {
      setOther(before);
      fail(e);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('settings.personal.title')}</h1>
      </div>
      <Tabs tabs={[{ id: 'settings', label: t('guide.tab.settings') }, { id: 'guide', label: `📖 ${t('guide.tab.guide')}` }, { id: 'diagnostics', label: `🩺 ${t('guide.tab.diagnostics')}` }]} value={view} onChange={setView} />
      {view === 'diagnostics' ? (
        <Diagnostics />
      ) : view === 'guide' ? (
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
      <Tabs
        tabs={[
          { id: 'both' as const, label: t('settings.personal.tab.both') },
          { id: 'desktop' as const, label: '🖥️ ' + t('settings.personal.tab.desktop') + (here === 'desktop' ? ` ${t('settings.personal.thisDevice')}` : '') },
          { id: 'phone' as const, label: '📱 ' + t('settings.personal.tab.phone') + (here === 'phone' ? ` ${t('settings.personal.thisDevice')}` : '') },
        ]}
        value={target}
        onChange={(id) => {
          setTarget(id);
          setMsg(null);
        }}
      />
      <p className="text-sm text-muted">{t(`settings.personal.hint.${target}`)}</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {remote && !other ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <>
          {target === 'phone' && (
            <Card title={`📱 ${t('mobile.order.title')}`} foldId="nastaveni|poradi-telefon">
              <MobileOrderEditor values={values} onChange={change} />
            </Card>
          )}
          <ThemeChooser onPick={(id) => change('ui.themeId', id)} current={String(values['ui.themeId'])} />
          <SettingsForm registry={registry} values={values} origins={origins} editScope={editScope} onChange={change} onReset={reset} issues={[]} allowedKeys={(d) => userKeys.some((x) => x.key === d.key) && (target === 'both' || usefulOnKind(target, d.key))} categoryOrder={PERSONAL_ORDER} />
        </>
      )}
      <SettingsShare />
      <SoundLibrary />
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
