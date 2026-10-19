import { useEffect, useState, useMemo } from 'react';
import { t } from '@kb/shared';
import { post } from './api';
import { Link, matchPath, Redirect, useLocation } from './router';
import { can, logout, refreshSession, useSession, type Me } from './session';
import { clearSettings, loadSettings, useSettings } from './settings';
import { ThemeProvider, type ColorMode } from './theme/ThemeProvider';
import { loadThemes, resetThemes, useThemeStore } from './theme/themes-client';
import { loadNotes, resetNotes } from './notes-client';
import { useThemePreview } from './theme/preview';
import { ThemeEditorPage } from './pages/theme-editor';
import { Button, Notice, Spinner } from './ui';
import { ForgotPage, LoginPage, RegisterPage, ResetPage, TokenPage } from './pages/auth';
import { AdminRouter, isAdmin } from './pages/admin/index';
import { ShopPage } from './pages/shop';
import { ChatPage } from './pages/chat';
import { LobbyPage } from './pages/lobby';
import { ProfilePage, SettingsPage } from './pages/profile';
import { TablePage } from './pages/table';
import { WalletPage } from './pages/wallet';
import { StatsPage } from './pages/stats';
import { SoundHost } from './pages/sounds';
import { useFeatures } from './features';
import { TournamentResultHost } from './pages/tournament-result';
import { AssistantLauncher } from './pages/assistant';
import { OfflineBanner } from './pwa';
import { AnnouncerHost } from './announcer/host';
import { PollPage, PollsPage } from './pages/polls';
import { ProgressPage } from './pages/progress';
import { LevelUpToast } from './progress-client';
import { TournamentPage, TournamentsPage } from './pages/tournaments';
import { LiveCashListPage, LiveCashPage } from './pages/live';
import { TvPage } from './pages/tv';
import { EveningPage, EveningsPage } from './pages/evenings';
import { NotificationBell } from './notifications';
import { SoundMenu } from './sound-menu';
import { DashboardPage } from './pages/dashboard';
import { MainMenu, type MenuGroup, type MenuItem, type MenuTone } from './main-menu';
import { useTournamentAutoJoin } from './tournament-autojoin';
import { MyTableButton } from './my-table-button';

const PUBLIC = ['/prihlaseni', '/registrace', '/zapomenute-heslo', '/obnova-hesla', '/overit-email', '/potvrdit-email'];

export default function App() {
  const session = useSession();
  const settings = useSettings();
  useEffect(() => {
    void refreshSession();
  }, []);
  useEffect(() => {
    if (session.status === 'authenticated') {
      void loadSettings().catch(() => undefined);
      void loadThemes().catch(() => undefined);
      void loadNotes().catch(() => undefined);
    } else if (session.status === 'anonymous') {
      clearSettings();
      resetThemes();
      resetNotes();
    }
  }, [session.status]);

  // Hráč bez vlastní volby dostane výchozí motiv nastavený správcem.
  const store = useThemeStore();
  const defaultId = String(settings.values['theme.defaultId'] ?? 'classic-green');
  const themeId = settings.origins['ui.themeId'] === 'default' ? defaultId : String(settings.values['ui.themeId']);
  const preview = useThemePreview();
  const custom = useMemo(() => store.themes.map((t) => t.theme), [store.themes]);
  const colorMode = settings.values['ui.colorMode'] as ColorMode;
  return (
    <ThemeProvider themeId={themeId} fallbackId={defaultId} colorMode={colorMode} custom={custom} locked={store.locked} preview={preview.draft} previewMode={preview.mode}>
      <Router />
    </ThemeProvider>
  );
}

function Router() {
  const session = useSession();
  const { path } = useLocation();
  const isPublic = PUBLIC.some((p) => path === p);

  if (path === '/tv') return <TvPage />;
  if (session.status === 'loading') {
    return (
      <main className="p-4">
        <Spinner label={t('app.loading')} />
      </main>
    );
  }
  if (path === '/overit-email') return <TokenPage kind="verify" />;
  if (path === '/potvrdit-email') return <TokenPage kind="confirm" />;
  if (path === '/obnova-hesla') return <ResetPage />;
  if (session.status === 'anonymous') {
    if (path === '/registrace') return <RegisterPage />;
    if (path === '/zapomenute-heslo') return <ForgotPage />;
    if (path !== '/prihlaseni') return <Redirect to="/prihlaseni" />;
    return <LoginPage />;
  }
  if (isPublic && path !== '/obnova-hesla') return <Redirect to="/" />;
  return <Shell me={session.me!} />;
}

function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  const settings = useSettings();
  const blocked = me.user.status === 'blocked';
  // Vypnutý obchod (cosmetics.enabled) zmizí i z nabídky.
  const features = useFeatures();
  const shopOn = features.shop;
  // Živý cash je ve výchozím stavu schovaný (liveCash.enabled); stránka zůstává dostupná, jen není v nabídce.
  const liveOn = features.liveCash;
  const item = (to: string, key: string, show = true) => ({ to, label: t(key), show });
  const groups: MenuGroup[] = (
    [
      { id: 'play', label: t('nav.group.play'), tone: 'success', items: [item('/', 'nav.lobby'), item('/cash', 'nav.cash'), item('/turnaje', 'nav.tournaments'), item('/zivy-cash', 'nav.live', liveOn), item('/vecery', 'nav.evenings', features.evenings)] },
      { id: 'community', label: t('nav.group.community'), tone: 'info', items: [item('/chat', 'nav.chat', features.chat && (can(me, 'chat.psat') || can(me, 'prihlizet.zobrazit'))), item('/ankety', 'nav.polls', features.polls)] },
      { id: 'mine', label: t('nav.group.mine'), tone: 'warning', items: [item('/penezenka', 'nav.wallet'), item('/statistiky', 'nav.stats'), item('/postup', 'nav.progress', features.xp), item('/obchod', 'nav.shop', shopOn)] },
      { id: 'account', label: t('nav.group.account'), tone: 'accent', items: [item('/nastaveni', 'nav.settings'), item('/profil', 'nav.profile'), item('/admin', 'nav.admin', isAdmin(me))] },
    ] as { id: string; label: string; tone: MenuTone; items: (MenuItem & { show: boolean })[] }[]
  )
    .map((g) => ({ ...g, items: g.items.filter((i) => i.show).map(({ to, label }) => ({ to, label })) }))
    .filter((g) => g.items.length > 0);
  // Na telefonu je hlavní nabídka sbalená pod tlačítkem; po přechodu na jinou stránku se zavře.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  useTournamentAutoJoin();
  const stul = matchPath('/stul/:id', path);
  const turnaj = matchPath('/turnaj/:id', path);
  const anketa = matchPath('/ankety/:id', path);
  const zivyCash = matchPath('/zivy-cash/:id', path);
  const vecer = matchPath('/vecery/:id', path);

  const isActive = (to: string) => (to === '/' ? path === '/' : to === '/turnaje' ? path.startsWith('/turnaj') : path.startsWith(to));

  let page;
  if (blocked) page = <BlockedPage me={me} />;
  else if (stul) page = <TablePage tableId={stul.id!} />;
  else if (turnaj) page = <TournamentPage id={turnaj.id!} />;
  else if (path === '/turnaje') page = <TournamentsPage />;
  else if (vecer) page = <EveningPage id={vecer.id!} />;
  else if (path === '/vecery') page = <EveningsPage />;
  else if (zivyCash) page = <LiveCashPage id={zivyCash.id!} />;
  else if (path === '/zivy-cash') page = <LiveCashListPage />;
  else if (path === '/') page = <DashboardPage />;
  else if (path === '/cash') page = <LobbyPage />;
  else if (path === '/chat') page = <ChatPage />;
  else if (path === '/penezenka') page = <WalletPage />;
  else if (path === '/statistiky') page = <StatsPage />;
  else if (path === '/postup') page = <ProgressPage />;
  else if (path === '/obchod') page = <ShopPage />;
  else if (path === '/vzhled') page = <ThemeEditorPage />;
  else if (anketa) page = <PollPage id={anketa.id!} />;
  else if (path === '/ankety') page = <PollsPage />;
  else if (path === '/nastaveni') page = <SettingsPage />;
  else if (path === '/profil') page = <ProfilePage />;
  else if (path.startsWith('/admin')) page = <AdminRouter />;
  else page = <Redirect to="/" />;
  // Vypnutá funkce nemá mít přístupnou ani adresu.
  const off = (prefix: string, on: boolean) => !on && (path === prefix || path.startsWith(prefix + '/'));
  if (off('/ankety', features.polls) || off('/chat', features.chat) || off('/vecery', features.evenings) || off('/postup', features.xp) || off('/obchod', features.shop)) page = <Redirect to="/" />;

  return (
    <div className={`mx-auto flex min-h-screen flex-col gap-3 p-3 ${stul ? "max-w-none" : "max-w-5xl"}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/" className="font-heading text-2xl font-bold">
          {t('app.name')}
        </Link>
        <nav aria-label={t('nav.main')} className="flex flex-wrap items-center gap-2">
          <button className="rounded-md border border-line bg-surface px-3 py-1 md:hidden" aria-expanded={menuOpen} aria-controls="hlavni-nabidka" onClick={() => setMenuOpen((v) => !v)}>
            ☰ {t('nav.menu')}
          </button>
          <div id="hlavni-nabidka" className={`${menuOpen ? 'flex' : 'hidden'} w-full flex-wrap gap-2 md:order-first md:flex md:w-auto`}>
            <MainMenu groups={groups} isActive={isActive} path={path} />
          </div>
          <MyTableButton path={path} />
          <NotificationBell />
          <SoundMenu />
          <SoundHost />
          <AnnouncerHost />
          <span className="rounded-md bg-raised px-3 py-1 font-mono" title={t('nav.balance')}>
            {me.balance} {String(settings.values['economy.currencySymbol'] ?? '')}
          </span>
          <Button onClick={() => void logout()}>{t('nav.logout')}</Button>
        </nav>
      </header>
      {/* Okna a hlášky mimo hlavičku: na celé obrazovce u stolu je hlavička schovaná, ale souhrn turnaje a oznámení musí být vidět. */}
      <TournamentResultHost />
      {features.xp && <LevelUpToast />}
      <OfflineBanner />
      {!me.user.emailVerified && !blocked && <VerifyBanner />}
      <main className="flex-1">{page}</main>
      <footer className="border-t border-line pt-3 text-sm text-muted">{t('footer.virtualCurrency')}</footer>
      {!blocked && features.assistant && <AssistantLauncher />}
    </div>
  );
}

function VerifyBanner() {
  const [sent, setSent] = useState(false);
  return (
    <Notice>
      {t('auth.verify.banner')}{' '}
      {sent ? (
        t('auth.verify.sent')
      ) : (
        <button
          className="underline"
          onClick={async () => {
            await post('/api/auth/resend-verification').catch(() => undefined);
            setSent(true);
          }}
        >
          {t('auth.verify.resend')}
        </button>
      )}
    </Notice>
  );
}

function BlockedPage({ me }: { me: Me }) {
  return (
    <div className="mx-auto max-w-lg">
      <Notice kind="error">
        <strong>{t('blocked.title')}</strong>
        <br />
        {t('blocked.reason')}: {me.user.blockedReason}
        <br />
        {me.user.blockedUntil ? t('blocked.until', { date: new Date(me.user.blockedUntil).toLocaleString('cs-CZ') }) : t('blocked.permanent')}
      </Notice>
    </div>
  );
}
